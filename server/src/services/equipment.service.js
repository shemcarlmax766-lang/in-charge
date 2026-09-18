import { createHash } from 'node:crypto';
import { nextSequence } from '../lib/db.js';
import { shape } from '../lib/shape.js';
import { nowIso, todayDateOnly, toDateOnly, addDays, minutesBetween, parseDate } from '../lib/time.js';
import { assetTag as makeAssetTag } from '../lib/tokens.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { store, removeStored, sniff, sanitizeFilename, extensionOf } from '../lib/files.js';
import { can } from '../auth/capabilities.js';
import { assessRisk } from './risk.service.js';
import { computeDowntime } from './downtime.service.js';
import {
  EQUIPMENT_STATUSES, STATUS_META, CRITICALITIES, UNAVAILABLE_STATUSES,
  OPEN_FAULT_STATUSES, FAULT_TO_EQUIPMENT_STATUS, statusLabel, PM_DUE_SOON_DAYS,
} from './equipment.status.js';

/* ------------------------------------------------------------------ imports of
 * shared vocabulary — see equipment.status.js for the single source of truth.        */

export { EQUIPMENT_STATUSES, STATUS_META, CRITICALITIES, UNAVAILABLE_STATUSES,
  OPEN_FAULT_STATUSES, statusLabel, PM_DUE_SOON_DAYS };

/* ------------------------------------------------------------------- SQL ---- */

const COLUMNS = `e.*,
  cat.code AS category_code, cat.name AS category_name,
  l.name AS location_name, l.building, l.floor, l.room,
  cu.full_name AS custodian_name,
  rt.full_name AS responsible_technician_name,
  (SELECT COUNT(*) FROM fault_reports f WHERE f.equipment_id = e.id) AS total_faults,
  (SELECT COUNT(*) FROM fault_reports f WHERE f.equipment_id = e.id
     AND f.status IN (${quote(OPEN_FAULT_STATUSES)})) AS open_fault_count,
  (SELECT COUNT(*) FROM fault_reports f WHERE f.equipment_id = e.id
     AND f.status IN (${quote(OPEN_FAULT_STATUSES)}) AND f.severity = 'critical') AS critical_fault_count,
  (SELECT MAX(f.created_at) FROM fault_reports f WHERE f.equipment_id = e.id) AS last_fault_at,
  (SELECT f2.reference FROM fault_reports f2 WHERE f2.equipment_id = e.id
     AND f2.status IN (${quote(OPEN_FAULT_STATUSES)})
     ORDER BY datetime(f2.created_at) DESC LIMIT 1) AS open_fault_reference,
  (SELECT COUNT(*) FROM maintenance_records m WHERE m.equipment_id = e.id) AS pm_record_count,
  (SELECT COALESCE(SUM(r.total_cost), 0) FROM repair_records r WHERE r.equipment_id = e.id) AS lifetime_repair_cost,
  (SELECT COUNT(*) FROM repair_records r WHERE r.equipment_id = e.id) AS repair_count`;

function quote(list) {
  return list.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
}

const MAINTENANCE_STATE_EXPR = `CASE
    WHEN e.next_maintenance_on IS NULL THEN 'not_scheduled'
    WHEN date(e.next_maintenance_on) < date('now') THEN 'overdue'
    WHEN julianday(e.next_maintenance_on) - julianday('now') <= ${PM_DUE_SOON_DAYS} THEN 'due_soon'
    ELSE 'up_to_date'
  END`;

const FROM = `FROM equipment e
  LEFT JOIN equipment_categories cat ON cat.id = e.category_id
  LEFT JOIN locations l ON l.id = e.location_id
  LEFT JOIN users cu ON cu.id = e.custodian_user_id
  LEFT JOIN users rt ON rt.id = e.responsible_technician_id`;

const SORTABLE = new Map([
  ['name', 'e.name'],
  ['assetTag', 'e.asset_tag'],
  ['createdAt', 'e.created_at'],
  ['status', "CASE e.status WHEN 'operational' THEN 1 WHEN 'reported_fault' THEN 2 WHEN 'under_inspection' THEN 3 WHEN 'under_repair' THEN 4 WHEN 'awaiting_parts' THEN 5 WHEN 'out_of_service' THEN 6 ELSE 7 END"],
  ['criticality', "CASE e.criticality WHEN 'life_support' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END"],
  ['nextMaintenanceOn', 'e.next_maintenance_on'],
  ['lastMaintenanceOn', 'e.last_maintenance_on'],
  ['totalFaults', 'total_faults'],
  ['maintenanceState', 'maintenance_state'],
  ['manufacturer', 'e.manufacturer'],
  ['location', 'location_name'],
]);

