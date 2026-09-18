import { nextSequence } from '../lib/db.js';
import { shape } from '../lib/shape.js';
import { nowIso, todayDateOnly, toDateOnly, addDays, diffDays, minutesBetween } from '../lib/time.js';
import { reference as makeReference } from '../lib/tokens.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { can } from '../auth/capabilities.js';
import { notifyMany, usersWithRole } from './notification.service.js';

/**
 * Preventive maintenance (§7 of the brief).
 *
 * A **schedule** owns the interval, the checklist and the due date; a **record** is the
 * evidence that a PM was actually performed. Completing a record advances the schedule and
 * the equipment's own `next_maintenance_on`, which is what makes the three traffic lights
 * (🟢 up to date / 🟡 due soon / 🔴 overdue) computed rather than hand-typed.
 *
 * A PM that finds a defect does NOT silently become a repair job: the technician is told to
 * raise a fault report, so faults keep exactly one accountable workflow.
 */

export const DUE_SOON_DAYS = 14;
export const PM_STATES = ['up_to_date', 'due_soon', 'overdue', 'not_scheduled'];

export function pmStateFor(nextDueOn, { at = todayDateOnly(), dueSoonDays = DUE_SOON_DAYS } = {}) {
  if (!nextDueOn) return { state: 'not_scheduled', label: 'No preventive maintenance scheduled', light: '⚪', daysUntil: null };
  const days = diffDays(at, nextDueOn);
  if (days === null) return { state: 'not_scheduled', label: 'No preventive maintenance scheduled', light: '⚪', daysUntil: null };
  if (days < 0) return { state: 'overdue', label: `Overdue by ${Math.abs(days)} day(s)`, light: '🔴', daysUntil: days };
  if (days <= dueSoonDays) return { state: 'due_soon', label: `Due in ${days} day(s)`, light: '🟡', daysUntil: days };
  return { state: 'up_to_date', label: `Up to date — ${days} day(s) remaining`, light: '🟢', daysUntil: days };
}

/**
 * Checklist templates keyed by a human interval name.  These are *starting points* the
 * department edits per device — never an auto-applied standard, because the manufacturer
 * manual governs, not this file.
 */
const DEFAULT_CHECKLISTS = {
  daily: ['Power on and run self-test', 'Clean exterior and accessories', 'Inspect cables and connectors for damage'],
  weekly: ['Function check against a known-good reference', 'Clean filters / traps', 'Verify consumable stock'],
  monthly: ['Function test against reference', 'Visual inspection of housing and controls', 'Verify consumables and filters', 'Record operating readings'],
  quarterly: ['Electrical safety check (earth bond + leakage)', 'Function test against calibrated reference', 'Replace filters / tubing as scheduled', 'Clean and lubricate moving parts', 'Verify calibration and record deviation'],
  semiannual: ['Electrical safety test', 'Mechanical wear inspection', 'Firmware / service-bulletin review', 'Calibration verification', 'Replace wear items'],
  annual: ['Complete preventive service per manufacturer manual', 'Electrical safety test to IEC 62353 limits', 'Full calibration with traceable reference', 'Performance verification across full range', 'Battery capacity / autonomy test', 'Update equipment history and PM label'],
};

export const checklistTemplates = () => Object.entries(DEFAULT_CHECKLISTS).map(([interval, items]) => ({ interval, items }));

/* --------------------------------------------------------------- schedules -- */

export function listSchedules(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.equipmentId) { where.push('s.equipment_id = ?'); params.push(filters.equipmentId); }
  if (filters.technicianId) { where.push('s.responsible_technician_id = ?'); params.push(filters.technicianId); }
  if (filters.activeOnly !== false) where.push('s.is_active = 1');
  if (filters.state === 'overdue') where.push("date(s.next_due_on) < date('now')");
  if (filters.state === 'due_soon') where.push(`date(s.next_due_on) >= date('now') AND julianday(s.next_due_on) - julianday('now') <= ${DUE_SOON_DAYS}`);
  if (filters.state === 'up_to_date') where.push(`julianday(s.next_due_on) - julianday('now') > ${DUE_SOON_DAYS}`);

  const rows = db.all(
    `SELECT s.*, e.asset_tag, e.name AS equipment_name, e.status AS equipment_status,
            e.criticality, l.name AS location_name,
            u.full_name AS responsible_technician_name,
            (SELECT COUNT(*) FROM maintenance_checklist_items i WHERE i.schedule_id = s.id) AS checklist_count,
            (SELECT COUNT(*) FROM maintenance_records mr WHERE mr.schedule_id = s.id) AS times_done,
            CAST(julianday(s.next_due_on) - julianday('now') AS INTEGER) AS days_until_due
       FROM maintenance_schedules s
       JOIN equipment e ON e.id = s.equipment_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN users u ON u.id = s.responsible_technician_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY julianday(s.next_due_on), e.asset_tag`,
    params,
  );
  return rows.map((r) => shape({ ...r, pm_state: pmStateFor(r.next_due_on), is_due: pmStateFor(r.next_due_on).state !== 'up_to_date' }));
}

