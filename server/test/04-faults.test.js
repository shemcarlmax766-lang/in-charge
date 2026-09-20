import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, expectStatus, fieldErrors } from './helpers.js';

/** Phase 4 — fault reporting and the workflow state machine. */
let ctx;
let admin, tech, reporter;
test.after(async () => ctx.close());
test.before(async () => {
  ctx = await boot();
  admin = await ctx.login('admin@test.invalid');
  tech = await ctx.login('tech@test.invalid');
  reporter = await ctx.login('reporter@test.invalid');
});

const report = async (over = {}) => ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
  equipmentId: String(ctx.ids['ECG Trainer A']), categoryCode: 'ELEC', title: 'No trace on leads II and III',
  description: 'Two of the twelve traces stay flat even with fresh electrodes and a calibrated test signal.',
  severity: 'high', ...over,
} });

test('a report is referenced, timestamped, SLA-dated and reflects on the equipment', async () => {
  const res = await report();
  expectStatus(res, 201, 'create fault');
  const f = res.body.fault;
  assert.match(f.reference, /^FLT-\d{4}-\d{4}$/);
  assert.equal(f.status, 'reported');
  assert.equal(f.severity, 'high');
  assert.ok(f.dueAt, 'SLA target minted from severity');
  const hours = (new Date(f.dueAt) - new Date(f.createdAt)) / 3_600_000;
  assert.equal(Math.round(hours), 24, 'high severity has a 24 h target');
  assert.equal(res.body.equipment.status, 'reported_fault', 'the asset is immediately known-bad');
  const hist = ctx.db.all('SELECT from_status, to_status, comment FROM fault_status_history WHERE fault_id = ? ORDER BY id', [f.id]);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].from_status, null, 'the first entry has no previous status');
  assert.equal(hist[0].to_status, 'reported');
  assert.ok(hist[0].comment);
});

test('input rules: too-short descriptions, unknown categories, future timestamps, decommissioned items', async () => {
  const short = await report({ description: 'broken' });
  expectStatus(short, 422);
  assert.ok(fieldErrors(short).description, 'description length is enforced server-side');

  const noCategory = await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
    equipmentId: '1', title: 'Missing category here', description: 'Nothing in the list seems to fit this symptom at all.', severity: 'low' } });
  expectStatus(noCategory, 400, 'a category must be chosen');

  const future = await report({ observedAt: new Date(Date.now() + 86_400_000).toISOString().slice(0, 16) + ':00Z' });
  expectStatus(future, 422, 'a fault cannot be observed in the future');

  const gone = ctx.db.value('SELECT id FROM equipment WHERE name = ?', ['Microscope C']);
  ctx.api(`/api/v1/equipment/${gone}/status`, { method: 'POST', token: admin.token, body: { status: 'decommissioned', reason: 'End of life' } });
  const onDecommissioned = await report({ equipmentId: String(gone), title: 'Fault on retired item', description: 'Reporting a fault against equipment that has been decommissioned should be refused.' });
  expectStatus(onDecommissioned, 409, 'decommissioned equipment has no fault workflow');
});

test('illegal transitions are refused with a reason, legal skips are allowed', async () => {
  const f = (await report({ severity: 'medium' })).body.fault;
  const jump = await ctx.api(`/api/v1/faults/${f.id}/transition`, { method: 'POST', token: admin.token, body: { targetStatus: 'closed', comment: 'duplicate of FLT-1' } });
  expectStatus(jump, 200, 'an unworked report may be closed by an admin (skip-everything path)');
  assert.equal(jump.body.fault.status, 'closed');
  assert.ok(jump.body.fault.closedAt, 'closed_at stamped');

  const reopenable = (await report()).body.fault;
  const straight = await ctx.api(`/api/v1/faults/${reopenable.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'under_repair' } });
  expectStatus(straight, 403, 'reported → under_repair is not a legal edge');
  assert.match(straight.body.error.message, /cannot move directly/i);

  const unknown = await ctx.api(`/api/v1/faults/${reopenable.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'fixed' } });
  expectStatus(unknown, 422, 'unknown state names are validation errors, not 500s');
});