/** Filters shared by the page query and the COUNT query, so totals can never disagree. */
function buildWhere(f) {
  const where = [];
  const params = [];
  if (f.q) {
    const like = `%${f.q}%`;
    where.push(`(e.asset_tag LIKE ? OR e.name LIKE ? OR e.serial_number LIKE ? OR e.manufacturer LIKE ?
      OR e.model LIKE ? OR IFNULL(l.name,'') LIKE ? OR IFNULL(cat.name,'') LIKE ?
      OR e.department LIKE ? OR CAST(e.id AS TEXT) = ?)`);
    params.push(like, like, like, like, like, like, like, like, String(f.q).trim());
  }
  if (f.status) { where.push('e.status = ?'); params.push(f.status); }
  if (f.categoryId) { where.push('e.category_id = ?'); params.push(f.categoryId); }
  if (f.locationId) { where.push('e.location_id = ?'); params.push(f.locationId); }
  if (f.criticality) { where.push('e.criticality = ?'); params.push(f.criticality); }
  if (f.technicianId) { where.push('e.responsible_technician_id = ?'); params.push(f.technicianId); }
  if (f.custodianId) { where.push('e.custodian_user_id = ?'); params.push(f.custodianId); }
  if (f.hasOpenFaults) where.push(`(SELECT COUNT(*) FROM fault_reports fx WHERE fx.equipment_id = e.id AND fx.status IN (${quote(OPEN_FAULT_STATUSES)})) > 0`);
  if (f.needsAttention) where.push(`(e.status <> 'operational' OR ${MAINTENANCE_STATE_EXPR} IN ('overdue','due_soon'))`);
  if (f.maintenanceState) {
    if (f.maintenanceState === 'overdue') where.push("e.next_maintenance_on IS NOT NULL AND date(e.next_maintenance_on) < date('now')");
    else if (f.maintenanceState === 'due_soon') where.push(`e.next_maintenance_on IS NOT NULL AND date(e.next_maintenance_on) >= date('now') AND julianday(e.next_maintenance_on) - julianday('now') <= ${PM_DUE_SOON_DAYS}`);
    else if (f.maintenanceState === 'up_to_date') where.push(`e.next_maintenance_on IS NOT NULL AND julianday(e.next_maintenance_on) - julianday('now') > ${PM_DUE_SOON_DAYS}`);
    else if (f.maintenanceState === 'not_scheduled') where.push('e.next_maintenance_on IS NULL');
  }
  where.push(f.showInactive ? '1 = 1' : 'e.is_active = 1');
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/* --------------------------------------------------------------------- list --- */

export function listEquipment(db, filters = {}) {
  const { sql: whereSql, params } = buildWhere(filters);
  const sortKey = SORTABLE.get(filters.sort) ?? 'e.name';
  const dir = filters.dir === 'desc' ? 'DESC' : 'ASC';
  const per = Math.min(100, Math.max(1, filters.perPage ?? 25));
  const page = Math.max(1, filters.page ?? 1);

  const total = db.value(`SELECT COUNT(*) ${FROM} ${whereSql}`, params) ?? 0;
  const rows = db.all(
    `SELECT ${COLUMNS}, ${MAINTENANCE_STATE_EXPR} AS maintenance_state,
            CASE WHEN e.next_maintenance_on IS NULL THEN NULL
                 ELSE CAST(julianday(e.next_maintenance_on) - julianday('now') AS INTEGER) END AS days_until_pm,
            CASE WHEN e.acquired_on IS NULL THEN NULL
                 ELSE CAST((julianday('now') - julianday(e.acquired_on)) / 365.25 AS INTEGER) END AS age_years
       ${FROM} ${whereSql}
      ORDER BY ${sortKey} ${dir}, e.id ASC
      LIMIT ? OFFSET ?`,
    [...params, per, (page - 1) * per],
  );
  return {
    rows: rows.map(decorate),
    pagination: { page, perPage: per, total, pages: Math.max(1, Math.ceil(total / per)) },
  };
}

function decorate(row) {
  const meta = STATUS_META[row.status] ?? {};
  return shape({
    ...row,
    status_label: meta.label ?? row.status,
    status_tone: meta.tone ?? 'neutral',
    is_available: meta.available ?? false,
    location_label: row.location_name
      ? [row.location_name, row.room && `Rm ${row.room}`, row.building && row.building].filter(Boolean).join(' · ')
      : null,
  });
}

export const findEquipment = (db, id) => {
  const row = db.get(`SELECT ${COLUMNS}, ${MAINTENANCE_STATE_EXPR} AS maintenance_state ${FROM} WHERE e.id = ?`, [id]);
  return row ? decorate(row) : null;
};

/** Accepts a numeric id or an asset tag (the QR payload). */
export function resolveEquipment(db, idOrTag) {
  const s = String(idOrTag).trim();
  const row = /^\d+$/.test(s)
    ? db.get(`SELECT ${COLUMNS}, ${MAINTENANCE_STATE_EXPR} AS maintenance_state ${FROM} WHERE e.id = ?`, [Number(s)])
    : db.get(`SELECT ${COLUMNS}, ${MAINTENANCE_STATE_EXPR} AS maintenance_state ${FROM} WHERE UPPER(e.asset_tag) = UPPER(?)`, [s]);
  if (!row) throw notFound(`No equipment found for “${s}”`);
  return decorate(row);
}

/* ------------------------------------------------------------------- detail --- */

export function equipmentDetail(db, idOrTag, user, { baseUrl = '', includeRisk = true } = {}) {
  const equipment = resolveEquipment(db, idOrTag);
  const detailed = can(user, 'equipment.view.all');

  const faults = db.all(
    `SELECT f.id, f.reference, f.title, f.severity, f.status, f.created_at, f.due_at, f.assigned_at,
            f.repaired_at, f.closed_at, fc.name AS category_name,
            ru.full_name AS assigned_to_name, rep.full_name AS reported_by_name
       FROM fault_reports f
       LEFT JOIN fault_categories fc ON fc.id = f.category_id
       LEFT JOIN users ru ON ru.id = f.assigned_to
       LEFT JOIN users rep ON rep.id = f.reported_by
      WHERE f.equipment_id = ?
      ORDER BY datetime(f.created_at) DESC
      LIMIT 40`,
    [equipment.id],
  );

  const repairs = db.all(
    `SELECT r.id, r.reference, r.diagnosis, r.root_cause, r.date_repaired, r.total_cost, r.currency,
            r.calibration_performed, r.safe_to_return_to_service, u.full_name AS technician_name,
            f.reference AS fault_reference
       FROM repair_records r
       LEFT JOIN users u ON u.id = r.technician_id
       LEFT JOIN fault_reports f ON f.id = r.fault_id
      WHERE r.equipment_id = ?
      ORDER BY r.date_repaired DESC, r.id DESC
      LIMIT 20`,
    [equipment.id],
  );
  const repairParts = repairs.length
    ? db.all(
        `SELECT p.repair_id, p.part_name, p.part_number, p.quantity, p.unit_cost, p.line_cost
           FROM repair_parts p WHERE p.repair_id IN (${repairs.map(() => '?').join(',')})`,
        repairs.map((r) => r.id),
      )
    : [];
  for (const r of repairs) r.parts = repairParts.filter((p) => p.repair_id === r.id);

  const maintenance = db.all(
    `SELECT m.id, m.reference, m.performed_on, m.findings, m.actions_taken, m.condition_found,
            m.next_due_on, m.duration_minutes, u.full_name AS performed_by_name
       FROM maintenance_records m LEFT JOIN users u ON u.id = m.performed_by
      WHERE m.equipment_id = ? ORDER BY m.performed_on DESC, m.id DESC LIMIT 20`,
    [equipment.id],
  );

  const schedules = db.all(
    `SELECT s.id, s.title, s.interval_days, s.next_due_on, s.last_done_on, s.is_active,
            u.full_name AS responsible_technician_name,
            ${MAINTENANCE_STATE_EXPR.replace(/e\.next_maintenance_on/g, 's.next_due_on')} AS maintenance_state,
            (SELECT COUNT(*) FROM maintenance_checklist_items i WHERE i.schedule_id = s.id) AS checklist_count
       FROM maintenance_schedules s LEFT JOIN users u ON u.id = s.responsible_technician_id
      WHERE s.equipment_id = ? AND s.is_active = 1 ORDER BY s.next_due_on`,
    [equipment.id],
  );

  const statusHistory = db.all(
    `SELECT h.from_status, h.to_status, h.reason, h.changed_at, u.full_name AS changed_by_name,
            h.fault_id, f.reference AS fault_reference
       FROM equipment_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       LEFT JOIN fault_reports f ON f.id = h.fault_id
      WHERE h.equipment_id = ? ORDER BY datetime(h.changed_at) DESC, h.id DESC LIMIT 30`,
    [equipment.id],
  );

  const attachments = db.all(
    `SELECT a.id, a.kind, a.filename, a.mime_type, a.size_bytes, a.caption, a.created_at,
            u.full_name AS uploaded_by_name
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.owner_type = 'equipment' AND a.owner_id = ? AND a.is_deleted = 0
      ORDER BY datetime(a.created_at) DESC`,
    [equipment.id],
  );

  const downtime = computeDowntime(db, equipment.id);

  const out = {
    equipment,
    faults: shape(faults),
    openFaults: shape(faults.filter((f) => OPEN_FAULT_STATUSES.includes(f.status))),
    repairs: detailed ? shape(repairs) : [],
    maintenance: detailed ? shape(maintenance) : [],
    schedules: shape(schedules),
    statusHistory: shape(statusHistory),
    attachments: shape(attachments),
    downtime: detailed ? shape(downtime) : null,
    statistics: {
      totalFaults: equipment.totalFaults,
      openFaults: equipment.openFaultCount,
      repairs: equipment.repairCount,
      lifetimeRepairCost: detailed ? equipment.lifetimeRepairCost : null,
      averageRepairHours: db.value(
        `SELECT ROUND(AVG((julianday(f.repaired_at) - julianday(f.created_at)) * 24), 1)
           FROM fault_reports f WHERE f.equipment_id = ? AND f.repaired_at IS NOT NULL`,
        [equipment.id],
      ) ?? null,
      unavailableDaysLast180: downtime.minutes180 ? Math.round(downtime.minutes180 / 1440) : 0,
    },
    risk: includeRisk ? assessRisk(db, equipment.id) : null,
    permissions: {
      canEdit: can(user, 'equipment.update'),
      canReport: !!user,
      canSetStatus: can(user, 'equipment.status.set'),
      canConfigureMaintenance: can(user, 'equipment.maintenance.configure'),
      canDelete: can(user, 'equipment.delete'),
    },
  };

  if (baseUrl) {
    out.qr = { assetTag: equipment.assetTag, url: `${baseUrl}/e/${encodeURIComponent(equipment.assetTag)}` };
  }
  // Reporters do not see internal cost or repair-provenance detail.
  if (!detailed) {
    delete out.repairs;
    out.maintenance = [];
    out.equipment = { ...equipment, notes: null, serialNumber: null, warrantyProvider: null };
  }
  return out;
}

/* ------------------------------------------------------------------ create -- */

const FIELD_TO_COLUMN = {
  name: 'name', categoryId: 'category_id', manufacturer: 'manufacturer', model: 'model',
  serialNumber: 'serial_number', department: 'department', locationId: 'location_id',
  custodianUserId: 'custodian_user_id', custodianNote: 'custodian_note',
  acquiredOn: 'acquired_on', warrantyProvider: 'warranty_provider',
  warrantyExpiresOn: 'warranty_expires_on', criticality: 'criticality', notes: 'notes',
  maintenanceIntervalDays: 'maintenance_interval_days',
  lastMaintenanceOn: 'last_maintenance_on', nextMaintenanceOn: 'next_maintenance_on',
  responsibleTechnicianId: 'responsible_technician_id', status: 'status',
};

function assertReferences(db, data) {
  if (data.categoryId) {
    const cat = db.get('SELECT id, code, is_active FROM equipment_categories WHERE id = ?', [data.categoryId]);
    if (!cat) throw badRequest('Unknown equipment category', { fields: { categoryId: ['No such category'] } });
    if (!cat.is_active) throw badRequest('That category is deactivated; pick an active one or reactivate it');
  }
  if (data.locationId) {
    const loc = db.get('SELECT id FROM locations WHERE id = ?', [data.locationId]);
    if (!loc) throw badRequest('Unknown location', { fields: { locationId: ['No such location'] } });
  }
  for (const [field, label] of [['custodianUserId', 'custodian'], ['responsibleTechnicianId', 'responsible technician']]) {
    if (!data[field]) continue;
    const u = db.get('SELECT id, is_active FROM users WHERE id = ?', [data[field]]);
    if (!u) throw badRequest(`Unknown ${label}`, { fields: { [field]: ['No such user'] } });
    if (!u.is_active) throw badRequest(`The selected ${label} account is deactivated`);
  }
  if (data.responsibleTechnicianId) {
    const isTech = db.value(
      `SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      [data.responsibleTechnicianId],
    );
    if (!['technician', 'admin'].includes(isTech)) {
      throw badRequest('A responsible technician must hold the technician or administrator role', {
        fields: { responsibleTechnicianId: ['Wrong role'] },
      });
    }
  }
  if (data.serialNumber) {
    const clash = db.get('SELECT id, asset_tag FROM equipment WHERE serial_number = ? AND id IS NOT ?', [data.serialNumber, data.id ?? null]);
    if (clash) throw conflict(`Serial number already used by ${clash.asset_tag}`, { fields: { serialNumber: ['Must be unique'] } });
  }
  if (data.warrantyExpiresOn && data.acquiredOn && data.warrantyExpiresOn < data.acquiredOn) {
    throw badRequest('Warranty cannot expire before the equipment was acquired', {
      fields: { warrantyExpiresOn: ['After the acquisition date'] },
    });
  }
}

/** PM dates are derived, so an interval can never exist without a due date. */
export function deriveNextMaintenance({ intervalDays, lastMaintenanceOn, nextMaintenanceOn }, today = todayDateOnly()) {
  if (nextMaintenanceOn) return nextMaintenanceOn;
  if (intervalDays && lastMaintenanceOn) return toDateOnly(addDays(lastMaintenanceOn, intervalDays));
  if (intervalDays) return toDateOnly(addDays(today, intervalDays));
  return null;
}

export function createEquipment(db, data, actor, req) {
  assertReferences(db, data);
  const category = db.get('SELECT code FROM equipment_categories WHERE id = ?', [data.categoryId]);

  return db.tx(() => {
    const seq = nextSequence(db, `asset:${category.code}`);
    const tag = makeAssetTag(category.code, seq);
    const next = deriveNextMaintenance({
      intervalDays: data.maintenanceIntervalDays ?? null,
      lastMaintenanceOn: data.lastMaintenanceOn ?? null,
      nextMaintenanceOn: data.nextMaintenanceOn ?? null,
    });
    const created = nowIso();
    const { lastInsertRowid } = db.run(
      `INSERT INTO equipment (asset_tag, name, category_id, manufacturer, model, serial_number, department,
          location_id, custodian_user_id, custodian_note, acquired_on, warranty_provider, warranty_expires_on,
          status, criticality, notes, is_active, maintenance_interval_days, last_maintenance_on, next_maintenance_on,
          responsible_technician_id, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tag, data.name, data.categoryId, data.manufacturer ?? null, data.model ?? null,
        data.serialNumber || null, data.department ?? 'Biomedical Engineering', data.locationId ?? null,
        data.custodianUserId ?? null, data.custodianNote ?? null, data.acquiredOn ?? null,
        data.warrantyProvider ?? null, data.warrantyExpiresOn ?? null, data.status ?? 'operational',
        data.criticality ?? 'medium', data.notes ?? null, 1,
        data.maintenanceIntervalDays ?? null, data.lastMaintenanceOn ?? null, next,
        data.responsibleTechnicianId ?? null, created, actor.id],
    );
    db.run(
      `INSERT INTO equipment_status_history (equipment_id, from_status, to_status, reason, changed_by, changed_at)
       VALUES (?, NULL, ?, 'Equipment record created', ?, ?)`,
      [lastInsertRowid, data.status ?? 'operational', actor.id, created],
    );
    audit({ actor, action: 'equipment.create', entityType: 'equipment', entityId: lastInsertRowid, entityRef: tag,
      summary: `Added ${data.name} (${tag})`, after: { name: data.name, category: category.code }, req });
    return findEquipment(db, lastInsertRowid);
  });
}