export function scheduleDetail(db, id) {
  const row = db.get(
    `SELECT s.*, e.asset_tag, e.name AS equipment_name, e.criticality, u.full_name AS responsible_technician_name
       FROM maintenance_schedules s
       JOIN equipment e ON e.id = s.equipment_id
       LEFT JOIN users u ON u.id = s.responsible_technician_id
      WHERE s.id = ?`,
    [id],
  );
  if (!row) throw notFound('Maintenance schedule not found');
  const items = db.all('SELECT id, label, requires_evidence, position FROM maintenance_checklist_items WHERE schedule_id = ? ORDER BY position, id', [id]);
  const recent = db.all(
    `SELECT id, reference, performed_on, condition_found, days_late, due_on, duration_minutes, findings
       FROM maintenance_records WHERE schedule_id = ? ORDER BY performed_on DESC, id DESC LIMIT 12`,
    [id],
  );
  return shape({ ...row, checklist: items, recentRecords: recent, pm_state: pmStateFor(row.next_due_on) });
}

function assertAssignee(db, technicianId) {
  if (!technicianId) return null;
  const u = db.get(
    `SELECT u.id, u.full_name, u.is_active, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [technicianId],
  );
  if (!u) throw badRequest('Unknown technician', { fields: { responsibleTechnicianId: ['No such user'] } });
  if (!u.is_active) throw badRequest('That technician account is deactivated');
  if (!['technician', 'admin'].includes(u.role)) {
    throw badRequest(
      `${u.full_name} holds the ${u.role} role; preventive maintenance can only be owned by a technician or an administrator.`,
      { fields: { responsibleTechnicianId: ['Must be a technician or administrator'] } },
    );
  }
  return u;
}

function replaceChecklist(db, scheduleId, items = []) {
  db.run('DELETE FROM maintenance_checklist_items WHERE schedule_id = ?', [scheduleId]);
  (items ?? []).forEach((label, i) => {
    const text = typeof label === 'string' ? label : label?.label;
    const clean = String(text ?? '').trim().slice(0, 300);
    if (!clean) return;
    db.run('INSERT INTO maintenance_checklist_items (schedule_id, label, requires_evidence, position) VALUES (?,?,?,?)',
      [scheduleId, clean, typeof label === 'object' && label.requiresEvidence ? 1 : 0, i]);
  });
}

export function createSchedule(db, data, actor, req) {
  if (!can(actor, 'maintenance.schedule.manage')) throw forbidden('Only an administrator or technician may create maintenance schedules');
  const equipment = db.get(
    'SELECT id, asset_tag, name, status, next_maintenance_on, maintenance_interval_days, responsible_technician_id FROM equipment WHERE id = ?',
    [data.equipmentId],
  );
  if (!equipment) throw badRequest('Unknown equipment', { fields: { equipmentId: ['No such equipment'] } });
  if (equipment.status === 'decommissioned') throw conflict('Decommissioned equipment cannot have a maintenance schedule');
  assertAssignee(db, data.responsibleTechnicianId ?? equipment.responsible_technician_id);

  const interval = Number(data.intervalDays);
  if (!Number.isInteger(interval) || interval < 1 || interval > 3650) {
    throw badRequest('Maintenance interval must be a whole number of days between 1 and 3650', { fields: { intervalDays: ['Invalid'] } });
  }
  const nextDue = data.nextDueOn ?? toDateOnly(addDays(data.lastDoneOn ?? todayDateOnly(), interval));

  return db.tx(() => {
    if (db.get('SELECT id FROM maintenance_schedules WHERE equipment_id = ? AND title = ? AND is_active = 1', [data.equipmentId, data.title])) {
      throw conflict(`An active “${data.title}” schedule already exists for ${equipment.asset_tag}`);
    }
    const { lastInsertRowid } = db.run(
      `INSERT INTO maintenance_schedules (equipment_id, title, interval_days, responsible_technician_id,
          next_due_on, last_done_on, is_active, notes, created_at, created_by)
       VALUES (?,?,?,?,?,?,1,?,?,?)`,
      [data.equipmentId, data.title.trim(), interval, data.responsibleTechnicianId ?? equipment.responsible_technician_id ?? null,
        nextDue, data.lastDoneOn ?? null, data.notes ?? null, nowIso(), actor.id],
    );
    const template = DEFAULT_CHECKLISTS[String(data.title ?? '').trim().toLowerCase()] ?? [];
    replaceChecklist(db, lastInsertRowid, data.checklist ?? (data.useTemplate === false ? [] : template));
    syncEquipmentDates(db, data.equipmentId);

    const tech = data.responsibleTechnicianId ?? equipment.responsible_technician_id;
    if (tech && tech !== actor.id) {
      notifyMany(db, [tech], {
        type: 'maintenance_due', severity: 'info', title: `You own a new maintenance schedule on ${equipment.asset_tag}`,
        body: `“${data.title}” every ${interval} day(s), first due ${nextDue}.`,
        link: `/maintenance/schedules/${lastInsertRowid}`, entityType: 'maintenance_schedule', entityId: lastInsertRowid,
      });
    }
    audit({ actor, action: 'maintenance.schedule_create', entityType: 'maintenance_schedule', entityId: lastInsertRowid,
      entityRef: equipment.asset_tag, summary: `“${data.title}” every ${interval} day(s) for ${equipment.name}`,
      after: { intervalDays: interval, nextDueOn: nextDue }, req });
    return scheduleDetail(db, lastInsertRowid);
  });
}

export function updateSchedule(db, id, data, actor, req) {
  if (!can(actor, 'maintenance.schedule.manage')) throw forbidden('Only an administrator or technician may change maintenance schedules');
  const existing = db.get('SELECT * FROM maintenance_schedules WHERE id = ?', [id]);
  if (!existing) throw notFound('Maintenance schedule not found');
  assertAssignee(db, data.responsibleTechnicianId ?? existing.responsible_technician_id);
  if (data.intervalDays !== undefined) {
    const n = Number(data.intervalDays);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw badRequest('Interval must be 1–3650 days', { fields: { intervalDays: ['Invalid'] } });
  }

  return db.tx(() => {
    const sets = [];
    const params = [];
    const before = {};
    const after = {};
    const map = {
      title: 'title', intervalDays: 'interval_days', responsibleTechnicianId: 'responsible_technician_id',
      nextDueOn: 'next_due_on', lastDoneOn: 'last_done_on', notes: 'notes',
    };
    for (const [field, column] of Object.entries(map)) {
      if (data[field] === undefined) continue;
      const v = data[field] === '' ? null : data[field];
      sets.push(`${column} = ?`);
      params.push(v);
      before[column] = existing[column];
      after[column] = v;
    }
    if (data.isActive !== undefined) { sets.push('is_active = ?'); params.push(data.isActive ? 1 : 0); after.is_active = data.isActive ? 1 : 0; }
    if (data.checklist !== undefined) { replaceChecklist(db, id, data.checklist); after.checklistCount = (data.checklist ?? []).length; }
    if (!sets.length) return scheduleDetail(db, id);
    sets.push('updated_at = ?');
    params.push(nowIso());
    db.run(`UPDATE maintenance_schedules SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    syncEquipmentDates(db, existing.equipment_id);
    audit({ actor, action: 'maintenance.schedule_update', entityType: 'maintenance_schedule', entityId: id,
      summary: `Schedule “${after.title ?? existing.title}” updated`, before, after, req });
    return scheduleDetail(db, id);
  });
}

