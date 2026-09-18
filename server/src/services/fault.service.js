import { getDb, nextSequence } from '../lib/db.js';
import { shape } from '../lib/shape.js';
import { nowIso, addHours, minutesBetween, parseDate } from '../lib/time.js';
import { reference as makeReference } from '../lib/tokens.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { can } from '../auth/capabilities.js';
import { notifyMany, usersWithRole, equipmentWatchers } from './notification.service.js';
import { deriveEquipmentStatus, OPEN_FAULT_STATUSES, resolveEquipment } from './equipment.service.js';

/* ------------------------------------------------------------- vocabulary --- */

export const FAULT_STATUSES = [
  'reported', 'assigned', 'acknowledged', 'under_inspection', 'under_repair',
  'awaiting_parts', 'repaired', 'verified', 'closed',
];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'];

export const STATUS_META = {
  reported: { label: 'Reported', tone: 'warn', step: 1 },
  assigned: { label: 'Assigned', tone: 'info', step: 2 },
  acknowledged: { label: 'Acknowledged', tone: 'info', step: 3 },
  under_inspection: { label: 'Under Inspection', tone: 'info', step: 4 },
  under_repair: { label: 'Under Repair', tone: 'warn', step: 5 },
  awaiting_parts: { label: 'Awaiting Parts', tone: 'warn', step: 6 },
  repaired: { label: 'Repaired', tone: 'ok', step: 7 },
  verified: { label: 'Verified', tone: 'ok', step: 8 },
  closed: { label: 'Closed', tone: 'neutral', step: 9 },
};

/**
 * Allowed next states.  Not every fault walks every step — `reported → under_inspection`
 * (bench fix) and `reported → closed` (duplicate / not a fault) are both legal, but the
 * workflow cannot be *entered* from an arbitrary state, and `closed` is only left through
 * the explicit, audited reopen action.
 */
export const TRANSITIONS = {
  reported: ['assigned', 'acknowledged', 'under_inspection', 'closed'],
  // A technician who already knows the fix may go straight to the bench: an obvious part
  // failure does not need a separate "inspection" row just to satisfy the form.
  assigned: ['acknowledged', 'under_inspection', 'under_repair', 'closed'],
  acknowledged: ['under_inspection', 'under_repair', 'closed'],
  // No `closed` from here: worked faults end at Repaired or Verified (see canTransition).
  under_inspection: ['under_repair', 'awaiting_parts', 'repaired', 'verified', 'assigned'],
  under_repair: ['awaiting_parts', 'repaired', 'under_inspection'],
  awaiting_parts: ['under_repair', 'repaired'],
  repaired: ['verified', 'under_repair'],
  verified: ['closed', 'under_repair'],
  closed: [],
};

/** Which stages require the technician role (accountability rule from §4 of the brief). */
const TECHNICAL_STAGES = new Set(['under_inspection', 'under_repair', 'awaiting_parts', 'repaired']);
const STAGES_REQUIRING_ASSIGNMENT = new Set(['acknowledged', 'under_inspection', 'under_repair', 'awaiting_parts', 'repaired']);

/** Default response targets, hours from report, per severity. Overridable in settings. */
export const DEFAULT_SLA_HOURS = { critical: 4, high: 24, medium: 72, low: 168 };

/** `?,?,?` placeholder list bound to `arr` — never interpolate values into SQL. */
export const ph = (arr) => arr.map(() => '?').join(',');

export const statusLabel = (s) => STATUS_META[s]?.label ?? s;

export function settingsValue(db, key, fallback) {
  const row = db.get('SELECT value, value_type FROM app_settings WHERE key = ?', [key]);
  if (!row) return fallback;
  if (row.value_type === 'int') return Number.parseInt(row.value, 10);
  if (row.value_type === 'float') return Number.parseFloat(row.value);
  if (row.value_type === 'bool') return row.value === '1';
  if (row.value_type === 'json') { try { return JSON.parse(row.value); } catch { return fallback; } }
  return row.value;
}

const slaHours = (db, severity) => ({ ...DEFAULT_SLA_HOURS, ...(settingsValue(db, 'sla_hours', {}) || {}) })[severity] ?? null;

/* ---------------------------------------------------------------- helpers --- */

