import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, expectStatus, TEST_PASSWORD } from './helpers.js';

/**
 * Phase 1/4/5 — role-based authorisation.
 * The rules that matter most here are the two accountability ones from the brief:
 * a reporter cannot touch official records, and only a technician may assert a diagnosis.
 */
let ctx;
test.after(async () => ctx.close());
test.before(async () => { ctx = await boot(); });

const admin = () => ctx.login('admin@test.invalid');
const tech = () => ctx.login('tech@test.invalid');
const reporter = () => ctx.login('reporter@test.invalid');

test('reporters cannot create, edit or delete equipment', async () => {
  const r = await reporter();
  const create = await ctx.api('/api/v1/equipment', { method: 'POST', token: r.token, body: { name: 'Sneaky autoclave', categoryId: 1 } });
  assert.equal(create.status, 403, 'equipment.create is not a reporter capability');
  assert.match(create.body.error.message, /administrator|biomedical engineer/i, 'the refusal says who can do it');

  const patch = await ctx.api('/api/v1/equipment/1', { method: 'PATCH', token: r.token, body: { name: 'Renamed by a student' } });
  assert.equal(patch.status, 403);

  const del = await ctx.api('/api/v1/equipment/3', { method: 'DELETE', token: r.token, body: { confirmTag: 'BMU-MIC-0001' } });
  assert.equal(del.status, 403);

  const status = await ctx.api('/api/v1/equipment/1/status', { method: 'POST', token: r.token, body: { status: 'decommissioned', reason: 'because' } });
  assert.equal(status.status, 403);

  assert.equal(ctx.db.value('SELECT name FROM equipment WHERE id = 1'), 'ECG Trainer A', 'nothing changed on disk');
});

test('technicians may maintain the inventory but not manage users or settings', async () => {
  const t = await tech();
  expectStatus(await ctx.api('/api/v1/equipment', { method: 'POST', token: t.token, body: { name: 'Tech-added scope light', categoryId: 3 } }), 201, 'technician can add equipment');
  assert.equal((await ctx.api('/api/v1/users', { method: 'POST', token: t.token, body: { fullName: 'New Person', email: 'new@test.invalid', roleCode: 'reporter' } })).status, 403, 'user management is admin-only');
  assert.equal((await ctx.api('/api/v1/reference/settings', { method: 'PATCH', token: t.token, body: { currency: 'GBP' } })).status, 403, 'settings are admin-only');
  assert.equal((await ctx.api('/api/v1/reference/categories', { method: 'POST', token: t.token, body: { code: 'ZZ', name: 'Zed' } })).status, 403, 'reference data is admin-only');
});

test('only technicians and admins may assert a technical diagnosis', async () => {
  const r = await reporter();
  const t = await tech();
  const a = await admin();
  const eq = ctx.db.value('SELECT id FROM equipment WHERE name = ?', ['Patient Monitor B']);
  const made = await ctx.api('/api/v1/faults', { method: 'POST', token: r.token, body: {
    equipmentId: String(eq), categoryCode: 'ELEC', title: 'Monitor shuts off', severity: 'high',
    description: 'The monitor powers down by itself roughly every ten minutes during a demonstration.',
  } });
  expectStatus(made, 201, 'reporter can report a fault');
  const faultId = made.body.fault.id;

  const claim = await ctx.api(`/api/v1/faults/${faultId}/repair`, { method: 'PUT', token: r.token, body: {
    diagnosis: 'Capacitor failure', rootCause: 'Age', repairActions: 'Replaced capacitors', testResults: 'Stable for 4 h',
  } });
  assert.equal(claim.status, 403, 'a reporter may not write a repair record');
  assert.match(claim.body.error.message, /technician|biomedical engineer/i);

  // Even an administrator cannot sign a diagnosis — that is the technician's professional call.
  const byAdmin = await ctx.api(`/api/v1/faults/${faultId}/repair`, { method: 'PUT', token: a.token, body: {
    diagnosis: 'Admin diagnosis', rootCause: 'Admin cause', repairActions: 'Admin actions', testResults: 'Admin tests',
  } });
  assert.equal(byAdmin.status, 403, 'admin can assign and verify, not diagnose');
  assert.ok(byAdmin.body.error.message.includes('technician'), 'the message says why');

  const byTech = await ctx.api(`/api/v1/faults/${faultId}/repair`, { method: 'PUT', token: t.token, body: {
    diagnosis: 'Failed electrolytic capacitor on the mains board', rootCause: 'Age-related dry-out',
    repairActions: 'Replaced capacitor, reflowed joint', testResults: 'Runs 4 h without shutdown', safetyCheckConfirmed: true,
  } });
  expectStatus(byTech, 200, 'technician may record the repair');
  assert.equal(byTech.body.record.technicianName, 'Test Technician');
  assert.equal(ctx.db.value('SELECT diagnosis_confirmed FROM fault_reports WHERE id = ?', [faultId]), 1,
    'recording a technician-signed diagnosis is exactly what sets the flag');
});

