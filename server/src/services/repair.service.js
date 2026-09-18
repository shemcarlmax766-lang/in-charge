import { nextSequence } from '../lib/db.js';
import { shape } from '../lib/shape.js';
import { nowIso, todayDateOnly } from '../lib/time.js';
import { reference as makeReference } from '../lib/tokens.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { can, hintFor } from '../auth/capabilities.js';

const hint = (cap) => hintFor(cap) ?? 'Only a technician or biomedical engineer may perform this action.';
import { store, sniff, sanitizeFilename, extensionOf, checksum } from '../lib/files.js';
import { notifyMany } from './notification.service.js';
import { assertRepairRecordComplete } from './fault.service.js';

/**
 * The technician's repair record (§6 of the brief).
 *
 * Two-stage design, because the department needs both flexibility and rigour:
 *   • DRAFT — a technician may save partial findings while the device is still open on the
 *     bench (diagnosis / root cause / actions are required so records are never empty shells).
 *   • SIGN-OFF — test results, the date repaired and the explicit safety confirmation become
 *     mandatory when the fault is moved to `repaired` (see assertRepairRecordComplete), and
 *     that is the only path that returns equipment to service.
 */

const CORE_TEXT = {
  diagnosis: { label: 'Fault diagnosis', min: 5, max: 2000 },
  rootCause: { label: 'Root cause', min: 5, max: 2000 },
  repairActions: { label: 'Repair performed', min: 5, max: 4000 },
  troubleshooting: { label: 'Troubleshooting performed', min: 0, max: 4000 },
  testResults: { label: 'Test results', min: 5, max: 4000 },
  calibrationDetails: { label: 'Calibration details', min: 5, max: 2000 },
  notes: { label: 'Additional notes', min: 0, max: 4000 },
};

function assertWritable(user, fault) {
  if (user.roleCode !== 'technician') {
    throw forbidden(
      `${hint('repair.write')} An administrator can reassign the fault so a qualified person documents it.`,
      { requiredCapability: 'repair.write' },
    );
  }
  const isAssigned = !fault.assigned_to || fault.assigned_to === user.id;
  if (!isAssigned) {
    throw forbidden('This fault is assigned to another technician. Ask an administrator to reassign it before recording work.');
  }
  if (fault.status === 'closed') {
    throw conflict('This fault is closed, so its repair record is fixed. An administrator must reopen the fault before the record can change.');
  }
}

function textProblems(data) {
  const fields = {};
  for (const [key, rule] of Object.entries(CORE_TEXT)) {
    const value = data[key];
    if (value === undefined) continue;
    const len = String(value ?? '').trim().length;
    if (len < rule.min) fields[key] = [`${rule.label} needs at least ${rule.min} characters`];
    if (len > rule.max) fields[key] = [`${rule.label} is too long (max ${rule.max} characters)`];
  }
  if (data.calibrationPerformed && !String(data.calibrationDetails ?? '').trim()) {
    fields.calibrationDetails = ['Describe the calibration you performed and the reference used'];
  }
  if (Object.keys(fields).length) throw badRequest('The repair record has problems', { fields });
}