test('technicians may self-claim an unassigned fault; the chain stays attributable', async () => {
  const f = (await report()).body.fault;
  assert.equal(f.assignedTo, null);
  const claim = await ctx.api(`/api/v1/faults/${f.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'under_inspection', comment: 'Picked up off the board' } });
  expectStatus(claim, 200, 'self-assignment is allowed');
  assert.equal(claim.body.fault.assignedToName, 'Test Technician');
  assert.equal(claim.body.fault.statusLabel, 'Under Inspection');
  const note = claim.body.timeline.at(-1);
  assert.match(note.comment, /Picked up/i);
  assert.equal(claim.body.equipment.status, 'under_inspection', 'asset follows the work');

  const second = (await report({ title: 'Second unassigned report here', severity: 'low' })).body.fault;
  const other = await ctx.login('tech2@test.invalid');
  const taken = await ctx.api(`/api/v1/faults/${second.id}/transition`, { method: 'POST', token: other.token, body: { targetStatus: 'under_inspection' } });
  expectStatus(taken, 200, 'another technician can claim it while unassigned');
  const trespass = await ctx.api(`/api/v1/faults/${f.id}/transition`, { method: 'POST', token: other.token, body: { targetStatus: 'under_repair' } });
  expectStatus(trespass, 403, 'but not on one already owned');
  assert.match(trespass.body.error.message, /assigned to someone else/i);
});

test('assignment: admin assigns, note is recorded, technician is notified', async () => {
  const f = (await report()).body.fault;
  const techId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']);
  const res = await ctx.api(`/api/v1/faults/${f.id}/assign`, { method: 'POST', token: admin.token, body: { technicianId: techId, note: 'Available this afternoon' } });
  expectStatus(res, 200, 'assign');
  assert.equal(res.body.fault.status, 'assigned', 'reported advances to assigned on first assignment');
  assert.equal(res.body.fault.assignedToName, 'Test Technician');
  assert.ok(res.body.fault.assignedAt);
  const notif = ctx.db.get('SELECT * FROM notifications WHERE user_id = ? AND type = ? ORDER BY id DESC', [techId, 'fault_assigned']);
  assert.ok(notif, 'the technician received an in-app notification');
  assert.match(notif.title, /assigned/i);
  assert.ok(notif.link.includes(String(f.id)), 'notification deep-links to the fault');
});

test('the full documented path works end to end, recording every step', async () => {
  // A dedicated asset: equipment status is derived from *all* its open faults, so sharing a
  // busy item between tests would make "returns to service" ambiguous.
  const solo = await ctx.api('/api/v1/equipment', { method: 'POST', token: admin.token, body: { name: 'Solo test monitor', categoryId: 2 } });
  expectStatus(solo, 201);
  const f = (await report({ severity: 'critical', equipmentId: String(solo.body.equipment.id) })).body.fault;
  const techId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']);
  await ctx.api(`/api/v1/faults/${f.id}/assign`, { method: 'POST', token: admin.token, body: { technicianId: techId } });
  const steps = [
    ['acknowledged', 'On my bench now'],
    ['under_inspection', 'Signal-path injection test'],
    ['under_repair', 'Front-end board out'],
    ['awaiting_parts', 'Ordered replacement board'],
    ['under_repair', 'Board arrived'],
  ];
  for (const [status, comment] of steps) {
    const res = await ctx.api(`/api/v1/faults/${f.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: status, comment } });
    expectStatus(res, 200, `transition to ${status}`);
    assert.equal(res.body.fault.status, status);
  }
  const history = ctx.db.all('SELECT from_status, to_status, comment, changed_by FROM fault_status_history WHERE fault_id = ? ORDER BY id', [f.id]);
  assert.ok(history.length >= 6, 'one row per status change');
  assert.ok(history.every((h) => h.changed_by !== null), 'every change names a user');
  for (let i = 1; i < history.length; i += 1) {
    assert.equal(history[i].from_status, history[i - 1].to_status, 'the trail is contiguous');
  }

  await ctx.api(`/api/v1/faults/${f.id}/repair`, { method: 'PUT', token: tech.token, body: {
    diagnosis: 'Failed input protection board on the patient cable entry', rootCause: 'Cleaning fluid ingress corroded the tracks',
    troubleshooting: 'Injected a test signal at each stage; signal lost at the input board',
    repairActions: 'Replaced the input board, cleaned and sealed the entry, re-tested all 12 leads',
    testResults: 'All leads within specification; 2 h continuous run; leakage current 18 µA',
    safetyCheckConfirmed: true, dateRepaired: new Date().toISOString().slice(0, 10),
  } });
  const repaired = await ctx.api(`/api/v1/faults/${f.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'repaired', comment: 'Bench tests complete' } });
  expectStatus(repaired, 200, 'repaired after a complete repair record');
  assert.equal(repaired.body.fault.diagnosisConfirmed, true, 'only this transition asserts a confirmed diagnosis');
  assert.equal(repaired.body.equipment.status, 'operational', 'equipment returns to service');
  assert.equal(repaired.body.equipment.assetTag, solo.body.equipment.assetTag);

  const verified = await ctx.api(`/api/v1/faults/${f.id}/transition`, { method: 'POST', token: reporter.token, body: { targetStatus: 'verified', comment: 'Checked in the lab, all leads trace correctly' } });
  expectStatus(verified, 200, 'the reporter who raised it can verify the fix');
  assert.equal(verified.body.fault.verifiedByName, 'Test Reporter');
  const closed = await ctx.api(`/api/v1/faults/${f.id}/transition`, { method: 'POST', token: admin.token, body: { targetStatus: 'closed', comment: 'Closed with history updated' } });
  expectStatus(closed, 200);
  assert.equal(closed.body.fault.closedAt !== null, true);
  const notif = ctx.db.get('SELECT * FROM notifications WHERE user_id = ? AND type = ? ORDER BY id DESC', [reporter.user.id, 'repair_completed']);
  assert.ok(notif, 'the reporter was told the repair was completed');
});

test('closing without verification is refused, and reopen is admin-only with a reason', async () => {
  const f = (await report({ title: 'Cannot close this one yet', severity: 'low' })).body.fault;
  const techId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']);
  await ctx.api(`/api/v1/faults/${f.id}/assign`, { method: 'POST', token: admin.token, body: { technicianId: techId } });
  const closeDirect = await ctx.api(`/api/v1/faults/${f.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'closed' } });
  expectStatus(closeDirect, 403, 'assigned-but-unworked faults cannot be closed by the technician');

  const r = await ctx.api(`/api/v1/faults/${f.id}/transition`, { method: 'POST', token: admin.token, body: { targetStatus: 'closed', comment: 'Not reproducible; guidance given' } });
  expectStatus(r, 200, 'admin may close it as not-reproducible');
  const noReason = await ctx.api(`/api/v1/faults/${f.id}/reopen`, { method: 'POST', token: tech.token, body: { comment: 'still broken' } });
  expectStatus(noReason, 403, 'reopen is admin-only');
  const blank = await ctx.api(`/api/v1/faults/${f.id}/reopen`, { method: 'POST', token: admin.token, body: { comment: '' } });
  expectStatus(blank, 422, 'and needs a reason');
  const back = await ctx.api(`/api/v1/faults/${f.id}/reopen`, { method: 'POST', token: admin.token, body: { comment: 'User reproduced it on video', reason: 'New evidence' } });
  expectStatus(back, 200, 'reopen');
  assert.equal(back.body.fault.status, 'under_inspection');
  assert.match(back.body.timeline.at(-1).comment, /REOPENED/);
});