export function updateEquipment(db, id, data, actor, req) {
  const existing = findEquipment(db, id);
  if (!existing) throw notFound('Equipment not found');
  const payload = { ...data };
  if (payload.serialNumber === '') payload.serialNumber = null;
  assertReferences(db, { ...payload, id });

  const sets = [];
  const params = [];
  const before = {};
  const after = {};
  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
    if (payload[field] === undefined) continue;
    if (field === 'status') continue; // status changes go through the audited setter
    sets.push(`${column} = ?`);
    params.push(payload[field] ?? null);
    before[column] = existing[camelKeyOf(column)];
    after[column] = payload[field] ?? null;
  }
  if (!sets.length) return existing;

  // Keep due dates consistent with a changed interval / completion date unless overridden.
  const intervalChanged = payload.maintenanceIntervalDays !== undefined;
  const lastChanged = payload.lastMaintenanceOn !== undefined;
  if ((intervalChanged || lastChanged) && payload.nextMaintenanceOn === undefined) {
    const merged = {
      intervalDays: payload.maintenanceIntervalDays ?? existing.maintenanceIntervalDays,
      lastMaintenanceOn: payload.lastMaintenanceOn ?? existing.lastMaintenanceOn,
      nextMaintenanceOn: null,
    };
    const next = deriveNextMaintenance(merged);
    if (next !== existing.nextMaintenanceOn) {
      sets.push('next_maintenance_on = ?');
      params.push(next);
      after.next_maintenance_on = next;
      before.next_maintenance_on = existing.nextMaintenanceOn;
    }
  }

  return db.tx(() => {
    sets.push('updated_at = ?', 'updated_by = ?');
    params.push(nowIso(), actor.id);
    db.run(`UPDATE equipment SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    audit({ actor, action: 'equipment.update', entityType: 'equipment', entityId: id, entityRef: existing.assetTag,
      summary: `Updated ${Object.keys(after).length} field(s)`, before, after, req });
    return findEquipment(db, id);
  });
}

const camelKeyOf = (c) => c.replace(/_([a-z0-9])/g, (_m, x) => x.toUpperCase());

/* ------------------------------------------------------------------ status -- */

/**
 * The only legal way to change equipment status.  Every call writes an
 * `equipment_status_history` row (which is what makes downtime measurement possible) and
 * refuses to return a device to service while faults are still open.
 */
export function setEquipmentStatus(db, { equipmentId, status, reason, actor, faultId = null, req, system = false }) {
  if (!EQUIPMENT_STATUSES.includes(status)) throw badRequest(`Unknown status: ${status}`);
  const eq = db.get('SELECT id, asset_tag, name, status, is_active FROM equipment WHERE id = ?', [equipmentId]);
  if (!eq) throw notFound('Equipment not found');
  if (eq.status === status) return { changed: false, previousStatus: status, status };

  if (['out_of_service', 'decommissioned'].includes(status) && !reason) {
    throw badRequest(`A reason is required when setting ${statusLabel(status)}`, { fields: { reason: ['Required'] } });
  }
  if (status === 'operational' && !system) {
    const open = db.get(
      `SELECT COUNT(*) AS n, GROUP_CONCAT(reference) AS refs FROM fault_reports
        WHERE equipment_id = ? AND status IN (${quote(OPEN_FAULT_STATUSES)})`,
      [equipmentId],
    );
    if (open.n > 0) {
      throw conflict(
        `${eq.asset_tag} still has ${open.n} unresolved fault report(s) (${open.refs}). ` +
          'Move them forward or close them before returning the equipment to service.',
        { openFaults: open.refs?.split(',') ?? [] },
      );
    }
    if (can(actor, 'fault.diagnose') === false && db.value(
      `SELECT COUNT(*) FROM repair_records r JOIN fault_reports f ON f.id = r.fault_id
        WHERE r.equipment_id = ? AND f.status = 'repaired'`, [equipmentId],
    ) > 0) {
      throw forbidden('Only a technician may sign a piece of equipment back into service');
    }
  }

  const at = nowIso();
  db.run(
    `UPDATE equipment SET status = ?, updated_at = ?, updated_by = ?,
            decommissioned_at = CASE WHEN ? = 'decommissioned' THEN ? ELSE decommissioned_at END,
            decommission_reason = CASE WHEN ? = 'decommissioned' THEN ? ELSE decommission_reason END
      WHERE id = ?`,
    [status, at, actor?.id ?? null, status, at, status, reason ?? null, equipmentId],
  );
  db.run(
    `INSERT INTO equipment_status_history (equipment_id, from_status, to_status, reason, fault_id, changed_by, changed_at)
     VALUES (?,?,?,?,?,?,?)`,
    [equipmentId, eq.status, status, reason ?? null, faultId, actor?.id ?? null, at],
  );
  audit({ actor, action: 'equipment.status', entityType: 'equipment', entityId: equipmentId,
    entityRef: eq.asset_tag, summary: `${eq.status} → ${status}${reason ? `: ${reason}` : ''}`,
    before: { status: eq.status }, after: { status, reason }, req });
  return { changed: true, previousStatus: eq.status, status };
}

/**
 * Recomputes equipment status from all of its open faults (a device can carry more than
 * one) and returns the worst one.  Rules that protect judgement calls made by people:
 *   • never touches a decommissioned asset;
 *   • never lifts `out_of_service` — returning a quarantined device to service is an
 *     explicit administrative action, not a side effect of closing a fault.
 */
export function deriveEquipmentStatus(db, equipmentId, { actor, faultId = null, reason, req } = {}) {
  const eq = db.get('SELECT id, status FROM equipment WHERE id = ?', [equipmentId]);
  if (!eq) throw notFound('Equipment not found');
  if (eq.status === 'decommissioned') return { changed: false, status: eq.status, skipped: 'decommissioned' };

  const open = db.all(
    `SELECT status FROM fault_reports WHERE equipment_id = ? AND status IN (${quote(OPEN_FAULT_STATUSES)})`,
    [equipmentId],
  );
  let target = 'operational';
  if (open.length) {
    const ranks = open.map((f) => STATUS_META[FAULT_TO_EQUIPMENT_STATUS[f.status]].rank);
    const worstRank = Math.max(...ranks);
    target = EQUIPMENT_STATUSES.find((s) => STATUS_META[s].rank === worstRank);
  }
  if (eq.status === 'out_of_service' && target !== 'operational') return { changed: false, status: eq.status, skipped: 'out_of_service' };
  if (eq.status === 'out_of_service') return { changed: false, status: eq.status, skipped: 'out_of_service' };
  if (eq.status === target) return { changed: false, status: target };

  return setEquipmentStatus(db, {
    equipmentId, status: target, faultId, actor, req,
    reason: reason ?? (open.length ? `Derived from ${open.length} open fault report(s)` : 'All fault reports resolved'),
    system: true,
  });
}

/* ---------------------------------------------------------------- deletion -- */

export function deleteEquipment(db, id, { confirmTag, reason }, actor, req) {
  const eq = db.get('SELECT * FROM equipment WHERE id = ?', [id]);
  if (!eq) throw notFound('Equipment not found');
  if (String(confirmTag ?? '').trim().toUpperCase() !== eq.asset_tag.toUpperCase()) {
    throw badRequest('Type the asset tag to confirm deletion', { fields: { confirmTag: [`Expected “${eq.asset_tag}”`] } });
  }
  const refs = db.get(
    `SELECT (SELECT COUNT(*) FROM fault_reports WHERE equipment_id = ?) AS faults,
            (SELECT COUNT(*) FROM maintenance_records WHERE equipment_id = ?) AS maintenance,
            (SELECT COUNT(*) FROM repair_records WHERE equipment_id = ?) AS repairs,
            (SELECT COUNT(*) FROM attachments WHERE owner_type = 'equipment' AND owner_id = ?) AS files`,
    [id, id, id, id],
  );
  const blocking = Object.entries(refs).filter(([, v]) => v > 0);
  if (blocking.length) {
    throw conflict(
      'This item already has official history (' +
        blocking.map(([k, v]) => `${v} ${k}`).join(', ') +
        '). Deactivate it or set it to Decommissioned instead — traceability outranks tidiness.',
      { references: Object.fromEntries(blocking) },
    );
  }
  return db.tx(() => {
    db.run('DELETE FROM equipment_status_history WHERE equipment_id = ?', [id]);
    db.run('DELETE FROM maintenance_schedules WHERE equipment_id = ?', [id]);
    db.run('DELETE FROM attachments WHERE owner_type = ? AND owner_id = ?', ['equipment', id]);
    db.run('DELETE FROM equipment WHERE id = ?', [id]);
    audit({ actor, action: 'equipment.delete', entityType: 'equipment', entityId: id, entityRef: eq.asset_tag,
      summary: `Deleted ${eq.name} (no history attached)${reason ? `: ${reason}` : ''}`,
      before: { name: eq.name, assetTag: eq.asset_tag, status: eq.status }, req });
    return { deleted: true, assetTag: eq.asset_tag };
  });
}

export function setEquipmentActive(db, id, isActive, actor, req) {
  const eq = findEquipment(db, id);
  if (!eq) throw notFound('Equipment not found');
  db.run('UPDATE equipment SET is_active = ?, updated_at = ?, updated_by = ? WHERE id = ?', [isActive ? 1 : 0, nowIso(), actor.id, id]);
  audit({ actor, action: isActive ? 'equipment.activate' : 'equipment.deactivate', entityType: 'equipment',
    entityId: id, entityRef: eq.assetTag, summary: `${isActive ? 'Reactivated' : 'Deactivated'} ${eq.name}`, req });
  return findEquipment(db, id);
}

/* -------------------------------------------------------------- attachments -- */

export function setImage(db, id, { buffer, filename }, actor, req) {
  const eq = findEquipment(db, id);
  if (!eq) throw notFound('Equipment not found');
  const detected = sniff(buffer, filename, 'photo');
  const stored = store(buffer, extensionOf(filename));
  const checksum = createChecksum(buffer);
  return db.tx(() => {
    if (eq.imageFilename) {
      removeStored(eq.imageFilename);
      db.run('DELETE FROM attachments WHERE owner_type = ? AND owner_id = ? AND kind = ? AND is_deleted = 0', ['equipment', id, 'photo']);
    }
    const { lastInsertRowid } = db.run(
      `INSERT INTO attachments (owner_type, owner_id, kind, stored_name, filename, mime_type, size_bytes, checksum, uploaded_by, created_at)
       VALUES ('equipment', ?, 'photo', ?, ?, ?, ?, ?, ?, ?)`,
      [id, stored, sanitizeFilename(filename), detected.mime, buffer.length, checksum, actor.id, nowIso()],
    );
    db.run('UPDATE equipment SET image_filename = ?, updated_at = ?, updated_by = ? WHERE id = ?', [stored, nowIso(), actor.id, id]);
    audit({ actor, action: 'equipment.image', entityType: 'equipment', entityId: id, entityRef: eq.assetTag,
      summary: 'Updated equipment photograph', req });
    return { attachmentId: lastInsertRowid, ...findEquipment(db, id) };
  });
}

const createChecksum = (buffer) => createHash('sha256').update(buffer).digest('hex');

/* ---------------------------------------------------------------- downtime -- */

/* -------------------------------------------------------------- history ---- */

/**
 * One chronological view of everything that has ever happened to this item, which is what a
 * technician reads before touching a device.  Sources are unioned in JS (a handful of rows
 * per item) instead of a 4-way UNION with heterogeneous columns.
 */
export function equipmentHistory(db, idOrTag, { page = 1, perPage = 25, type = 'all' } = {}, user = null) {
  const eq = resolveEquipment(db, idOrTag);
  const detailed = can(user, 'equipment.view.all');
  const events = [];

  const faults = db.all(
    `SELECT f.id, f.reference, f.title, f.severity, f.status, f.created_at, f.updated_at,
            fc.name AS category_name, u.full_name AS assigned_to_name
       FROM fault_reports f
       LEFT JOIN fault_categories fc ON fc.id = f.category_id
       LEFT JOIN users u ON u.id = f.assigned_to
      WHERE f.equipment_id = ?`,
    [eq.id],
  );
  for (const f of faults) {
    events.push({
      type: 'fault', at: f.created_at, reference: f.reference, title: f.title,
      label: `Fault reported — ${f.category_name ?? 'uncategorised'}`,
      severity: f.severity, status: f.status, updated: f.updated_at, actor: null,
      detailId: f.id,
    });
    if (f.assigned_to_name) {
      events.push({ type: 'fault', at: f.updated_at ?? f.created_at, reference: f.reference, title: f.title,
        label: `Handled by ${f.assigned_to_name}`, status: f.status, detailId: f.id });
    }
  }

  const maintenance = db.all(
    `SELECT m.id, m.reference, m.performed_on, m.condition_found, m.findings, m.days_late, u.full_name AS actor
       FROM maintenance_records m JOIN users u ON u.id = m.performed_by WHERE m.equipment_id = ?`,
    [eq.id],
  );
  for (const m of maintenance) {
    events.push({ type: 'maintenance', at: m.performed_on, reference: m.reference,
      label: `Preventive maintenance ${m.condition_found === 'pass' ? 'completed — passed' : `completed — ${String(m.condition_found ?? '').replace(/_/g, ' ')}`}`,
      detail: m.findings, actor: m.actor, daysLate: m.days_late, detailId: m.id });
  }

  const repairs = detailed ? db.all(
    `SELECT r.id, r.reference, r.date_repaired, r.diagnosis, r.total_cost, r.currency, u.full_name AS actor,
            f.reference AS fault_reference
       FROM repair_records r JOIN users u ON u.id = r.technician_id
       LEFT JOIN fault_reports f ON f.id = r.fault_id WHERE r.equipment_id = ?`,
    [eq.id],
  ) : [];
  for (const r of repairs) {
    events.push({ type: 'repair', at: r.date_repaired, reference: r.reference,
      label: `Repair recorded — ${String(r.diagnosis).slice(0, 120)}`, detail: `${r.total_cost} ${r.currency}`,
      actor: r.actor, faultReference: r.fault_reference, detailId: r.id });
  }

  const statusChanges = db.all(
    `SELECT h.id, h.from_status, h.to_status, h.reason, h.changed_at, u.full_name AS actor
       FROM equipment_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.equipment_id = ?`,
    [eq.id],
  );
  for (const h of statusChanges) {
    events.push({ type: 'status', at: h.changed_at, label: `${h.from_status ? statusLabel(h.from_status) + ' → ' : ''}${statusLabel(h.to_status)}`,
      detail: h.reason, actor: h.actor, detailId: h.id });
  }

  const filtered = type && type !== 'all' ? events.filter((e) => e.type === type) : events;
  filtered.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const start = (page - 1) * perPage;
  return {
    equipmentId: eq.id,
    assetTag: eq.assetTag,
    items: shape(filtered.slice(start, start + perPage)),
    pagination: { page, perPage, total: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / perPage)) },
    counts: {
      fault: filtered.filter((e) => e.type === 'fault').length,
      maintenance: filtered.filter((e) => e.type === 'maintenance').length,
      repair: filtered.filter((e) => e.type === 'repair').length,
      status: filtered.filter((e) => e.type === 'status').length,
    },
  };
}

export function clearImage(db, id, actor, req) {
  const eq = findEquipment(db, id);
  if (!eq) throw notFound('Equipment not found');
  return db.tx(() => {
    if (eq.imageFilename) removeStored(eq.imageFilename);
    db.run('UPDATE attachments SET is_deleted = 1 WHERE owner_type = ? AND owner_id = ? AND kind = ?', ['equipment', eq.id, 'photo']);
    db.run('UPDATE equipment SET image_filename = NULL, updated_at = ?, updated_by = ? WHERE id = ?', [nowIso(), actor.id, eq.id]);
    audit({ actor, action: 'equipment.image_clear', entityType: 'equipment', entityId: eq.id, entityRef: eq.assetTag,
      summary: 'Equipment photograph removed', req });
    return findEquipment(db, eq.id);
  });
}

/* ------------------------------------------------------------- label sheet -- */

export function forLabels(db, ids) {
  if (!ids?.length) throw badRequest('Select at least one piece of equipment');
  const rows = db.all(
    `SELECT id, asset_tag, name, status FROM equipment WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY asset_tag`,
    ids,
  );
  return rows.map((r) => shape(r));
}