test('reporters cannot advance the workflow, and cannot be assigned work', async () => {
  const r = await reporter();
  const r2 = await ctx.login('reporter2@test.invalid');
  const eq = ctx.ids['ECG Trainer A'];
  const made = await ctx.api('/api/v1/faults', { method: 'POST', token: r.token, body: {
    equipmentId: String(eq), categoryCode: 'MECH', title: 'Paper jam', severity: 'low',
    description: 'The built-in printer jams every few strips during the practical class.',
  } });
  const faultId = made.body.fault.id;

  const advance = await ctx.api(`/api/v1/faults/${faultId}/transition`, { method: 'POST', token: r.token, body: { targetStatus: 'under_repair', comment: 'fixed it myself' } });
  assert.equal(advance.status, 403, 'technical stages require the technician role');
  assert.match(advance.body.error.message, /technician role/i);

  const close = await ctx.api(`/api/v1/faults/${faultId}/transition`, { method: 'POST', token: r.token, body: { targetStatus: 'closed', comment: 'never mind' } });
  assert.equal(close.status, 403, 'only an admin may close an unworked report');

  const selfAssign = await ctx.api(`/api/v1/faults/${faultId}/assign`, { method: 'POST', token: r.token, body: { technicianId: r.id ?? 4 } });
  assert.equal(selfAssign.status, 403, 'reporters cannot assign');

  const assignReporter = await ctx.api(`/api/v1/faults/${faultId}/assign`, { method: 'POST', token: (await admin()).token, body: { technicianId: r2.user.id } });
  assert.equal(assignReporter.status, 400, 'a reporter cannot be assigned repair work');
  assert.match(assignReporter.body.error.message, /role/i);
});

test('reporters only see their own fault reports', async () => {
  const r = await reporter();
  const a = await admin();
  const made = await ctx.api('/api/v1/faults', { method: 'POST', token: r.token, body: {
    equipmentId: String(ctx.ids['Microscope C']), categoryCode: 'OTH', title: 'Lamp flickers', severity: 'medium',
    description: 'The illumination flickers when the intensity knob is anywhere above half.',
  } });
  const mine = await ctx.api('/api/v1/faults', { token: r.token });
  expectStatus(mine, 200);
  assert.ok(mine.body.rows.length >= 1);
  assert.ok(mine.body.rows.every((f) => f.reportedBy === r.user.id), 'every row in the reporter list belongs to them');

  const other = await ctx.login('reporter2@test.invalid');
  const theirs = await ctx.api(`/api/v1/faults/${made.body.fault.id}`, { token: other.token });
  assert.equal(theirs.status, 403, 'another reporter cannot read this report');

  const all = await ctx.api('/api/v1/faults', { token: a.token });
  assert.ok(all.body.pagination.total >= mine.body.pagination.total, 'admin sees at least as many');
});

test('role changes take effect on the very next request', async () => {
  const a = await admin();
  const r = await ctx.login('reporter2@test.invalid');
  assert.equal((await ctx.api('/api/v1/equipment', { method: 'POST', token: r.token, body: { name: 'Nope', categoryId: 1 } })).status, 403);
  ctx.db.run('UPDATE users SET role_id = (SELECT id FROM roles WHERE code = \'technician\') WHERE email = ?', ['reporter2@test.invalid']);
  const promoted = await ctx.api('/api/v1/equipment', { method: 'POST', token: r.token, body: { name: 'Now permitted', categoryId: 1 } });
  expectStatus(promoted, 201, 'capability is resolved per request, not cached at login');
  ctx.db.run('UPDATE users SET role_id = (SELECT id FROM roles WHERE code = \'reporter\') WHERE email = ?', ['reporter2@test.invalid']);
  assert.ok(a.token);
});

test('a deactivated user is cut off mid-session', async () => {
  const r = await ctx.login('reporter2@test.invalid');
  ctx.db.run('UPDATE users SET is_active = 0 WHERE email = ?', ['reporter2@test.invalid']);
  const res = await ctx.api('/api/v1/auth/me', { token: r.token });
  assert.equal(res.status, 401, 'disabling an account also invalidates its live sessions');
  ctx.db.run('UPDATE users SET is_active = 1 WHERE email = ?', ['reporter2@test.invalid']);
});

test('the last administrator cannot be demoted or disabled', async () => {
  const a = await admin();
  const adminId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['admin@test.invalid']);
  ctx.db.run('UPDATE users SET role_id = (SELECT id FROM roles WHERE code = \'technician\') WHERE email = ? ', ['tech@test.invalid']);
  const demote = await ctx.api('/api/v1/users/' + adminId, { method: 'PATCH', token: a.token, body: { roleCode: 'technician' } });
  assert.equal(demote.status, 409, 'refuses to leave the system with no administrator');
  assert.match(demote.body.error.message, /administrator account/i);
  const disable = await ctx.api('/api/v1/users/' + adminId, { method: 'PATCH', token: a.token, body: { isActive: false } });
  assert.equal(disable.status, 409, 'and refuses to deactivate the last one');
});
