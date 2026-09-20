import { shape } from '../lib/shape.js';
import { nowIso } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { can } from '../auth/capabilities.js';
import { DEFAULT_SLA_HOURS, FAULT_STATUSES, SEVERITIES, STATUS_META as STATUS_META2 } from './fault.service.js';
import { EQUIPMENT_STATUSES, STATUS_META, CRITICALITIES } from './equipment.status.js';

/**
 * Reference data: equipment categories, locations, fault categories and departmental
 * settings (§2 "Configure equipment categories and locations").
 *
 * Deletion is refused wherever records exist.  Configuration rows are the *context* of a
 * historical record, so renaming is fine but removing them would silently orphan history.
 */

const TABLES = {
  category: {
    table: 'equipment_categories',
    label: 'equipment category',
    usageCheck: (db, id) => db.get('SELECT COUNT(*) AS n, MIN(asset_tag) AS sample FROM equipment WHERE category_id = ?', [id]),
    columns: { code: 'code', name: 'name', description: 'description' },
  },
  location: {
    table: 'locations',
    label: 'location',
    usageCheck: (db, id) => db.get('SELECT COUNT(*) AS n, MIN(name) AS sample FROM equipment WHERE location_id = ?', [id]),
    columns: { code: 'code', name: 'name', building: 'building', floor: 'floor', room: 'room' },
  },
  faultCategory: {
    table: 'fault_categories',
    label: 'fault category',
    usageCheck: (db, id) => db.get('SELECT COUNT(*) AS n, MIN(reference) AS sample FROM fault_reports WHERE category_id = ?', [id]),
    columns: { code: 'code', name: 'name', description: 'description', defaultSeverity: 'default_severity' },
  },
};

function assertManager(user, action = 'modify') {
  if (!can(user, 'meta.manage')) {
    throw forbidden(`Only an administrator may ${action} reference data (categories, locations, fault types, settings)`);
  }
}

export function listReference(db, kind, { includeInactive = true, q = '' } = {}) {
  const meta = TABLES[kind];
  if (!meta) throw badRequest(`Unknown reference table: ${kind}`);
  const usageExpr = kind === 'category'
    ? '(SELECT COUNT(*) FROM equipment e WHERE e.category_id = t.id AND e.is_active = 1)'
    : kind === 'location'
      ? '(SELECT COUNT(*) FROM equipment e WHERE e.location_id = t.id AND e.is_active = 1)'
      : '(SELECT COUNT(*) FROM fault_reports f WHERE f.category_id = t.id)';
  const openExpr = kind === 'faultCategory'
    ? "(SELECT COUNT(*) FROM fault_reports f WHERE f.category_id = t.id AND f.status NOT IN ('repaired','verified','closed'))"
    : '0';
  const rows = db.all(
    `SELECT t.*, ${usageExpr} AS usage_count, ${openExpr} AS open_count
       FROM ${meta.table} t
      WHERE ${includeInactive ? '1 = 1' : 't.is_active = 1'}
        AND (? = '' OR t.name LIKE ? OR t.code LIKE ?)
      ORDER BY t.name`,
    [q, `%${q}%`, `%${q}%`],
  );
  return rows.map((r) => shape(r));
}

