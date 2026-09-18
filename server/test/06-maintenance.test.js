import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, expectStatus, fieldErrors, daysFromNow } from './helpers.js';

/** Phase 6 — preventive maintenance: schedules, checklists, completion, due states. */
let ctx, admin, tech, reporter;
test.after(async () => ctx.close());
test.before(async () => {
  ctx = await boot();
  admin = await ctx.login('admin@test.invalid');
  tech = await ctx.login('tech@test.invalid');
  reporter = await ctx.login('reporter@test.invalid');
});

test('a schedule creates its checklist as rows and sets the equipment due date', async () => {
  const eq = ctx.db.value('SELECT id FROM equipment WHERE name = ?', ['Microscope C']);
  const res = await ctx.api('/api/v1/maintenance/schedules', { method: 'POST', token: admin.token, body: {
    equipmentId: eq, title: 'Quarterly optics check', intervalDays: 90,
    responsibleTechnicianId: ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']),
    nextDueOn: daysFromNow(5),
    checklist: ['Clean optics', 'Check lamp hours', 'Lubricate stage'],
  } });
  expectStatus(res, 201, 'create schedule');
  assert.equal(res.body.intervalDays, 90);
  assert.equal(res.body.checklist.length, 3, 'checklist items are real rows, not a JSON blob');
  assert.equal(res.body.pmState.state, 'due_soon', '🟡 due within 14 days');
  const eqRow = ctx.db.get('SELECT next_maintenance_on FROM equipment WHERE id = ?', [eq]);
  assert.equal(eqRow.next_maintenance_on, daysFromNow(5), 'the asset header mirrors its nearest schedule');

  const items = ctx.db.all('SELECT label FROM maintenance_checklist_items WHERE schedule_id = ? ORDER BY position', [res.body.id]);
  assert.deepEqual(items.map((i) => i.label), ['Clean optics', 'Check lamp hours', 'Lubricate stage']);
});

test('the three traffic-light states are computed, never typed', async () => {
  const { pmStateFor } = await import('../src/services/maintenance.service.js');
  assert.equal(pmStateFor(daysFromNow(40)).state, 'up_to_date');
  assert.equal(pmStateFor(daysFromNow(40)).light, '🟢');
  assert.equal(pmStateFor(daysFromNow(3)).state, 'due_soon');
  assert.equal(pmStateFor(daysFromNow(3)).light, '🟡');
  assert.equal(pmStateFor(daysFromNow(-9)).state, 'overdue');
  assert.equal(pmStateFor(daysFromNow(-9)).light, '🔴');
  assert.match(pmStateFor(daysFromNow(-9)).label, /9 day/);
  assert.equal(pmStateFor(null).state, 'not_scheduled');
  assert.equal(pmStateFor(daysFromNow(14)).state, 'due_soon', 'the boundary day counts as due soon');
  assert.equal(pmStateFor(daysFromNow(15)).state, 'up_to_date');
});

test('validation: intervals, non-technician owners, duplicate titles, decommissioned items', async () => {
  const eq = ctx.ids['ECG Trainer A'];
  const techId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']);
  const zero = await ctx.api('/api/v1/maintenance/schedules', { method: 'POST', token: admin.token, body: { equipmentId: eq, title: 'Impossible interval', intervalDays: 0, responsibleTechnicianId: techId } });
  expectStatus(zero, 422, 'interval must be a positive number of days');

  const reporterId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['reporter@test.invalid']);
  const wrongOwner = await ctx.api('/api/v1/maintenance/schedules', { method: 'POST', token: admin.token, body: { equipmentId: eq, title: 'Wrong owner', intervalDays: 30, responsibleTechnicianId: reporterId } });
  expectStatus(wrongOwner, 400, 'a student cannot own preventive maintenance');
  assert.match(wrongOwner.body.error.message, /technician/i);

  const first = await ctx.api('/api/v1/maintenance/schedules', { method: 'POST', token: admin.token, body: { equipmentId: eq, title: 'Annual safety test', intervalDays: 365, responsibleTechnicianId: techId } });
  expectStatus(first, 201);
  const dup = await ctx.api('/api/v1/maintenance/schedules', { method: 'POST', token: admin.token, body: { equipmentId: eq, title: 'Annual safety test', intervalDays: 365, responsibleTechnicianId: techId } });
  expectStatus(dup, 409, 'two identical active schedules on one item is a data bug, not a feature');

  const gone = ctx.db.value('SELECT id FROM equipment WHERE name = ?', ['Patient Monitor B']);
  await ctx.api(`/api/v1/equipment/${gone}/status`, { method: 'POST', token: admin.token, body: { status: 'decommissioned', reason: 'Written off' } });
  const onDecommissioned = await ctx.api('/api/v1/maintenance/schedules', { method: 'POST', token: admin.token, body: { equipmentId: gone, title: 'Monthly check', intervalDays: 30 } });
  expectStatus(onDecommissioned, 409, 'decommissioned items are not maintained');
});