export function deleteSchedule(db, id, { reason }, actor, req) {
  if (!can(actor, 'meta.manage')) throw forbidden('Only an administrator may delete a maintenance schedule — deactivate it instead');
  const s = db.get('SELECT s.*, e.asset_tag FROM maintenance_schedules s JOIN equipment e ON e.id = s.equipment_id WHERE s.id = ?', [id]);
  if (!s) throw notFound('Maintenance schedule not found');
  const done = db.value('SELECT COUNT(*) FROM maintenance_records WHERE schedule_id = ?', [id]);
  if (done > 0 && !reason?.trim()) {
    throw conflict(`${done} completed maintenance record(s) reference this schedule. Give a reason before deleting it.`,
      { fields: { reason: ['Required'] } });
  }
  return db.tx(() => {
    db.run('UPDATE maintenance_records SET schedule_id = NULL WHERE schedule_id = ?', [id]);
    db.run('DELETE FROM maintenance_checklist_items WHERE schedule_id = ?', [id]);
    db.run('DELETE FROM maintenance_schedules WHERE id = ?', [id]);
    syncEquipmentDates(db, s.equipment_id);
    audit({ actor, action: 'maintenance.schedule_delete', entityType: 'maintenance_schedule', entityId: id,
      entityRef: s.asset_tag, summary: `Deleted schedule “${s.title}”${reason ? `: ${reason}` : ''}`, before: s, req });
    return { deleted: true };
  });
}