export function listParts(db, { q = '', activeOnly = true } = {}) {
  const where = [];
  const params = [];
  if (activeOnly) where.push('is_active = 1');
  if (q) {
    where.push('(code LIKE ? OR name LIKE ? OR category LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  return db.all(
    `SELECT id, code, name, category, unit, unit_cost, in_stock FROM replacement_parts
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name LIMIT 200`,
    params,
  ).map(shape);
}

export function upsertParts(db, input, actor, req) {
  if (!can(actor, 'meta.manage')) throw forbidden('Only an administrator maintains the spare-parts catalogue');
  return db.tx(() => {
    if (input.id) {
      const exists = db.get('SELECT id FROM replacement_parts WHERE id = ?', [input.id]);
      if (!exists) throw notFound('Part not found');
      db.run(
        `UPDATE replacement_parts SET code=?, name=?, category=?, unit=?, unit_cost=?, in_stock=?, is_active=? WHERE id=?`,
        [input.code, input.name, input.category ?? null, input.unit ?? 'pcs', input.unitCost ?? 0,
          input.inStock ?? 0, input.isActive === false ? 0 : 1, input.id],
      );
      audit({ actor, action: 'part.update', entityType: 'replacement_part', entityId: input.id, entityRef: input.code,
        summary: `Updated catalogue part ${input.name}`, req });
      return shape(db.get('SELECT * FROM replacement_parts WHERE id = ?', [input.id]));
    }
    if (db.get('SELECT id FROM replacement_parts WHERE code = ?', [input.code])) {
      throw conflict(`Part code ${input.code} already exists`);
    }
    const { lastInsertRowid } = db.run(
      `INSERT INTO replacement_parts (code, name, category, unit, unit_cost, in_stock, is_active, created_at)
       VALUES (?,?,?,?,?,?,1,?)`,
      [input.code, input.name, input.category ?? null, input.unit ?? 'pcs', input.unitCost ?? 0, input.inStock ?? 0, nowIso()],
    );
    audit({ actor, action: 'part.create', entityType: 'replacement_part', entityId: lastInsertRowid, entityRef: input.code,
      summary: `Added catalogue part ${input.name}`, req });
    return shape(db.get('SELECT * FROM replacement_parts WHERE id = ?', [lastInsertRowid]));
  });
}

/* ------------------------------------------------------------------ write --- */

function writeParts(db, repairId, parts) {
  db.run('DELETE FROM repair_parts WHERE repair_id = ?', [repairId]);
  let partsCost = 0;
  for (const p of parts ?? []) {
    const catalog = p.partId ? db.get('SELECT * FROM replacement_parts WHERE id = ?', [p.partId]) : null;
    if (p.partId && !catalog) throw badRequest(`Unknown part id ${p.partId}`, { fields: { parts: ['Not in catalogue'] } });
    const name = String(p.partName ?? catalog?.name ?? '').trim();
    if (!name) throw badRequest('Each part line needs a name', { fields: { parts: ['name required'] } });
    const qty = Math.max(1, Number.parseInt(p.quantity ?? 1, 10) || 1);
    const unitCost = p.unitCost !== undefined && p.unitCost !== null && p.unitCost !== ''
      ? Number(p.unitCost)
      : Number(catalog?.unit_cost ?? 0);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw badRequest('Part unit cost must be zero or more', { fields: { parts: ['unitCost invalid'] } });
    }
    const line = Math.round(qty * unitCost * 100) / 100;
    partsCost += line;
    db.run(
      `INSERT INTO repair_parts (repair_id, part_id, part_name, part_number, serial_number, quantity, unit_cost, line_cost, recovered)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [repairId, catalog?.id ?? null, name.slice(0, 160), p.partNumber ?? catalog?.code ?? null,
        p.serialNumber ?? null, qty, unitCost, line, p.recovered ? 1 : 0],
    );
  }
  return Math.round(partsCost * 100) / 100;
}

/**
 * Creates or updates the repair record for a fault (one record per fault, enforced by
 * `repair_records.fault_id UNIQUE`).  Costs are recomputed from the parts lines every
 * time so a stale `totalCost` in a form payload can never win.
 */
export function saveRepair(db, faultId, data, actor, req) {
  const fault = db.get(
    `SELECT f.*, e.asset_tag, e.name AS equipment_name, e.criticality, e.id AS eq_id
       FROM fault_reports f JOIN equipment e ON e.id = f.equipment_id WHERE f.id = ?`,
    [faultId],
  );
  if (!fault) throw notFound('Fault report not found');
  assertWritable(actor, fault);
  textProblems(data);

  const labour = Number(data.labourCost ?? 0);
  const other = Number(data.otherCost ?? 0);
  if (labour < 0 || other < 0 || !Number.isFinite(labour) || !Number.isFinite(other)) {
    throw badRequest('Costs cannot be negative', { fields: { labourCost: ['Must be ≥ 0'], otherCost: ['Must be ≥ 0'] } });
  }
  const dateRepaired = data.dateRepaired ?? todayDateOnly();
  if (dateRepaired > todayDateOnly()) throw badRequest('The date repaired cannot be in the future', { fields: { dateRepaired: ['Use today or earlier'] } });

  return db.tx(() => {
    const existing = db.get('SELECT * FROM repair_records WHERE fault_id = ?', [faultId]);
    const dateOnly = (v) => String(v ?? '').slice(0, 10) || null;

    const fields = {
      diagnosis: (data.diagnosis ?? existing?.diagnosis ?? '').trim(),
      root_cause: (data.rootCause ?? existing?.root_cause ?? '').trim(),
      troubleshooting: data.troubleshooting !== undefined ? data.troubleshooting : existing?.troubleshooting ?? null,
      repair_actions: (data.repairActions ?? existing?.repair_actions ?? '').trim(),
      test_results: data.testResults !== undefined ? String(data.testResults).trim() : existing?.test_results ?? '',
      calibration_performed: data.calibrationPerformed === undefined ? existing?.calibration_performed ?? 0 : (data.calibrationPerformed ? 1 : 0),
      calibration_details: data.calibrationDetails !== undefined ? data.calibrationDetails : existing?.calibration_details ?? null,
      labour_cost: Number.isFinite(labour) ? labour : existing?.labour_cost ?? 0,
      other_cost: Number.isFinite(other) ? other : existing?.other_cost ?? 0,
      currency: data.currency ?? existing?.currency ?? 'USD',
      safety_check_confirmed: data.safetyCheckConfirmed === undefined ? existing?.safety_check_confirmed ?? 0 : (data.safetyCheckConfirmed ? 1 : 0),
      safe_to_return_to_service: data.safeToReturnToService === undefined ? existing?.safe_to_return_to_service ?? 1 : (data.safeToReturnToService ? 1 : 0),
      date_repaired: dateOnly(data.dateRepaired ?? existing?.date_repaired) ?? todayDateOnly(),
      notes: data.notes !== undefined ? data.notes : existing?.notes ?? null,
    };
    if (fields.calibration_performed && !fields.calibration_details) {
      throw badRequest('Describe the calibration you performed', { fields: { calibrationDetails: ['Required when calibration is marked as performed'] } });
    }

    let repairId = existing?.id;
    if (existing) {
      db.run(`UPDATE repair_records SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`,
        [...Object.values(fields), nowIso(), actor.id, existing.id]);
    } else {
      const seq = nextSequence(db, `repair:${new Date().getUTCFullYear()}`);
      const ref = makeReference('RPR', new Date().getUTCFullYear(), seq);
      const res = db.run(
        `INSERT INTO repair_records (reference, fault_id, equipment_id, technician_id, created_at, created_by, ${Object.keys(fields).join(', ')})
         VALUES (?,?,?,?,?,?,${Object.keys(fields).map(() => '?').join(',')})`,
        [ref, faultId, fault.eq_id, actor.id, nowIso(), actor.id, ...Object.values(fields)],
      );
      repairId = res.lastInsertRowid;
    }

    // Part lines are written after the record exists, then costs are rolled up from them, so
    // the total is always derived — a stale totalCost in a form payload can never win.
    let partsCost;
    let summary = existing?.parts_replaced_summary ?? null;
    if (Array.isArray(data.parts)) {
      partsCost = writeParts(db, repairId, data.parts);
      const lines = db.all('SELECT part_name, quantity FROM repair_parts WHERE repair_id = ? ORDER BY id', [repairId]);
      if (lines.length) summary = lines.map((l) => `${l.quantity} × ${l.part_name}`).join('; ').slice(0, 500);
    } else {
      partsCost = data.partsCost !== undefined && data.partsCost !== null && data.partsCost !== ''
        ? Math.max(0, Number(data.partsCost))
        : existing?.parts_cost ?? 0;
      if (!Number.isFinite(partsCost)) throw badRequest('Parts cost must be a number', { fields: { partsCost: ['Invalid'] } });
    }
    const total = Math.round((partsCost + fields.labour_cost + fields.other_cost) * 100) / 100;
    db.run('UPDATE repair_records SET parts_cost = ?, total_cost = ?, parts_replaced_summary = ?, updated_at = ? WHERE id = ?',
      [partsCost, total, summary, nowIso(), repairId]);
    fields.total_cost = total;
    fields.parts_cost = partsCost;
    fields.parts_replaced_summary = summary;

    // A repair record is a technical assertion, so it confirms the diagnosis flag too.
    db.run('UPDATE fault_reports SET diagnosis_confirmed = 1, updated_at = ? WHERE id = ?', [nowIso(), faultId]);

    const detail = repairRecordDetail(db, repairId);
    if (!existing) {
      notifyMany(db, [fault.reported_by], {
        type: 'fault_status_changed', severity: 'info',
        title: `Work recorded on ${fault.reference}`,
        body: `${actor.fullName} recorded a diagnosis: ${String(fields.diagnosis).slice(0, 200)}`,
        link: `/faults/${faultId}`, entityType: 'repair_record', entityId: repairId,
      });
    }
    audit({ actor, action: existing ? 'repair.update' : 'repair.create', entityType: 'repair_record',
      entityId: repairId, entityRef: db.value('SELECT reference FROM repair_records WHERE id = ?', [repairId]),
      summary: `${fault.reference}: ${String(fields.diagnosis).slice(0, 80)} (cost ${total} ${fields.currency})`,
      after: { totalCost: total, partsCost, labourCost: fields.labour_cost, safeToReturn: fields.safe_to_return_to_service }, req });
    return detail;
  });
}

export function repairRecordDetail(db, id) {
  const row = db.get(
    `SELECT r.*, u.full_name AS technician_name, u.job_title AS technician_title,
            f.reference AS fault_reference, f.severity AS fault_severity, f.status AS fault_status,
            e.asset_tag, e.name AS equipment_name
       FROM repair_records r
       JOIN users u ON u.id = r.technician_id
       JOIN fault_reports f ON f.id = r.fault_id
       JOIN equipment e ON e.id = r.equipment_id
      WHERE r.id = ?`,
    [id],
  );
  if (!row) throw notFound('Repair record not found');
  const parts = db.all(
    `SELECT p.*, rp.code AS catalogue_code, rp.unit AS catalogue_unit
       FROM repair_parts p LEFT JOIN replacement_parts rp ON rp.id = p.part_id
      WHERE p.repair_id = ? ORDER BY p.id`,
    [id],
  );
  const attachments = db.all(
    `SELECT id, kind, filename, mime_type, size_bytes, caption, created_at
       FROM attachments WHERE owner_type = 'repair_record' AND owner_id = ? AND is_deleted = 0 ORDER BY kind, id`,
    [id],
  );
  return shape({
    ...row,
    parts,
    attachments,
    signOffReady: !!(row.diagnosis && row.root_cause && row.repair_actions && row.test_results && row.date_repaired && row.safety_check_confirmed),
  });
}

export const detailForFault = (db, faultId, user) => {
  const id = db.value('SELECT id FROM repair_records WHERE fault_id = ?', [faultId]);
  if (!id) return null;
  const rec = repairRecordDetail(db, id);
  if (!can(user, 'repair.view.any') && rec.technicianId !== user.id) throw forbidden('You may not view this repair record');
  return rec;
};

/** Pre-transition check surfaced in the UI so the button explains itself before it fails. */
export function readiness(db, faultId) {
  const row = db.get('SELECT * FROM repair_records WHERE fault_id = ?', [faultId]);
  const missing = [];
  if (!row) missing.push('repairRecord');
  else {
    if (!row.diagnosis?.trim()) missing.push('diagnosis');
    if (!row.root_cause?.trim()) missing.push('rootCause');
    if (!row.repair_actions?.trim()) missing.push('repairActions');
    if (!row.test_results?.trim()) missing.push('testResults');
    if (!row.date_repaired) missing.push('dateRepaired');
    if (!row.safety_check_confirmed) missing.push('safetyCheckConfirmed');
    if (!row.safe_to_return_to_service) missing.push('safeToReturnToService');
  }
  return { canMarkRepaired: missing.length === 0, missing, hasRecord: !!row };
}

export const assertComplete = (db, faultId) => assertRepairRecordComplete(db, faultId);

/* --------------------------------------------------------------- attachments */

const PHOTO_KINDS = new Set(['before_photo', 'after_photo', 'document']);

export function addPhotos(db, repairId, files, { kind = 'document', caption } = {}, actor, req) {
  const rec = db.get('SELECT id, reference, fault_id FROM repair_records WHERE id = ?', [repairId]);
  if (!rec) throw notFound('Repair record not found');
  if (!actor || !can(actor, 'repair.write')) throw forbidden('Only the technician who performed the work attaches evidence');
  return db.tx(() => {
    const ids = [];
    for (const file of files ?? []) {
      const detected = sniff(file.buffer, file.originalname, kind === 'document' ? 'document' : 'photo');
      const stored = store(file.buffer, extensionOf(file.originalname));
      const res = db.run(
        `INSERT INTO attachments (owner_type, owner_id, kind, stored_name, filename, mime_type, size_bytes, checksum, caption, uploaded_by, created_at)
         VALUES ('repair_record', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [repairId, kind, stored, sanitizeFilename(file.originalname), detected.mime, file.buffer.length,
          checksum(file.buffer), caption ?? null, actor.id, nowIso()],
      );
      ids.push(res.lastInsertRowid);
    }
    audit({ actor, action: 'repair.attachments', entityType: 'repair_record', entityId: repairId,
      entityRef: rec.reference, summary: `${ids.length} evidence file(s) attached`, req });
    return { attached: ids.length, ids, ...repairRecordDetail(db, repairId) };
  });
}