test('reporters may amend their own report only until triage starts', async () => {
  const f = (await report({ title: 'Intermittent shutdown', severity: 'low' })).body.fault;
  const edit = await ctx.api(`/api/v1/faults/${f.id}`, { method: 'PATCH', token: reporter.token, body: { severity: 'critical', description: 'The unit shuts down completely within a minute of every cold start, and the shutdown is unsafe during a demo.' } });
  expectStatus(edit, 200, 'owner may edit while status is reported');
  assert.equal(edit.body.fault.severity, 'critical');
  assert.notEqual(edit.body.fault.dueAt, f.dueAt, 'SLA recomputed for the new severity');

  const techId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']);
  await ctx.api(`/api/v1/faults/${f.id}/assign`, { method: 'POST', token: admin.token, body: { technicianId: techId } });
  const locked = await ctx.api(`/api/v1/faults/${f.id}`, { method: 'PATCH', token: reporter.token, body: { title: 'Rewritten after triage' } });
  expectStatus(locked, 409, 'once work starts the report is immutable for the reporter');
  assert.match(locked.body.error.message, /timeline note/i);

  const otherReporter = await ctx.login('reporter2@test.invalid');
  const notMine = await ctx.api(`/api/v1/faults/${f.id}`, { method: 'PATCH', token: otherReporter.token, body: { title: 'Not my report at all' } });
  expectStatus(notMine, 403, 'and never someone else’s');

  const note = await ctx.api(`/api/v1/faults/${f.id}/notes`, { method: 'POST', token: reporter.token, body: { comment: 'It also happens on a different power socket' } });
  expectStatus(note, 200, 'but they can add to the timeline');
  const last = note.body.timeline.at(-1);
  assert.equal(last.isNote, true, 'rendered as a note, not a status change');
  assert.equal(last.toStatus, 'assigned', 'status unchanged');
});

test('list scoping and filters: open, assigned, overdue, unassigned, equipment', async () => {
  const mine = await ctx.api('/api/v1/faults?scope=open', { token: reporter.token });
  expectStatus(mine, 200);
  assert.ok(mine.body.rows.every((f) => f.reportedBy === reporter.user.id), 'reporters only ever see their own');
  const assigned = await ctx.api('/api/v1/faults?scope=assigned', { token: tech.token });
  expectStatus(assigned, 200);
  assert.ok(assigned.body.rows.length > 0);
  assert.ok(assigned.body.rows.every((f) => f.assignedToName === 'Test Technician'));
  const unassigned = await ctx.api('/api/v1/faults?scope=unassigned', { token: admin.token });
  assert.ok(unassigned.body.rows.every((f) => !f.assignedTo));
  const critical = await ctx.api('/api/v1/faults?severity=critical&sort=severity&dir=asc', { token: admin.token });
  assert.ok(critical.body.rows.every((f) => f.severity === 'critical'));
  const eq = await ctx.api(`/api/v1/faults?equipmentId=${ctx.ids['ECG Trainer A']}`, { token: admin.token });
  assert.ok(eq.body.rows.every((f) => f.equipmentId === ctx.ids['ECG Trainer A']));
  const dated = await ctx.api('/api/v1/faults?from=2020-01-01&to=2020-01-02', { token: admin.token });
  expectStatus(dated, 200);
  assert.equal(dated.body.rows.length, 0, 'date window filters');
});