test('completing a PM records the checklist, stamps the equipment and moves the due date', async () => {
  const eqId = ctx.db.value('SELECT id FROM equipment WHERE name = ?', ['Microscope C']);
  const schedule = ctx.db.get('SELECT * FROM maintenance_schedules WHERE equipment_id = ? ORDER BY id DESC LIMIT 1', [eqId]);
  const before = ctx.db.get('SELECT next_maintenance_on, last_maintenance_on FROM equipment WHERE id = ?', [eqId]);
  const items = ctx.db.all('SELECT * FROM maintenance_checklist_items WHERE schedule_id = ? ORDER BY position', [schedule.id]);

  const res = await ctx.api(`/api/v1/maintenance/schedules/${schedule.id}/complete`, { method: 'POST', token: tech.token, body: {
    performedOn: daysFromNow(0), durationMinutes: 45, downtimeMinutes: 45,
    findings: 'Lamp hours near end of life; ordered a spare module.',
    actionsTaken: 'Cleaned optics, aligned Köhler, lubricated stage.',
    checklistResults: items.map((i, n) => ({ itemId: i.id, label: i.label, outcome: n === 1 ? 'fail' : 'pass', note: n === 1 ? 'Lamp at 1900 h of 2000 h' : null })),
  } });
  expectStatus(res, 201, 'record PM');
  const rec = res.body;
  assert.match(rec.reference, /^PM-\d{4}-\d{4}$/);
  assert.equal(rec.checklist.length, 3);
  assert.equal(rec.checklist.filter((c) => c.outcome === 'fail').length, 1);
  assert.equal(rec.conditionFound, 'needs_attention', 'a failed check is not reported as a pass');
  assert.equal(rec.daysLate >= 0, true);

  const after = ctx.db.get('SELECT last_maintenance_on, next_maintenance_on FROM equipment WHERE id = ?', [eqId]);
  assert.equal(after.last_maintenance_on, daysFromNow(0), 'the asset knows it was just serviced');
  assert.equal(after.next_maintenance_on, daysFromNow(90), 'next due = performed + interval, even though it was overdue');
  assert.notEqual(after.next_maintenance_on, before.next_maintenance_on);

  const board = await ctx.api('/api/v1/maintenance/due-board?days=30', { token: admin.token });
  assert.ok(board.body.items.every((r) => r.pmState.state !== 'up_to_date'), 'the board only lists things needing attention');

  const pmCount = ctx.db.value('SELECT COUNT(*) FROM maintenance_records WHERE equipment_id = ?', [eqId]);
  assert.equal(pmCount, 1);
});

test('a missed visit is recorded honestly and does NOT buy a new due date', async () => {
  const eqId = ctx.ids['ECG Trainer A'];
  await ctx.api('/api/v1/maintenance/schedules', { method: 'POST', token: admin.token, body: {
    equipmentId: eqId, title: 'Missed-visit test schedule', intervalDays: 60, nextDueOn: daysFromNow(-4),
  } });
  const schedule = ctx.db.get('SELECT * FROM maintenance_schedules WHERE equipment_id = ? ORDER BY id DESC LIMIT 1', [eqId]);
  const before = ctx.db.get('SELECT last_maintenance_on, next_maintenance_on FROM equipment WHERE id = ?', [eqId]);
  const res = await ctx.api(`/api/v1/maintenance/schedules/${schedule.id}/complete`, { method: 'POST', token: tech.token, body: {
    performedOn: daysFromNow(0), markAsMissed: true, findings: 'Room booked for exams all week; the visit could not be made.',
  } });
  expectStatus(res, 201, 'a missed visit can be recorded');
  assert.equal(res.body.findings.includes('Room booked'), true);
  const after = ctx.db.get('SELECT last_maintenance_on, next_maintenance_on FROM equipment WHERE id = ?', [eqId]);
  assert.equal(after.last_maintenance_on, before.last_maintenance_on, 'a missed visit does not reset the history');
  assert.equal(after.next_maintenance_on, before.next_maintenance_on, 'nor does it reset the clock — it stays overdue');
  const noReason = await ctx.api('/api/v1/maintenance/records', { method: 'POST', token: tech.token, body: { equipmentId: eqId, markAsMissed: true, performedOn: daysFromNow(0) } });
  expectStatus(noReason, 400, 'and it must say why');
});