export function upsertReference(db, kind, data, actor, req) {
  assertManager(actor, data.id ? 'edit' : 'create');
  const meta = TABLES[kind];
  if (!meta) throw badRequest(`Unknown reference table: ${kind}`);
  const code = String(data.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const name = String(data.name ?? '').trim();
  if (!code || code.length > 12) throw badRequest('Code must be 1–12 characters of A–Z, 0–9, - or _', { fields: { code: ['Invalid'] } });
  if (!name || name.length > 120) throw badRequest('Name is required (max 120 characters)', { fields: { name: ['Invalid'] } });

  const clash = data.id
    ? db.get(`SELECT id FROM ${meta.table} WHERE code = ? AND id <> ?`, [code, data.id])
    : db.get(`SELECT id FROM ${meta.table} WHERE code = ?`, [code]);
  if (clash) throw conflict(`Code ${code} is already used by another ${meta.label}`);

  return db.tx(() => {
    if (data.id) {
      const existing = db.get(`SELECT * FROM ${meta.table} WHERE id = ?`, [data.id]);
      if (!existing) throw notFound(`${meta.label} not found`);
      const sets = [];
      const params = [];
      for (const [field, column] of Object.entries(meta.columns)) {
        if (data[field] === undefined) continue;
        sets.push(`${column} = ?`);
        params.push(field === 'defaultSeverity' ? String(data[field]).toLowerCase() : data[field]);
      }
      if (data.isActive !== undefined) { sets.push('is_active = ?'); params.push(data.isActive ? 1 : 0); }
      if (sets.length) db.run(`UPDATE ${meta.table} SET ${sets.join(', ')} WHERE id = ?`, [...params, data.id]);
      audit({ actor, action: `${kind}.update`, entityType: meta.table, entityId: data.id, entityRef: code,
        summary: `Updated ${meta.label} ${name}`, req });
      return shape(db.get(`SELECT * FROM ${meta.table} WHERE id = ?`, [data.id]));
    }
    const extra = kind === 'faultCategory'
      ? { default_severity: ['low', 'medium', 'high', 'critical'].includes(String(data.defaultSeverity).toLowerCase()) ? String(data.defaultSeverity).toLowerCase() : 'medium' }
      : {};
    const values = { ...Object.fromEntries(Object.keys(meta.columns).map((k) => [k, data[k] ?? null])), ...extra };
    values.code = code;
    values.name = name;
    if (kind === 'location') { values.building = data.building ?? null; values.floor = data.floor ?? null; values.room = data.room ?? null; }
    const columns = [...Object.keys(values), 'is_active', 'created_at'];
    const params = [...Object.values(values), 1, nowIso()];
    const { lastInsertRowid } = db.run(
      `INSERT INTO ${meta.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      params,
    );
    audit({ actor, action: `${kind}.create`, entityType: meta.table, entityId: lastInsertRowid, entityRef: code,
      summary: `Created ${meta.label} ${name}`, after: values, req });
    return shape(db.get(`SELECT * FROM ${meta.table} WHERE id = ?`, [lastInsertRowid]));
  });
}

export function deleteReference(db, kind, id, { force = false }, actor, req) {
  assertManager(actor, 'delete');
  const meta = TABLES[kind];
  const row = db.get(`SELECT * FROM ${meta.table} WHERE id = ?`, [id]);
  if (!row) throw notFound(`${meta.label} not found`);
  const usage = meta.usageCheck(db, id);
  if ((usage?.n ?? 0) > 0) {
    if (!force) {
      throw conflict(
        `${row.name ?? row.code} is used by ${usage.n} record(s) (e.g. ${usage.sample}). Deactivate it, or delete with force=true if you have verified nothing depends on it.`,
        { inUse: usage.n, sample: usage.sample, hint: 'Deactivate is usually the correct action' },
      );
    }
    throw conflict(`${row.name ?? row.code} still has ${usage.n} dependent record(s) and cannot be deleted — the database enforces this too.`);
  }
  return db.tx(() => {
    db.run(`DELETE FROM ${meta.table} WHERE id = ?`, [id]);
    audit({ actor, action: `${kind}.delete`, entityType: meta.table, entityId: id, entityRef: row.code,
      summary: `Deleted unused ${meta.label} ${row.name ?? row.code}`, before: row, req });
    return { deleted: true };
  });
}

/* ------------------------------------------------------------------ settings -- */

const SETTING_DEFS = {
  department_name: { type: 'string', label: 'Department name', description: 'Printed on reports and labels' },
  institution_name: { type: 'string', label: 'Institution', description: 'School / faculty shown in the header' },
  report_footer: { type: 'string', label: 'Report footer', description: 'e.g. contact details or a safety reminder' },
  currency: { type: 'string', label: 'Currency', description: 'ISO 4217 code used for repair costs' },
  sla_hours: { type: 'json', label: 'Response targets (hours)', description: 'Target response time per severity: critical/high/medium/low',
    validate: (v) => {
      const obj = typeof v === 'string' ? JSON.parse(v) : v;
      for (const k of Object.keys(DEFAULT_SLA_HOURS)) {
        const n = Number(obj?.[k]);
        if (!Number.isFinite(n) || n < 1 || n > 24 * 60) throw badRequest(`sla_hours.${k} must be 1–1440`);
      }
      return JSON.stringify(Object.fromEntries(Object.keys(DEFAULT_SLA_HOURS).map((k) => [k, Number(obj[k])])));
    } },
  due_soon_days: { type: 'int', label: '“Due soon” window (days)', validate: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 120) throw badRequest('due_soon_days must be 1–120'); return String(n); } },
  maintenance_reminder_days: { type: 'int', label: 'Maintenance reminder lead time (days)', validate: (v) => String(Math.max(1, Number(v) || 7)) },
  qr_label_include_location: { type: 'bool', label: 'Print location on QR labels' },
  require_verification_before_close: { type: 'bool', label: 'Require verification before closing a fault', description: 'Keep enabled unless the department has a different sign-off process' },
};

export const settingDefinitions = () => SETTING_DEFS;

export function getSettings(db) {
  const rows = db.all('SELECT key, value, value_type, description, updated_at FROM app_settings');
  const stored = new Map(rows.map((r) => [r.key, r]));
  const out = {};
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    const row = stored.get(key);
    let value = row?.value ?? null;
    if (def.type === 'int') value = value === null ? null : Number(value);
    if (def.type === 'bool') value = value === '1';
    if (def.type === 'json') { try { value = value ? JSON.parse(value) : null; } catch { value = null; } }
    out[key] = { value, type: def.type, label: def.label, description: def.description ?? null, updatedAt: row?.updated_at ?? null };
  }
  out.sla_hours.value = { ...DEFAULT_SLA_HOURS, ...(out.sla_hours.value ?? {}) };
  return out;
}

export function updateSettings(db, patch, actor, req) {
  assertManager(actor, 'change');
  const keys = Object.keys(patch);
  if (!keys.length) throw badRequest('Nothing to update');
  return db.tx(() => {
    for (const key of keys) {
      const def = SETTING_DEFS[key];
      if (!def) throw badRequest(`Unknown setting “${key}”. Edit the settings list to add one.`, { fields: { [key]: ['Unknown'] } });
      let value = patch[key];
      if (def.validate) value = def.validate(value);
      else if (def.type === 'bool') value = value ? '1' : '0';
      else if (def.type === 'json') value = typeof value === 'string' ? value : JSON.stringify(value);
      else if (def.type === 'int') value = String(value);
      else value = String(value ?? '');
      if (def.type === 'string' && value.length > 400) throw badRequest(`${def.label} is too long`, { fields: { [key]: ['Max 400 characters'] } });
      db.run(
        `INSERT INTO app_settings (key, value, value_type, description, updated_at, updated_by)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [key, value, def.type, def.description ?? null, nowIso(), actor.id],
      );
    }
    audit({ actor, action: 'settings.update', entityType: 'app_settings', entityId: null,
      summary: `Changed: ${keys.join(', ')}`, after: patch, req });
    return getSettings(db);
  });
}