/**
 * The asset row's PM header mirrors its **nearest-due** active schedule, so an overdue
 * monthly check is never masked by a comfortable annual one.
 */
export function syncEquipmentDates(db, equipmentId) {
  const next = db.get(
    `SELECT next_due_on AS next_due, interval_days
       FROM maintenance_schedules WHERE equipment_id = ? AND is_active = 1
      ORDER BY julianday(next_due_on), id LIMIT 1`,
    [equipmentId],
  );
  db.run(
    `UPDATE equipment SET next_maintenance_on = ?, maintenance_interval_days = COALESCE(?, maintenance_interval_days),
            updated_at = ? WHERE id = ?`,
    [next?.next_due ?? null, next?.interval_days ?? null, nowIso(), equipmentId],
  );
}

/* ------------------------------------------------------------------ records -- */

export function createRecord(db, data, actor, req) {
  if (!can(actor, 'maintenance.record.write') && !can(actor, 'meta.manage')) {
    throw forbidden('Preventive maintenance can only be recorded by a technician or an administrator');
  }
  const schedule = data.scheduleId ? db.get('SELECT * FROM maintenance_schedules WHERE id = ?', [data.scheduleId]) : null;
  if (data.scheduleId && !schedule) throw badRequest('Unknown maintenance schedule', { fields: { scheduleId: ['No such schedule'] } });
  const eqId = data.equipmentId ?? schedule?.equipment_id;
  if (!eqId) throw badRequest('Select the equipment this maintenance was performed on', { fields: { equipmentId: ['Required'] } });
  const eq = db.get('SELECT id, asset_tag, name, status, is_active, maintenance_interval_days, next_maintenance_on FROM equipment WHERE id = ?', [eqId]);
  if (!eq) throw notFound('Equipment not found');
  if (eq.status === 'decommissioned') throw conflict('Decommissioned equipment is not maintained; reactivate it first');

  const performedOn = toDateOnly(data.performedOn ?? todayDateOnly());
  if (performedOn > todayDateOnly()) throw badRequest('Maintenance cannot be recorded in the future', { fields: { performedOn: ['Use today or earlier'] } });
  if (schedule && performedOn < schedule.last_done_on) {
    throw badRequest(`This is earlier than the last recorded completion (${schedule.last_done_on})`, { fields: { performedOn: ['After last completion'] } });
  }
  const results = Array.isArray(data.checklistResults) ? data.checklistResults : [];
  const failed = results.filter((r) => String(r.outcome ?? '').toLowerCase() === 'fail');
  const skipped = !!data.markAsMissed;
  if (skipped && !String(data.findings ?? '').trim()) {
    throw badRequest('Say why the maintenance could not be performed', { fields: { findings: ['Required when marking a missed visit'] } });
  }

  return db.tx(() => {
    const seq = nextSequence(db, `pm:${new Date().getUTCFullYear()}`);
    const ref = makeReference('PM', new Date().getUTCFullYear(), seq);
    const duration = data.durationMinutes !== undefined && data.durationMinutes !== null && data.durationMinutes !== ''
      ? Math.max(0, Number(data.durationMinutes))
      : (data.startedAt && data.completedAt ? minutesBetween(data.startedAt, data.completedAt) : null);

    const intervalDays = schedule?.interval_days ?? eq.maintenance_interval_days ?? null;
    const nextDue = data.nextDueOn ?? (intervalDays ? toDateOnly(addDays(performedOn, intervalDays)) : null);
    // Snapshot of the date this PM was *due*, so lateness is measurable from the record
    // itself instead of being reconstructed from a schedule that has already advanced.
    const dueOn = data.dueOn ?? schedule?.next_due_on ?? eq.next_maintenance_on ?? null;
    const referenceDay = skipped ? todayDateOnly() : performedOn;
    const daysLate = dueOn ? Math.max(0, diffDays(dueOn, referenceDay) ?? 0) : 0;

    const { lastInsertRowid } = db.run(
      `INSERT INTO maintenance_records (reference, equipment_id, schedule_id, performed_by, performed_on,
          started_at, completed_at, duration_minutes, findings, actions_taken, condition_found,
          due_on, days_late, next_due_on, downtime_minutes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ref, eqId, schedule?.id ?? null, actor.id, performedOn, data.startedAt ?? null, data.completedAt ?? null,
        duration, data.findings ?? null, data.actionsTaken ?? null,
        data.conditionFound ?? (failed.length ? 'needs_attention' : skipped ? 'needs_attention' : 'pass'),
        dueOn, daysLate, nextDue, data.downtimeMinutes ?? null, nowIso()],
    );
    const recordId = lastInsertRowid;

    for (const r of results) {
      const label = String(r.label ?? '').trim().slice(0, 300);
      const outcome = String(r.outcome ?? 'pass').toLowerCase();
      if (!label) continue;
      if (!['pass', 'fail', 'na'].includes(outcome)) throw badRequest(`Checklist outcome must be pass, fail or na (got “${outcome}”)`);
      db.run('INSERT INTO maintenance_record_checklist (record_id, item_id, label, outcome, note) VALUES (?,?,?,?,?)',
        [recordId, r.itemId ?? null, label, outcome, r.note ?? null]);
    }

    if (!skipped) {
      db.run(
        `UPDATE equipment SET last_maintenance_on = ?, next_maintenance_on = COALESCE(?, next_maintenance_on),
                updated_at = ?, updated_by = ? WHERE id = ?`,
        [performedOn, nextDue, nowIso(), actor.id, eqId],
      );
      if (schedule) {
        db.run('UPDATE maintenance_schedules SET last_done_on = ?, next_due_on = ?, updated_at = ? WHERE id = ?',
          [performedOn, nextDue ?? schedule.next_due_on, nowIso(), schedule.id]);
      }
    } else if (schedule) {
      // A missed visit does not buy the department a new due date: it stays overdue.
      db.run('UPDATE maintenance_schedules SET updated_at = ? WHERE id = ?', [nowIso(), schedule.id]);
    }

    audit({ actor, action: 'maintenance.record', entityType: 'maintenance_record', entityId: recordId, entityRef: ref,
      summary: `${skipped ? 'Missed' : 'Completed'} “${schedule?.title ?? 'ad-hoc inspection'}” on ${eq.asset_tag}`
        + (failed.length ? ` — ${failed.length} checklist item(s) FAILED` : '')
        + (daysLate > 0 ? ` — ${daysLate} day(s) late` : ''),
      after: { conditionFound: data.conditionFound ?? (failed.length ? 'needs_attention' : 'pass'), failedCount: failed.length, daysLate }, req });

    const watchers = [...new Set([...usersWithRole(db, 'admin', 'technician'),
      schedule?.responsible_technician_id].filter(Boolean))].filter((id) => id !== actor.id);
    if (failed.length || skipped) {
      notifyMany(db, watchers, {
        type: failed.length ? 'maintenance_overdue' : 'maintenance_due',
        severity: 'warning',
        title: failed.length ? `Maintenance found a fault on ${eq.asset_tag}` : `Maintenance missed on ${eq.asset_tag}`,
        body: failed.length
          ? `“${schedule?.title ?? 'Preventive maintenance'}” recorded ${failed.length} failed check(s): ${failed.map((f) => f.label).join('; ').slice(0, 200)}. Raise a fault report if work is needed.`
          : `“${schedule?.title ?? 'Preventive maintenance'}” was due ${dueOn ?? 'and is still open'}. Reason: ${String(data.findings).slice(0, 200)}`,
        link: `/equipment/${eqId}`, entityType: 'equipment', entityId: eqId,
      });
    }
    return recordDetail(db, recordId);
  });
}

export function recordDetail(db, id) {
  const row = db.get(
    `SELECT m.*, e.asset_tag, e.name AS equipment_name, u.full_name AS performed_by_name,
            s.title AS schedule_title, s.interval_days
       FROM maintenance_records m
       JOIN equipment e ON e.id = m.equipment_id
       JOIN users u ON u.id = m.performed_by
       LEFT JOIN maintenance_schedules s ON s.id = m.schedule_id
      WHERE m.id = ?`,
    [id],
  );
  if (!row) throw notFound('Maintenance record not found');
  const checklist = db.all('SELECT item_id, label, outcome, note FROM maintenance_record_checklist WHERE record_id = ? ORDER BY id', [id]);
  const attachments = db.all(
    `SELECT id, kind, filename, mime_type, size_bytes, caption FROM attachments
      WHERE owner_type = 'maintenance_record' AND owner_id = ? AND is_deleted = 0 ORDER BY id`,
    [id],
  );
  return shape({ ...row, checklist, attachments, failedChecklist: checklist.filter((c) => c.outcome === 'fail') });
}

export function listRecords(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.equipmentId) { where.push('m.equipment_id = ?'); params.push(filters.equipmentId); }
  if (filters.technicianId) { where.push('m.performed_by = ?'); params.push(filters.technicianId); }
  if (filters.from) { where.push('m.performed_on >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('m.performed_on <= ?'); params.push(filters.to); }
  if (filters.condition) { where.push('m.condition_found = ?'); params.push(filters.condition); }
  if (filters.lateOnly) where.push('m.days_late > 0');
  const per = Math.min(100, Math.max(1, filters.perPage ?? 25));
  const page = Math.max(1, filters.page ?? 1);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.value(`SELECT COUNT(*) FROM maintenance_records m ${whereSql}`, params) ?? 0;
  const rows = db.all(
    `SELECT m.id, m.reference, m.performed_on, m.due_on, m.days_late, m.condition_found, m.findings,
            m.actions_taken, m.duration_minutes, m.downtime_minutes,
            e.id AS equipment_id, e.asset_tag, e.name AS equipment_name, u.full_name AS performed_by_name,
            s.title AS schedule_title
       FROM maintenance_records m
       JOIN equipment e ON e.id = m.equipment_id
       JOIN users u ON u.id = m.performed_by
       LEFT JOIN maintenance_schedules s ON s.id = m.schedule_id
      ${whereSql} ORDER BY m.performed_on DESC, m.id DESC LIMIT ? OFFSET ?`,
    [...params, per, (page - 1) * per],
  );
  return { rows: rows.map(shape), pagination: { page, perPage: per, total, pages: Math.max(1, Math.ceil(total / per)) } };
}

/** Removing a PM record is an admin-only correction of a data-entry error, fully audited. */
export function deleteRecord(db, id, { reason }, actor, req) {
  if (!can(actor, 'meta.manage')) throw forbidden('Only an administrator may remove a maintenance record');
  if (!reason?.trim()) throw badRequest('A reason is required to remove a maintenance record', { fields: { reason: ['Required'] } });
  const rec = db.get('SELECT m.*, e.asset_tag FROM maintenance_records m JOIN equipment e ON e.id = m.equipment_id WHERE m.id = ?', [id]);
  if (!rec) throw notFound('Maintenance record not found');
  return db.tx(() => {
    db.run('DELETE FROM maintenance_record_checklist WHERE record_id = ?', [id]);
    db.run('DELETE FROM maintenance_records WHERE id = ?', [id]);
    // Recompute the asset's dates from what is left rather than trusting stale values.
    const last = db.get('SELECT MAX(performed_on) AS last_on FROM maintenance_records WHERE equipment_id = ?', [rec.equipment_id]);
    db.run('UPDATE equipment SET last_maintenance_on = ? WHERE id = ?', [last?.last_on ?? null, rec.equipment_id]);
    if (rec.schedule_id) db.run('UPDATE maintenance_schedules SET last_done_on = ? WHERE id = ?', [last?.last_on ?? null, rec.schedule_id]);
    syncEquipmentDates(db, rec.equipment_id);
    audit({ actor, action: 'maintenance.record_delete', entityType: 'maintenance_record', entityId: id,
      entityRef: rec.reference, summary: `Removed maintenance record ${rec.reference}: ${reason}`, before: rec, req });
    return { deleted: true };
  });
}

/* ---------------------------------------------------------------- planning -- */

/** Due/overdue board — one row per equipment, driven by its nearest active schedule. */
export function dueBoard(db, { days = 45, includeUpToDate = false } = {}) {
  const rows = db.all(
    `SELECT e.id AS equipment_id, e.asset_tag, e.name AS equipment_name, e.status AS equipment_status,
            e.criticality, e.next_maintenance_on, e.last_maintenance_on, e.maintenance_interval_days,
            u.full_name AS responsible_technician_name, l.name AS location_name,
            (SELECT s.title FROM maintenance_schedules s WHERE s.equipment_id = e.id AND s.is_active = 1
              ORDER BY julianday(s.next_due_on), s.id LIMIT 1) AS next_schedule_title,
            (SELECT COUNT(*) FROM maintenance_schedules s WHERE s.equipment_id = e.id AND s.is_active = 1) AS schedule_count,
            CAST(julianday(e.next_maintenance_on) - julianday('now') AS INTEGER) AS days_until_pm
       FROM equipment e
       LEFT JOIN users u ON u.id = e.responsible_technician_id
       LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.is_active = 1 AND e.status <> 'decommissioned'
        ${includeUpToDate ? '' : `AND e.next_maintenance_on IS NOT NULL AND julianday(e.next_maintenance_on) - julianday('now') <= ${days}`}
      ORDER BY julianday(e.next_maintenance_on), e.asset_tag`,
  );
  return rows.map((r) => shape({ ...r, pm_state: pmStateFor(r.next_maintenance_on) }));
}

/**
 * Compliance over a window.  Two honest numbers, because they answer different questions:
 *   • `onTimePercent`   — of the PMs performed in the window, how many were on/before their due date;
 *   • `fleetCompliancePercent` — how much of the live fleet is not overdue *today*.
 */
export function compliance(db, { days = 180 } = {}) {
  const windowStart = toDateOnly(addDays(todayDateOnly(), -days));
  const records = db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN days_late <= 0 THEN 1 ELSE 0 END) AS on_time,
            COALESCE(MAX(days_late), 0) AS worst_lateness_days,
            ROUND(AVG(days_late), 1) AS average_lateness_days
       FROM maintenance_records WHERE performed_on >= ?`,
    [windowStart],
  ) ?? {};
  const board = db.get(
    `SELECT
        SUM(CASE WHEN date(next_maintenance_on) < date('now') THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN date(next_maintenance_on) >= date('now')
                  AND julianday(next_maintenance_on) - julianday('now') <= ${DUE_SOON_DAYS} THEN 1 ELSE 0 END) AS due_soon,
        SUM(CASE WHEN julianday(next_maintenance_on) - julianday('now') > ${DUE_SOON_DAYS} THEN 1 ELSE 0 END) AS up_to_date,
        COUNT(*) AS scheduled
      FROM equipment WHERE is_active = 1 AND status <> 'decommissioned' AND next_maintenance_on IS NOT NULL`,
  ) ?? {};
  const active = db.value(`SELECT COUNT(*) FROM equipment WHERE is_active = 1 AND status <> 'decommissioned'`) ?? 0;

  return shape({
    windowDays: days,
    windowStart,
    recordsDone: records.total ?? 0,
    recordsOnTime: records.on_time ?? 0,
    onTimePercent: records.total ? Math.round(((records.on_time ?? 0) / records.total) * 100) : null,
    averageLatenessDays: records.total ? records.average_lateness_days : null,
    worstLatenessDays: records.worst_lateness_days ?? 0,
    overdueEquipment: board.overdue ?? 0,
    dueSoonEquipment: board.due_soon ?? 0,
    upToDateEquipment: board.up_to_date ?? 0,
    scheduledEquipment: board.scheduled ?? 0,
    unscheduledEquipment: Math.max(0, active - (board.scheduled ?? 0)),
    fleetCompliancePercent: active ? Math.round(((active - (board.overdue ?? 0)) / active) * 100) : 100,
  });
}