const FAULT_SELECT = `
  SELECT f.*,
         e.asset_tag, e.name AS equipment_name, e.status AS equipment_status,
         e.criticality, l.name AS location_name,
         cat.name AS category_name,
         rep.full_name AS reported_by_name, rep.department AS reported_by_department,
         asg.full_name AS assigned_to_name, asg.job_title AS assigned_to_title,
         ver.full_name AS verified_by_name,
         rr.id AS repair_record_id, rr.reference AS repair_reference,
         (SELECT COUNT(*) FROM attachments a WHERE a.owner_type='fault_report' AND a.owner_id=f.id) AS attachment_count,
         (SELECT COUNT(*) FROM fault_status_history h WHERE h.fault_id=f.id) AS history_count,
         CASE WHEN f.status IN ('repaired','verified','closed') THEN NULL
              WHEN f.due_at IS NULL THEN 0
              WHEN datetime(f.due_at) < datetime('now')
                THEN CAST((julianday('now') - julianday(f.due_at)) * 24 * 60 AS INTEGER)
              ELSE -1 END AS minutes_overdue,
         CASE WHEN f.assigned_at IS NULL THEN NULL
              ELSE CAST((julianday(f.assigned_at) - julianday(f.created_at)) * 24 * 60 AS INTEGER) END AS minutes_to_assign,
         CASE WHEN f.repaired_at IS NULL THEN NULL
              ELSE CAST((julianday(f.repaired_at) - julianday(f.created_at)) * 24 * 60 AS INTEGER) END AS minutes_to_repair,
         CASE WHEN f.closed_at IS NULL THEN NULL
              ELSE CAST((julianday(f.closed_at) - julianday(f.created_at)) * 24 * 60 AS INTEGER) END AS minutes_to_close
    FROM fault_reports f
    JOIN equipment e ON e.id = f.equipment_id
    LEFT JOIN fault_categories cat ON cat.id = f.category_id
    LEFT JOIN locations l ON l.id = f.location_id
    LEFT JOIN users rep ON rep.id = f.reported_by
    LEFT JOIN users asg ON asg.id = f.assigned_to
    LEFT JOIN users ver ON ver.id = f.verified_by
    LEFT JOIN repair_records rr ON rr.fault_id = f.id`;

const decorate = (row) => shape({
  ...row,
  status_label: STATUS_META[row.status]?.label ?? row.status,
  status_tone: STATUS_META[row.status]?.tone ?? 'neutral',
  workflow_step: STATUS_META[row.status]?.step ?? null,
  is_open: OPEN_FAULT_STATUSES.includes(row.status),
  is_overdue: row.minutes_overdue !== null && row.minutes_overdue !== -1 && row.minutes_overdue > 0,
});

export function getFault(db, id, user) {
  const row = db.get(`${FAULT_SELECT} WHERE f.id = ?`, [id]);
  if (!row) throw notFound('Fault report not found');
  if (!canSee(db, row, user)) {
    throw forbidden('You may only view fault reports you filed or that are assigned to you');
  }
  return row;
}

function canSee(db, row, user) {
  if (can(user, 'fault.view.any')) return true;
  if (!user) return false;
  return row.reported_by === user.id || row.assigned_to === user.id;
}

/* ----------------------------------------------------------------- create --- */

export function createFault(db, data, actor, req) {
  const equipment = resolveEquipment(db, data.equipmentId);
  if (equipment.status === 'decommissioned') {
    throw conflict(`${equipment.name} is decommissioned, so it has no fault workflow. Contact the administrator if this is an error.`);
  }
  const category = data.categoryId
    ? db.get('SELECT id FROM fault_categories WHERE id = ? AND is_active = 1', [data.categoryId])
    : db.get('SELECT id FROM fault_categories WHERE code = ? AND is_active = 1', [String(data.categoryCode ?? 'other').toUpperCase()]);
  if (!category) throw badRequest('Choose a valid fault category', { fields: { categoryId: ['Required'] } });

  const severity = data.severity ?? category.default_severity ?? 'medium';
  const observedAt = data.observedAt ?? nowIso();
  if (parseDate(observedAt) && parseDate(observedAt).getTime() > Date.now() + 15 * 60_000) {
    throw badRequest('The observed time cannot be in the future', { fields: { observedAt: ['Check the date and time'] } });
  }
  const sla = slaHours(db, severity);
  const created = nowIso();
  const dueAt = sla ? addHours(observedAt, sla).toISOString().slice(0, 19) + 'Z' : null;

  return db.tx(() => {
    const seq = nextSequence(db, `fault:${new Date().getUTCFullYear()}`);
    const ref = makeReference('FLT', new Date().getUTCFullYear(), seq);
    const { lastInsertRowid } = db.run(
      `INSERT INTO fault_reports (reference, equipment_id, reported_by, on_behalf_of, category_id, location_id,
          title, description, severity, observed_at, status, due_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'reported', ?, ?)`,
      [ref, equipment.id, actor.id, data.onBehalfOf ?? null, category.id,
        data.locationId ?? equipment.locationId ?? null, data.title.trim(), data.description.trim(),
        severity, observedAt, dueAt, created],
    );
    const faultId = lastInsertRowid;
    db.run(
      `INSERT INTO fault_status_history (fault_id, from_status, to_status, comment, auto_action, changed_by, changed_at)
       VALUES (?, NULL, 'reported', ?, 1, ?, ?)`,
      [faultId, `Reported by ${actor.fullName} (severity: ${severity}${dueAt ? `, respond by ${dueAt.slice(0, 16)}Z` : ''})`, actor.id, created],
    );
    // The device is now known-bad; reflect that on the asset record before anything else reads it.
    deriveEquipmentStatus(db, equipment.id, { actor, faultId, reason: `Fault report ${ref} submitted`, req });

    audit({ actor, action: 'fault.create', entityType: 'fault_report', entityId: faultId, entityRef: ref,
      summary: `${severity.toUpperCase()} fault reported on ${equipment.assetTag}: ${data.title}`,
      after: { equipment: equipment.assetTag, severity, category: category.id }, req });

    dispatchOnCreate(db, { faultId, ref, equipment, severity, title: data.title, actor });
    return faultDetail(db, faultId, actor);
  });
}

