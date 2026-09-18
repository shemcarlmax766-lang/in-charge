import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, expectStatus } from './helpers.js';

/** Phase 9 — in-app notifications and the delivery ledger that keeps email/SMS honest. */
let ctx, admin, tech, reporter;
test.after(async () => ctx.close());
test.before(async () => {
  ctx = await boot();
  admin = await ctx.login('admin@test.invalid');
  tech = await ctx.login('tech@test.invalid');
  reporter = await ctx.login('reporter@test.invalid');
});

test('a critical fault reaches administrators and technicians immediately', async () => {
  const before = ctx.db.value('SELECT COUNT(*) FROM notifications');
  const made = await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
    equipmentId: String(ctx.ids['ECG Trainer A']), categoryCode: 'ELEC', title: 'Monitor alarms silently',
    description: 'The audible alarm does not sound at any volume setting, which makes the unit unsafe for teaching.',
    severity: 'critical',
  } });
  expectStatus(made, 201);
  const faultId = made.body.fault.id;
  const admins = ctx.db.all(
    `SELECT n.* FROM notifications n
       JOIN users u ON u.id = n.user_id
       JOIN roles r ON r.id = u.role_id
      WHERE r.code IN ('admin', 'technician') AND n.type = ?
      ORDER BY n.id DESC`,
    ['fault_critical'],
  );
  const staffCount = ctx.db.value(`SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.code IN ('admin','technician') AND u.is_active = 1`);
  assert.equal(admins.length, staffCount, 'every active staff member is told about a critical fault');
  assert.ok(staffCount >= 3);
  assert.ok(admins.every((n) => n.severity === 'critical'));
  assert.match(admins[0].title, /CRITICAL fault FLT-\d{4}-\d{4}/);
  assert.match(admins[0].body, /ECG Trainer A/);
  assert.ok(admins[0].link.includes(String(faultId)), 'the notification deep-links to the fault');
  const nobody = ctx.db.get('SELECT n.* FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = ? AND n.type = ?', ['reporter@test.invalid', 'fault_critical']);
  assert.equal(nobody, undefined, 'the reporter is not notified about their own report');
  assert.ok(ctx.db.value('SELECT COUNT(*) FROM notifications') > before);
});

test('a non-critical fault tells the equipment owner, not the whole department', async () => {
  const eq = ctx.ids['ECG Trainer A'];
  ctx.db.run('UPDATE equipment SET responsible_technician_id = (SELECT id FROM users WHERE email = ?) WHERE id = ?', ['tech@test.invalid', eq]);
  const made = await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
    equipmentId: String(eq), categoryCode: 'MECH', title: 'Drawer sticks open',
    description: 'The paper drawer will not stay closed and jams during printing every few strips.', severity: 'low',
  } });
  expectStatus(made, 201);
  const list = (await ctx.api('/api/v1/notifications', { token: tech.token })).body.items;
  const mine = list.find((n) => n.entityId === made.body.fault.id && n.type === 'fault_assigned');
  assert.ok(mine, 'the responsible technician hears about it');
  const reporterBox = (await ctx.api('/api/v1/notifications', { token: (await ctx.login('reporter2@test.invalid')).token })).body.items;
  assert.ok(!reporterBox.some((n) => n.entityId === made.body.fault.id), 'other people are left alone');
});

test('every status change tells the reporter, and completion invites verification', async () => {
  const made = await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
    equipmentId: String(ctx.ids['Patient Monitor B']), categoryCode: 'ELEC', title: 'Battery will not hold charge',
    description: 'Fully charged, the monitor runs for about ten minutes and then shuts down without warning.', severity: 'medium',
  } });
  const faultId = made.body.fault.id;
  const techId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']);
  await ctx.api(`/api/v1/faults/${faultId}/assign`, { method: 'POST', token: admin.token, body: { technicianId: techId } });
  await ctx.api(`/api/v1/faults/${faultId}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'under_inspection' } });
  await ctx.api(`/api/v1/faults/${faultId}/repair`, { method: 'PUT', token: tech.token, body: {
    diagnosis: 'Battery at end of life', rootCause: 'Cycle wear', repairActions: 'Replaced battery pack',
    testResults: '4 h 10 min runtime at nominal load', safetyCheckConfirmed: true,
  } });
  await ctx.api(`/api/v1/faults/${faultId}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'repaired', comment: 'Battery replaced and tested' } });

  const box = (await ctx.api('/api/v1/notifications', { token: reporter.token })).body.items;
  const types = box.filter((n) => n.entityId === faultId).map((n) => n.type);
  assert.ok(types.includes('fault_status_changed'), 'progress updates arrive');
  assert.ok(types.includes('repair_completed'), 'and so does the completion notice');
  const completion = box.find((n) => n.type === 'repair_completed');
  assert.match(completion.body, /confirm the equipment works/i, 'the wording asks them to verify');
});