test('reporters cannot record maintenance; technicians and admins can', async () => {
  const eqId = ctx.ids['Microscope C'];
  const blocked = await ctx.api('/api/v1/maintenance/records', { method: 'POST', token: reporter.token, body: { equipmentId: eqId, performedOn: daysFromNow(0), findings: 'I cleaned it myself today' } });
  expectStatus(blocked, 403, 'a student cannot sign off preventive maintenance');
  const ok = await ctx.api('/api/v1/maintenance/records', { method: 'POST', token: admin.token, body: { equipmentId: eqId, performedOn: daysFromNow(0), findings: 'Ad-hoc clean after a spill', actionsTaken: 'Cleaned and dried the stage.' } });
  expectStatus(ok, 201, 'an unscheduled, ad-hoc record is allowed');
  assert.equal(ok.body.scheduleId, null);
});

test('PM recorded in the future is refused, and so is going backwards in time', async () => {
  const eqId = ctx.ids['Microscope C'];
  const future = await ctx.api('/api/v1/maintenance/records', { method: 'POST', token: admin.token, body: { equipmentId: eqId, performedOn: daysFromNow(4) } });
  expectStatus(future, 422, 'performed_on cannot be in the future');
  const lastOn = ctx.db.value('SELECT MAX(performed_on) FROM maintenance_records WHERE equipment_id = ?', [eqId]);
  const scheduleId = ctx.db.value('SELECT id FROM maintenance_schedules WHERE equipment_id = ? ORDER BY id DESC LIMIT 1', [eqId]);
  const backwards = await ctx.api(`/api/v1/maintenance/schedules/${scheduleId}/complete`, { method: 'POST', token: tech.token, body: { performedOn: '2020-01-01' } });
  expectStatus(backwards, 400, 'a completion earlier than the last recorded one is rejected');
  assert.match(backwards.body.error.message, /earlier than the last/i);
  assert.ok(lastOn);
});

test('compliance figures are internally consistent', async () => {
  const res = await ctx.api('/api/v1/maintenance/compliance?days=365', { token: admin.token });
  expectStatus(res, 200);
  const c = res.body;
  assert.equal(c.recordsDone, c.recordsOnTime + ctx.db.value('SELECT COUNT(*) FROM maintenance_records WHERE days_late > 0'));
  assert.ok(c.fleetCompliancePercent >= 0 && c.fleetCompliancePercent <= 100);
  assert.equal(c.overdueEquipment, ctx.db.value("SELECT COUNT(*) FROM equipment WHERE is_active = 1 AND status <> 'decommissioned' AND date(next_maintenance_on) < date('now')"));
  assert.ok(c.scheduledEquipment >= c.overdueEquipment + c.upToDateEquipment + c.dueSoonEquipment
    ? true : c.scheduledEquipment === c.overdueEquipment + c.upToDateEquipment + c.dueSoonEquipment);
});

test('deleting a schedule deactivates cleanly; deleting records needs admin + reason', async () => {
  const eqId = ctx.ids['Microscope C'];
  const schedule = ctx.db.get('SELECT * FROM maintenance_schedules WHERE equipment_id = ? ORDER BY id DESC LIMIT 1', [eqId]);
  const naive = await ctx.api(`/api/v1/maintenance/schedules/${schedule.id}`, { method: 'DELETE', token: admin.token, body: {} });
  expectStatus(naive, 409, 'a schedule with history needs a stated reason');
  const byTech = await ctx.api(`/api/v1/maintenance/schedules/${schedule.id}`, { method: 'DELETE', token: tech.token, body: { reason: 'merged' } });
  expectStatus(byTech, 403, 'only an administrator deletes schedules');
  const ok = await ctx.api(`/api/v1/maintenance/schedules/${schedule.id}`, { method: 'DELETE', token: admin.token, body: { reason: 'Superseded by the annual manufacturer contract' } });
  expectStatus(ok, 200);
  assert.equal(ctx.db.value('SELECT COUNT(*) FROM maintenance_checklist_items WHERE schedule_id = ?', [schedule.id]), 0, 'checklist rows go with it');
  const records = ctx.db.all('SELECT schedule_id FROM maintenance_records WHERE equipment_id = ?', [eqId]);
  assert.ok(records.length > 0, 'history survives deletion of the schedule');
  assert.ok(records.every((r) => r.schedule_id === null), 'and the orphaned pointer is nulled, not dropped');

  const recId = ctx.db.value('SELECT id FROM maintenance_records WHERE equipment_id = ? ORDER BY id DESC LIMIT 1', [eqId]);
  if (recId) {
    const noReason = await ctx.api(`/api/v1/maintenance/records/${recId}`, { method: 'DELETE', token: admin.token, body: {} });
    expectStatus(noReason, 422, 'removing a record needs a reason');
    const removed = await ctx.api(`/api/v1/maintenance/records/${recId}`, { method: 'DELETE', token: admin.token, body: { reason: 'Entered against the wrong asset id' } });
    expectStatus(removed, 200);
    assert.equal(ctx.db.value('SELECT COUNT(*) FROM maintenance_record_checklist WHERE record_id = ?', [recId]), 0, 'its checklist rows go too');
  }
});