/** Options that selectors need, sized for a phone screen. */
export function picklists(db) {
  return shape({
    categories: db.all(`SELECT id, code, name FROM equipment_categories WHERE is_active = 1 ORDER BY name`),
    locations: db.all(`SELECT id, code, name, building, room FROM locations WHERE is_active = 1 ORDER BY name`),
    faultCategories: db.all(`SELECT id, code, name, default_severity FROM fault_categories WHERE is_active = 1 ORDER BY name`),
    technicians: db.all(
      `SELECT u.id, u.full_name, u.job_title, r.code AS role,
              (SELECT COUNT(*) FROM fault_reports f WHERE f.assigned_to = u.id AND f.status NOT IN ('repaired','verified','closed')) AS open_faults
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.is_active = 1 AND r.code IN ('technician','admin') ORDER BY u.full_name`,
    ),
    custodians: db.all(`SELECT id, full_name FROM users WHERE is_active = 1 ORDER BY full_name LIMIT 400`),
    equipmentStatuses: EQUIPMENT_STATUSES.map((value) => ({ value, label: STATUS_META[value].label, tone: STATUS_META[value].tone })),
    faultStatuses: FAULT_STATUSES.map((value) => ({ value, label: STATUS_META2[value]?.label ?? value })),
    severities: SEVERITIES.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
    criticalities: CRITICALITIES.map((value) => ({ value, label: value.replace('_', ' ') })),
  });
}