test('the unread badge, mark-as-read and per-user isolation behave', async () => {
  const list = await ctx.api('/api/v1/notifications', { token: tech.token });
  expectStatus(list, 200);
  const countBefore = list.body.unread;
  assert.ok(countBefore > 0);
  const target = list.body.items.find((n) => n.unread);
  const read = await ctx.api('/api/v1/notifications/read', { method: 'POST', token: tech.token, body: { ids: [target.id] } });
  expectStatus(read, 200);
  assert.equal(read.body.unread, countBefore - 1, 'one less unread');
  const otherBox = await ctx.api('/api/v1/notifications', { token: reporter.token });
  assert.ok(!otherBox.body.items.some((n) => n.id === target.id), 'another user cannot even see that row');
  const cannotTouch = await ctx.api(`/api/v1/notifications/${target.id}`, { method: 'DELETE', token: reporter.token });
  assert.equal(cannotTouch.status, 404, 'and cannot delete it either — it simply is not theirs');
  const all = await ctx.api('/api/v1/notifications/read', { method: 'POST', token: tech.token, body: {} });
  assert.equal(all.body.unread, 0, 'mark-all works');
  const filtered = await ctx.api('/api/v1/notifications?unreadOnly=true', { token: tech.token });
  assert.equal(filtered.body.items.length, 0);
});

test('deliveries are recorded per channel, so "we did not email anyone" is auditable', async () => {
  const n = ctx.db.get('SELECT id FROM notifications ORDER BY id DESC LIMIT 1');
  const rows = ctx.db.all('SELECT channel, status, detail FROM notification_deliveries WHERE notification_id = ?', [n.id]);
  const byChannel = Object.fromEntries(rows.map((r) => [r.channel, r]));
  assert.equal(byChannel.in_app.status, 'sent');
  for (const ch of ['email', 'sms', 'push']) {
    assert.ok(byChannel[ch], `${ch} is recorded, not silently absent`);
    assert.equal(byChannel[ch].status, 'skipped');
    assert.match(byChannel[ch].detail, /not enabled/i);
  }
  const meta = await ctx.api(`/api/v1/notifications/${n.id}/deliveries`, { token: admin.token });
  expectStatus(meta, 200, 'the ledger is readable through the API');
  assert.equal(meta.body.items.length, 4);
});

test('the reminder sweep notifies the right people and refuses to spam', async () => {
  const eqId = ctx.db.value('SELECT id FROM equipment WHERE name = ?', ['Microscope C']);
  ctx.db.run('UPDATE equipment SET next_maintenance_on = ?, responsible_technician_id = (SELECT id FROM users WHERE email = ?) WHERE id = ?',
    [new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), 'tech@test.invalid', eqId]);

  const first = await ctx.api('/api/v1/maintenance/reminders', { method: 'POST', token: admin.token, body: {} });
  expectStatus(first, 200, 'sweep runs');
  assert.ok(first.body.sent >= 1, 'the overdue item produced reminders');
  const techBox = (await ctx.api('/api/v1/notifications', { token: tech.token })).body.items;
  const reminder = techBox.find((n) => n.type === 'maintenance_overdue' && n.entityId === eqId);
  assert.ok(reminder, 'the responsible technician received it');
  assert.match(reminder.body, /30 day\(s\) past due/, 'the message says how late it is');
  assert.equal(reminder.severity, 'warning');
  assert.ok(reminder.link.endsWith(`/equipment/${eqId}`), 'it links to the asset, not a dead id');

  const second = await ctx.api('/api/v1/maintenance/reminders', { method: 'POST', token: admin.token, body: {} });
  expectStatus(second, 200);
  const again = (await ctx.api('/api/v1/notifications', { token: tech.token })).body.items
    .filter((n) => n.type === 'maintenance_overdue' && n.entityId === eqId);
  assert.equal(again.length, 1, 'running it twice must not double-notify');
  assert.equal(second.body.skipped >= 1, true);

  const board = await ctx.api('/api/v1/maintenance/due-board?days=365', { token: admin.token });
  const row = board.body.items.find((r) => r.equipmentId === eqId);
  assert.equal(row.pmState.state, 'overdue', 'the board and the notifier read the same rows');
});