function dispatchOnCreate(db, { faultId, ref, equipment, severity, title, actor }) {
  const body = `${equipment.name} (${equipment.assetTag}) — ${title}`;
  const link = `/faults/${faultId}`;
  if (severity === 'critical') {
    const recipients = [...usersWithRole(db, 'admin', 'technician')].filter((id) => id !== actor.id);
    notifyMany(db, recipients, {
      type: 'fault_critical', severity: 'critical', title: `CRITICAL fault ${ref}`,
      body: `${body}\nResponse target: within ${slaHours(db, 'critical')} h.`, link,
      entityType: 'fault_report', entityId: faultId,
    });
  }
  // The technician who owns the asset should hear about it even at lower severities.
  const watchers = equipmentWatchers(db, equipment.id, { includeCustodianTech: true })
    .filter((id) => id !== actor.id);
  if (severity !== 'critical') {
    notifyMany(db, watchers, { type: 'fault_assigned', severity: 'info', title: `New fault on your equipment — ${ref}`,
      body, link, entityType: 'fault_report', entityId: faultId });
  }
}

/* -------------------------------------------------------------- assignment -- */

export function assignFault(db, faultId, { technicianId, note, alsoTransition = true }, actor, req) {
  const fault = getFaultOrThrow(db, faultId);
  if (!can(actor, 'fault.assign') && !(can(actor, 'fault.selfAssign') && technicianId === actor.id)) {
    throw forbidden('Only an administrator can assign technicians; a technician may claim an unassigned fault');
  }
  if (fault.status === 'closed' || fault.status === 'verified' || fault.status === 'repaired') {
    throw conflict(`This fault is already ${statusLabel(fault.status)} and cannot be assigned`);
  }
  if (!technicianId) throw badRequest('Select a technician', { fields: { technicianId: ['Required'] } });
  const tech = db.get(
    `SELECT u.id, u.full_name, u.is_active, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [technicianId],
  );
  if (!tech) throw badRequest('Unknown technician', { fields: { technicianId: ['No such user'] } });
  if (!tech.is_active) throw badRequest('That technician account is deactivated');
  if (!['technician', 'admin'].includes(tech.role)) {
    throw badRequest(`${tech.full_name} holds the ${tech.role} role and cannot be assigned repair work`);
  }

  const previousAssignee = fault.assigned_to;
  return db.tx(() => {
    const at = nowIso();
    const newStatus = alsoTransition && fault.status === 'reported' ? 'assigned' : fault.status;
    db.run(
      `UPDATE fault_reports SET assigned_to = ?, assigned_by = ?, assigned_at = ?, status = ?, updated_at = ? WHERE id = ?`,
      [technicianId, actor.id, fault.assigned_at ?? at, newStatus, at, faultId],
    );
    if (newStatus !== fault.status) {
      db.run(
        `INSERT INTO fault_status_history (fault_id, from_status, to_status, comment, auto_action, changed_by, changed_at)
         VALUES (?,?,?,?,0,?,?)`,
        [faultId, fault.status, newStatus, note || `Assigned to ${tech.full_name}`, actor.id, at],
      );
    } else {
      db.run(
        `INSERT INTO fault_status_history (fault_id, from_status, to_status, comment, auto_action, changed_by, changed_at)
         VALUES (?,?,?,?,0,?,?)`,
        [faultId, fault.status, fault.status, note ? `Reassignment note: ${note}` : `Reassigned to ${tech.full_name}`, actor.id, at],
      );
    }
    audit({ actor, action: 'fault.assign', entityType: 'fault_report', entityId: faultId, entityRef: fault.reference,
      summary: `${previousAssignee ? 'Reassigned' : 'Assigned'} to ${tech.full_name}`,
      before: { assignedTo: previousAssignee, status: fault.status }, after: { assignedTo: technicianId, status: newStatus }, req });

    notifyMany(db, [technicianId], {
      type: 'fault_assigned',
      severity: fault.severity === 'critical' ? 'critical' : 'info',
      title: `You are assigned ${fault.reference}${newStatus === 'assigned' ? '' : ' (reassigned)'}`,
      body: `${fault.title}\n${fault.equipment_name} (${fault.asset_tag}) — severity ${fault.severity}`,
      link: `/faults/${faultId}`, entityType: 'fault_report', entityId: faultId,
    });
    return faultDetail(db, faultId, actor);
  });
}

/* -------------------------------------------------------------- transitions -- */

function getFaultOrThrow(db, id) {
  const row = db.get(
    `SELECT f.*, e.asset_tag, e.name AS equipment_name FROM fault_reports f
      JOIN equipment e ON e.id = f.equipment_id WHERE f.id = ?`,
    [id],
  );
  if (!row) throw notFound('Fault report not found');
  return row;
}

/**
 * The complete authorisation decision for one move, in one place, so it can be read and
 * reviewed as a unit.  Returns {allowed:boolean, reason:string}.
 */
export function canTransition(user, fault, toStatus) {
  const isAdmin = user.roleCode === 'admin';
  const isTech = user.roleCode === 'technician';
  const isReporter = user.roleCode === 'reporter';
  const isAssigned = fault.assigned_to === user.id;
  const isUnassigned = !fault.assigned_to;

  if (!FAULT_STATUSES.includes(toStatus)) return { allowed: false, reason: `Unknown workflow state “${toStatus}”.` };
  if (toStatus === fault.status) return { allowed: false, reason: `This fault is already ${statusLabel(toStatus)}.` };

  // Role first, then adjacency: telling a reporter "technical stages require the technician
  // role" is actionable, whereas "that move is not in the workflow" hides the real reason.
  if (TECHNICAL_STAGES.has(toStatus) && !isTech && !isAdmin) {
    return { allowed: false, reason: 'Technical stages (inspection, repair, parts) require the technician role. Report what you observe and an administrator will assign someone.' };
  }
  if (TRANSITIONS[fault.status].includes(toStatus) === false) {
    const open = TRANSITIONS[fault.status];
    return {
      allowed: false,
      reason: open.length
        ? `“${statusLabel(fault.status)}” cannot move directly to “${statusLabel(toStatus)}”. From here the next steps are: ${open.map(statusLabel).join(', ')}.`
        : `“${statusLabel(fault.status)}” is a final state; an administrator must reopen the fault.`,
      allowedNext: open,
    };
  }

  if (toStatus === 'assigned') {
    return can(user, 'fault.assign')
      ? { allowed: true }
      : { allowed: false, reason: 'Only an administrator can assign a fault. A technician may pick up an unassigned one.' };
  }
  if (toStatus === 'closed') {
    const untouched = ['reported', 'assigned', 'acknowledged'].includes(fault.status);
    if (untouched) {
      // Nothing has been recorded yet, so closing means "not a fault / duplicate" — an
      // administrative triage decision, not something the reporter or a queue-clear can do.
      return isAdmin
        ? { allowed: true }
        : { allowed: false, reason: 'No work has been recorded on this fault, so only an administrator can close it as a duplicate or no-fault report.' };
    }
    if (['under_inspection', 'under_repair', 'awaiting_parts'].includes(fault.status)) {
      return {
        allowed: false,
        reason: 'A fault that has been worked cannot be closed directly: record the repair and move it to Repaired, or to Verified if nothing was wrong with the equipment.',
      };
    }
    return isAdmin || isTech
      ? { allowed: true }
      : { allowed: false, reason: 'Faults are closed by a technician or an administrator after verification.' };
  }
  if (toStatus === 'verified') {
    if (isAdmin || isTech) return { allowed: true };
    if (isReporter && fault.reported_by === user.id) return { allowed: true, hint: 'You are confirming the fix you asked for.' };
    return { allowed: false, reason: 'Verification is done by a technician, an administrator, or the person who reported the fault.' };
  }

  // Every remaining move is workshop progress: the owner, an admin, or the technician who
  // takes ownership of an unassigned fault (recorded as a self-assignment).
  if (STAGES_REQUIRING_ASSIGNMENT.has(toStatus) && !isAssigned && !isAdmin && !(isTech && isUnassigned)) {
    return { allowed: false, reason: 'This fault is assigned to someone else. Ask an administrator to reassign it.' };
  }
  if (toStatus === 'repaired' && !isAssigned && !isAdmin) {
    return { allowed: false, reason: 'Only the assigned technician records a completed repair.' };
  }
  return { allowed: true };
}

export function transitionFault(db, faultId, { toStatus, comment, selfAssign = true }, actor, req) {
  const fault = getFaultOrThrow(db, faultId);
  if (!toStatus) throw badRequest('targetStatus is required', { fields: { toStatus: ['Required'] } });
  if (!FAULT_STATUSES.includes(toStatus)) throw badRequest(`Unknown workflow state: ${toStatus}`);
  if (toStatus === fault.status) throw badRequest('The fault is already in that state');

  const decision = canTransition(actor, fault, toStatus);
  if (!decision.allowed) throw forbidden(decision.reason, { from: fault.status, to: toStatus });

  // A technician picking up an unassigned fault becomes its owner — recorded as an
  // auto-assignment so the chain of accountability has no gaps.
  let assignedTo = fault.assigned_to;
  let selfClaimed = false;
  if (!assignedTo && STAGES_REQUIRING_ASSIGNMENT.has(toStatus) && selfAssign && actor.roleCode === 'technician') {
    assignedTo = actor.id;
    selfClaimed = true;
  }

  if (toStatus === 'repaired') assertRepairRecordComplete(db, fault.id);
  if (toStatus === 'verified') {
    // Verification means "a qualified person checked the work".  A technician may verify
    // straight from inspection when nothing was wrong with the device, but then that
    // judgement still has to be written down as a repair record ("no fault found").
    const hasRepair = db.value('SELECT COUNT(*) FROM repair_records WHERE fault_id = ?', [fault.id]) > 0;
    if (!hasRepair && fault.status !== 'repaired') {
      throw conflict('A technician must record a repair entry (even “no fault found”) before this fault can be verified');
    }
  }

  return db.tx(() => {
    const at = nowIso();
    const sets = ['status = ?', 'updated_at = ?'];
    const params = [toStatus, at];
    if (selfClaimed) { sets.push('assigned_to = ?', 'assigned_by = ?', 'assigned_at = ?'); params.push(actor.id, actor.id, fault.assigned_at ?? at); }
    if (toStatus === 'acknowledged') { sets.push('acknowledged_at = ?'); params.push(at); }
    if (toStatus === 'repaired') { sets.push('repaired_at = ?'); params.push(at); }
    if (toStatus === 'verified') { sets.push('verified_by = ?', 'verified_at = ?'); params.push(actor.id, at); }
    if (toStatus === 'closed') {
      sets.push('closed_at = ?', 'verified_by = COALESCE(verified_by, ?)', 'verified_at = COALESCE(verified_at, ?)');
      params.push(at, actor.id, at);
      if (comment) { sets.push('resolution_note = ?'); params.push(comment); }
    }
    db.run(`UPDATE fault_reports SET ${sets.join(', ')} WHERE id = ?`, [...params, faultId]);

    db.run(
      `INSERT INTO fault_status_history (fault_id, from_status, to_status, comment, auto_action, changed_by, changed_at)
       VALUES (?,?,?,?,?,?,?)`,
      [faultId, fault.status, toStatus, comment || defaultComment(toStatus, actor, selfClaimed) || null,
        selfClaimed ? 1 : 0, actor.id, at],
    );
    if (toStatus === 'repaired') {
      db.run('UPDATE fault_reports SET diagnosis_confirmed = 1 WHERE id = ? AND diagnosis_confirmed = 0', [faultId]);
    }

    const derived = deriveEquipmentStatus(db, fault.equipment_id, {
      actor, faultId, req,
      reason: `Fault ${fault.reference} → ${statusLabel(toStatus)}`,
    });

    audit({ actor, action: 'fault.transition', entityType: 'fault_report', entityId: faultId, entityRef: fault.reference,
      summary: `${statusLabel(fault.status)} → ${statusLabel(toStatus)}${selfClaimed ? ' (self-assigned)' : ''}`,
      before: { status: fault.status, assignedTo: fault.assigned_to }, after: { status: toStatus, assignedTo, equipmentStatus: derived.status }, req });

    notifyOnTransition(db, { fault, toStatus, actor, comment, at });
    return faultDetail(db, faultId, actor);
  });
}

const defaultComment = (toStatus, actor, selfClaimed) => {
  if (toStatus === 'acknowledged') return 'Acknowledged by technician';
  if (toStatus === 'verified') return `Verified by ${actor.fullName}`;
  if (toStatus === 'closed') return 'Closed';
  if (selfClaimed) return `Picked up by ${actor.fullName}`;
  return null;
};

function notifyOnTransition(db, { fault, toStatus, actor, comment, at }) {
  const link = `/faults/${fault.id}`;
  const recipients = new Set();
  if (fault.reported_by !== actor.id) recipients.add(fault.reported_by);
  if (fault.assigned_to && fault.assigned_to !== actor.id) recipients.add(fault.assigned_to);

  const type = toStatus === 'repaired' ? 'repair_completed' : 'fault_status_changed';
  const titleMap = {
    repaired: `Your fault ${fault.reference} has been repaired`,
    verified: `Fault ${fault.reference} verified`,
    closed: `Fault ${fault.reference} closed`,
    under_repair: `Repair started on ${fault.reference}`,
    awaiting_parts: `Awaiting parts — ${fault.reference}`,
    under_inspection: `Inspection started — ${fault.reference}`,
    acknowledged: `Fault ${fault.reference} acknowledged`,
    assigned: `Fault ${fault.reference} assigned`,
  };
  if (toStatus === 'closed' || toStatus === 'verified') {
    for (const id of usersWithRole(db, 'admin')) if (id !== actor.id) recipients.add(id);
  }
  notifyMany(db, [...recipients], {
    type,
    severity: toStatus === 'repaired' ? 'success' : 'info',
    title: titleMap[toStatus] ?? `Fault ${fault.reference} is now ${statusLabel(toStatus)}`,
    body: [
      `${fault.equipment_name} (${fault.asset_tag})`,
      comment ? `Note: ${comment}` : null,
      toStatus === 'repaired' ? 'Please confirm the equipment works as expected so the report can be closed.' : null,
      `Changed ${at.slice(0, 16)}Z by ${actor.fullName}`,
    ].filter(Boolean).join('\n'),
    link, entityType: 'fault_report', entityId: fault.id,
  });
}

/**
 * Gate for "repaired": the equipment only leaves the workshop once the repair record
 * actually says what was wrong, what was done, and how it was proven to work.
 */
export function assertRepairRecordComplete(db, faultId) {
  const r = db.get('SELECT * FROM repair_records WHERE fault_id = ?', [faultId]);
  if (!r) {
    throw conflict('Record the repair (diagnosis, actions, test results) before marking this fault Repaired', {
      missing: ['repairRecord'],
    });
  }
  const missing = [];
  if (!r.diagnosis?.trim()) missing.push('diagnosis');
  if (!r.root_cause?.trim()) missing.push('rootCause');
  if (!r.repair_actions?.trim()) missing.push('repairActions');
  if (!r.test_results?.trim()) missing.push('testResults');
  if (!r.date_repaired) missing.push('dateRepaired');
  if (!r.safety_check_confirmed) missing.push('safetyCheckConfirmed');
  if (missing.length) {
    throw conflict('The repair record is incomplete', { missing });
  }
  if (!r.safe_to_return_to_service) {
    throw conflict('The repair record states this equipment is NOT safe to return to service. Set it Out of Service or plan a follow-up instead of closing the fault.');
  }
  return r;
}

/**
 * A reporter may correct their own report only until someone starts work on it
 * (`status = 'reported'`); an administrator may do the same, to fix data-entry errors.
 * The equipment status and the SLA clock are re-derived, so an edit can never leave the
 * asset showing "reported fault" for a description that no longer says it is broken.
 */
export function updateFault(db, faultId, data, actor, req) {
  const fault = getFaultOrThrow(db, faultId);
  const isOwner = fault.reported_by === actor.id;
  // Access is decided before state, so a non-owner cannot probe which stage a report is in.
  if (!isOwner && !can(actor, 'fault.view.any')) {
    throw forbidden('You may only edit fault reports you submitted');
  }
  if (fault.status !== 'reported') {
    throw conflict('This report has entered the workflow, so it can no longer be edited. Add a timeline note instead.');
  }

  return db.tx(() => {
    const sets = [];
    const params = [];
    const before = {};
    const after = {};
    const map = {
      title: 'title', description: 'description', severity: 'severity', locationId: 'location_id',
      observedAt: 'observed_at', onBehalfOf: 'on_behalf_of',
    };
    for (const [field, column] of Object.entries(map)) {
      if (data[field] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(data[field]);
      before[column] = fault[column];
      after[column] = data[field];
    }
    if (data.categoryId !== undefined) {
      const cat = db.get('SELECT id FROM fault_categories WHERE id = ? AND is_active = 1', [data.categoryId]);
      if (!cat) throw badRequest('Unknown fault category', { fields: { categoryId: ['No such category'] } });
      sets.push('category_id = ?');
      params.push(cat.id);
    }
    if (data.severity !== undefined && data.severity !== fault.severity) {
      const sla = slaHours(db, data.severity);
      const dueAt = sla ? addHours(data.observedAt ?? fault.observed_at, sla).toISOString().slice(0, 19) + 'Z' : null;
      sets.push('due_at = ?');
      params.push(dueAt);
      after.dueAt = dueAt;
    }
    if (!sets.length) return faultDetail(db, faultId, actor);
    sets.push('updated_at = ?');
    params.push(nowIso());
    db.run(`UPDATE fault_reports SET ${sets.join(', ')} WHERE id = ?`, [...params, faultId]);
    db.run(
      `INSERT INTO fault_status_history (fault_id, from_status, to_status, comment, auto_action, changed_by, changed_at)
       VALUES (?,?,?,?,0,?,?)`,
      [faultId, fault.status, fault.status, `Report amended by ${actor.fullName} before triage`, actor.id, nowIso()],
    );
    audit({ actor, action: 'fault.update', entityType: 'fault_report', entityId: faultId, entityRef: fault.reference,
      summary: `Amended ${Object.keys(after).join(', ') || 'report'}`, before, after, req });
    return faultDetail(db, faultId, actor);
  });
}

/** Timeline note (reporter follow-up / technician remark). Never changes status. */
export function addNote(db, faultId, { comment }, actor, req) {
  const fault = getFaultOrThrow(db, faultId);
  if (!comment?.trim()) throw badRequest('Write a short note first', { fields: { comment: ['Required'] } });
  if (!(can(actor, 'fault.comment') || can(actor, 'fault.view.any') || fault.assigned_to === actor.id)) {
    throw forbidden('You may not add notes to this fault report');
  }
  const at = nowIso();
  db.run(
    `INSERT INTO fault_status_history (fault_id, from_status, to_status, comment, auto_action, changed_by, changed_at)
     VALUES (?,?,?,?,0,?,?)`,
    [faultId, fault.status, fault.status, comment.trim(), actor.id, at],
  );
  audit({ actor, action: 'fault.note', entityType: 'fault_report', entityId: faultId, entityRef: fault.reference,
    summary: 'Timeline note added', req });
  const recipients = new Set([fault.reported_by, fault.assigned_to].filter((id) => id && id !== actor.id));
  notifyMany(db, [...recipients], {
    type: 'fault_status_changed', severity: 'info', title: `New note on ${fault.reference}`,
    body: comment.trim().slice(0, 280), link: `/faults/${faultId}`, entityType: 'fault_report', entityId: faultId,
  });
  return faultDetail(db, faultId, actor);
}

export function reopenFault(db, faultId, { comment, reason }, actor, req) {
  if (!can(actor, 'fault.reopen')) throw forbidden('Only an administrator can reopen a closed fault');
  const fault = getFaultOrThrow(db, faultId);
  if (!['closed', 'verified'].includes(fault.status)) {
    throw conflict(`Only a closed or verified fault can be reopened (currently ${statusLabel(fault.status)})`);
  }
  if (!comment?.trim()) throw badRequest('A reason is required to reopen a fault', { fields: { comment: ['Required'] } });
  return db.tx(() => {
    const at = nowIso();
    db.run(
      `UPDATE fault_reports SET status = 'under_inspection', closed_at = NULL, verified_by = NULL, verified_at = NULL,
              repaired_at = NULL, updated_at = ? WHERE id = ?`,
      [at, faultId],
    );
    db.run(
      `INSERT INTO fault_status_history (fault_id, from_status, to_status, comment, auto_action, changed_by, changed_at)
       VALUES (?,?, 'under_inspection', ?, 1, ?, ?)`,
      [faultId, fault.status, `REOPENED — ${reason ? `${reason}: ` : ''}${comment.trim()}`, actor.id, at],
    );
    deriveEquipmentStatus(db, fault.equipment_id, { actor, faultId, reason: `Fault ${fault.reference} reopened`, req });
    audit({ actor, action: 'fault.reopen', entityType: 'fault_report', entityId: faultId, entityRef: fault.reference,
      summary: `Reopened: ${comment.trim()}`, before: { status: fault.status }, after: { status: 'under_inspection' }, req });
    if (fault.assigned_to) {
      notifyMany(db, [fault.assigned_to], { type: 'fault_assigned', severity: 'warning',
        title: `Reopened ${fault.reference}`, body: comment.trim(), link: `/faults/${faultId}`,
        entityType: 'fault_report', entityId: faultId });
    }
    return faultDetail(db, faultId, actor);
  });
}

export const canUserTransition = (db, fault, user) => {
  const out = {};
  for (const to of FAULT_STATUSES) {
    const d = canTransition(user, fault, to);
    if (d.allowed) out[to] = { label: statusLabel(to), hint: null };
  }
  return Object.entries(out).map(([value, v]) => ({ value, label: v.label }));
};

/* ------------------------------------------------------------------ reads --- */

export function listFaults(db, filters = {}, user = {}) {
  const where = [];
  const params = [];
  const f = filters;

  if (!can(user, 'fault.view.any')) {
    where.push('f.reported_by = ?');
    params.push(user.id);
  } else if (f.scope === 'mine') {
    where.push('(f.reported_by = ? OR f.assigned_to = ?)');
    params.push(user.id, user.id);
  } else if (f.scope === 'assigned') {
    where.push('f.assigned_to = ?');
    params.push(user.id);
  }
  // Scope also constrains the workflow stage, and it must be the same list in the
  // page query and the COUNT query or the pager would lie.
  if (f.scope === 'unassigned') {
    where.push(`f.assigned_to IS NULL AND f.status IN (${ph(OPEN_FAULT_STATUSES)})`);
    params.push(...OPEN_FAULT_STATUSES);
  } else if (['open', 'assigned', 'mine'].includes(f.scope)) {
    where.push(`f.status IN (${ph(OPEN_FAULT_STATUSES)})`);
    params.push(...OPEN_FAULT_STATUSES);
  }

  if (f.q) {
    const like = `%${f.q}%`;
    where.push('(f.reference LIKE ? OR f.title LIKE ? OR f.description LIKE ? OR e.asset_tag LIKE ? OR e.name LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (f.status) { where.push('f.status = ?'); params.push(f.status); }
  if (f.severity) { where.push('f.severity = ?'); params.push(f.severity); }
  if (f.categoryId) { where.push('f.category_id = ?'); params.push(f.categoryId); }
  if (f.equipmentId) { where.push('f.equipment_id = ?'); params.push(f.equipmentId); }
  if (f.technicianId) { where.push('f.assigned_to = ?'); params.push(f.technicianId); }
  if (f.reporterId) { where.push('f.reported_by = ?'); params.push(f.reporterId); }
  if (f.locationId) { where.push('f.location_id = ?'); params.push(f.locationId); }
  if (f.unassigned) where.push('f.assigned_to IS NULL');
  if (f.overdue) where.push("f.due_at IS NOT NULL AND datetime(f.due_at) < datetime('now') AND f.status NOT IN ('repaired','verified','closed')");
  if (f.from) { where.push('date(f.created_at) >= date(?)'); params.push(f.from); }
  if (f.to) { where.push('date(f.created_at) <= date(?)'); params.push(f.to); }

  const sortMap = { createdAt: 'datetime(f.created_at)', severity: "CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END",
    dueAt: 'datetime(f.due_at)', status: 'f.status', updatedAt: 'datetime(f.updated_at)', equipment: 'e.name' };
  const sort = sortMap[f.sort] ?? 'datetime(f.created_at)';
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const per = Math.min(100, Math.max(1, f.perPage ?? 25));
  const page = Math.max(1, f.page ?? 1);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.value(
    `SELECT COUNT(*) FROM fault_reports f JOIN equipment e ON e.id = f.equipment_id ${whereSql}`,
    params,
  ) ?? 0;
  const rows = db.all(`${FAULT_SELECT} ${whereSql} ORDER BY ${sort} ${dir}, f.id DESC LIMIT ? OFFSET ?`,
    [...params, per, (page - 1) * per]);
  return {
    rows: rows.map(decorate),
    pagination: { page, perPage: per, total, pages: Math.max(1, Math.ceil(total / per)) },
  };
}

export function faultDetail(db, id, user) {
  const raw = getFault(db, id, user);
  const history = db.all(
    `SELECT h.id, h.from_status, h.to_status, h.comment, h.auto_action, h.changed_at,
            u.full_name AS changed_by_name, u.role_id
       FROM fault_status_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.fault_id = ? ORDER BY datetime(h.changed_at), h.id`,
    [raw.id],
  );
  const attachments = db.all(
    `SELECT a.id, a.kind, a.filename, a.mime_type, a.size_bytes, a.caption, a.created_at,
            u.full_name AS uploaded_by_name
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.owner_type = 'fault_report' AND a.owner_id = ? AND a.is_deleted = 0 ORDER BY a.id`,
    [raw.id],
  );
  const repair = db.get(
    `SELECT r.*, u.full_name AS technician_name FROM repair_records r
      LEFT JOIN users u ON u.id = r.technician_id WHERE r.fault_id = ?`,
    [raw.id],
  );
  const repairParts = repair
    ? db.all('SELECT * FROM repair_parts WHERE repair_id = ? ORDER BY id', [repair.id])
    : [];
  const nextStatuses = canUserTransition(db, raw, user);

  const equipment = findEquipmentLite(db, raw.equipment_id);
  return {
    fault: {
      ...decorate(raw),
      workflow: FAULT_STATUSES.map((s) => ({
        value: s,
        label: STATUS_META[s].label,
        reached: STATUS_META[s].step <= STATUS_META[raw.status].step,
        current: s === raw.status,
      })),
      nextStatuses,
      canEditTimeline: can(user, 'fault.view.any') || raw.reported_by === user.id,
      canReopen: can(user, 'fault.reopen') && ['closed', 'verified'].includes(raw.status),
      timings: {
        minutesToAssign: raw.minutes_to_assign ?? null,
        minutesToRepair: raw.minutes_to_repair ?? null,
        minutesToClose: raw.minutes_to_close ?? null,
        minutesOverdue: raw.minutes_overdue === -1 ? 0 : raw.minutes_overdue ?? null,
      },
    },
    equipment,
    timeline: shape(history.map((h) => ({ ...h, is_note: h.from_status === h.to_status && h.comment !== null }))),
    attachments: shape(attachments),
    repair: repair ? shape({ ...repair, parts: repairParts }) : null,
  };
}

const findEquipmentLite = (db, id) => shape(db.get(
  `SELECT e.id, e.asset_tag, e.name, e.status, e.criticality, e.serial_number, e.next_maintenance_on,
          l.name AS location_name FROM equipment e LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ?`,
  [id],
));

/* ----------------------------------------------------------------- queries -- */

export const statsForEquipment = (db, equipmentId) => db.get(
  `SELECT COUNT(*) AS total_faults,
          COALESCE(SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END),0) AS critical_count,
          COALESCE(SUM(CASE WHEN status IN (${OPEN_FAULT_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END),0) AS open_count,
          MAX(created_at) AS last_fault_at,
          MAX(CASE WHEN severity IN ('high','critical') THEN created_at END) AS last_severe_fault_at
     FROM fault_reports WHERE equipment_id = ?`,
  [...OPEN_FAULT_STATUSES, equipmentId],
);

export { FAULT_SELECT, decorate as decorateFault, OPEN_FAULT_STATUSES };
