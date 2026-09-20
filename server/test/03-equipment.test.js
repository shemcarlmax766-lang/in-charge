import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, expectStatus, fieldErrors } from './helpers.js';

/** Phase 2/3 — inventory records, QR identity, status rules. */
let ctx;
test.after(async () => ctx.close());
test.before(async () => { ctx = await boot(); });

test('creating equipment derives an asset tag, PM dates and a QR payload', async () => {
  const a = await ctx.login('admin@test.invalid');
  const res = await ctx.api('/api/v1/equipment', { method: 'POST', token: a.token, body: {
    name: 'Defibrillator Trainer', categoryId: 2, manufacturer: 'Testec', model: 'T-500',
    serialNumber: 'SN-TEST-0001', criticality: 'high', maintenanceIntervalDays: 90,
    acquiredOn: '2024-03-01', locationId: 1,
  } });
  expectStatus(res, 201, 'create');
  const e = res.body.equipment;
  assert.match(e.assetTag, /^BMU-MON-\d{4}$/, 'tag carries the category code and a sequence');
  assert.equal(e.status, 'operational');
  assert.ok(e.nextMaintenanceOn, 'a due date is computed from the interval');
  assert.ok(res.body.qr.url.includes(e.assetTag), 'QR target is the asset tag');
  const id = e.id;
  const png = await ctx.api(`/api/v1/equipment/${id}/qr.png`, { token: a.token, raw: true });
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.ok(Number(png.headers.get('content-length')) > 200, 'a real PNG was rendered');
  png.body?.cancel?.();
});

test('asset tags are unique per category and survive concurrent-looking input', async () => {
  const a = await ctx.login('admin@test.invalid');
  const tags = new Set();
  for (let i = 0; i < 5; i += 1) {
    const res = await ctx.api('/api/v1/equipment', { method: 'POST', token: a.token, body: { name: `Duplicate test ${i}`, categoryId: 3 } });
    expectStatus(res, 201);
    assert.ok(!tags.has(res.body.equipment.assetTag), 'each new item gets a fresh tag');
    tags.add(res.body.equipment.assetTag);
  }
});

test('validation rejects bad references, duplicate serials and impossible dates', async () => {
  const a = await ctx.login('admin@test.invalid');
  const badCategory = await ctx.api('/api/v1/equipment', { method: 'POST', token: a.token, body: { name: 'X-ray Machine', categoryId: 999 } });
  expectStatus(badCategory, 400);
  assert.ok(fieldErrors(badCategory).categoryId, 'per-field error for the unknown category');

  const dupSerial = await ctx.api('/api/v1/equipment', { method: 'POST', token: a.token, body: { name: 'Clone', categoryId: 1, serialNumber: 'SN-TEST-0001' } });
  expectStatus(dupSerial, 409, 'serial numbers must be unique');
  assert.match(dupSerial.body.error.message, /already used/i);

  const backwards = await ctx.api('/api/v1/equipment', { method: 'POST', token: a.token, body: { name: 'Time travel', categoryId: 1, acquiredOn: '2024-01-01', warrantyExpiresOn: '2020-01-01' } });
  expectStatus(backwards, 400, 'warranty cannot expire before acquisition');

  const tooShort = await ctx.api('/api/v1/equipment', { method: 'POST', token: a.token, body: { name: 'x', categoryId: 1 } });
  expectStatus(tooShort, 422);
  assert.ok(fieldErrors(tooShort).name);

  const nonsenseDate = await ctx.api('/api/v1/equipment', { method: 'POST', token: a.token, body: { name: 'Leap day', categoryId: 1, acquiredOn: '2023-02-30' } });
  expectStatus(nonsenseDate, 422, 'a non-existent calendar date is rejected, not coerced');
});

test('search covers id, name, serial, manufacturer, model, location and category', async () => {
  const a = await ctx.login('admin@test.invalid');
  const q = async (search) => (await ctx.api(`/api/v1/equipment?q=${encodeURIComponent(search)}`, { token: a.token })).body;
  assert.ok((await q('Defibrillator')).pagination.total >= 1, 'by name');
  assert.ok((await q('SN-TEST-0001')).pagination.total === 1, 'by serial');
  assert.ok((await q('Testec')).pagination.total >= 1, 'by manufacturer');
  assert.ok((await q('T-500')).pagination.total >= 1, 'by model');
  assert.ok((await q('Physiology')).pagination.total >= 1, 'by location name');
  assert.ok((await q('Microscope')).pagination.total >= 1, 'by category name');
  assert.equal((await q('no-such-thing-at-all')).pagination.total, 0, 'nonsense finds nothing');
});

test('parameterised queries mean a search string cannot inject SQL', async () => {
  const a = await ctx.login('admin@test.invalid');
  for (const payload of ["' OR 1=1 --", "'; DROP TABLE equipment; --", '%', '_', '\\', '"OR""']) {
    const res = await ctx.api(`/api/v1/equipment?q=${encodeURIComponent(payload)}`, { token: a.token });
    assert.equal(res.status, 200, `payload ${JSON.stringify(payload)} must be treated as text`);
  }
  assert.ok(ctx.db.value('SELECT COUNT(*) FROM equipment') > 0, 'the table still exists and still has rows');
  const injectedSort = await ctx.api('/api/v1/equipment?sort=id;DROP+TABLE+users', { token: a.token });
  assert.equal(injectedSort.status, 200, 'an unknown sort key falls back to the default, never to raw SQL');
  const bogusDir = await ctx.api('/api/v1/equipment?dir=hack', { token: a.token });
  assert.equal(bogusDir.status, 422, 'an unknown enum value is rejected explicitly rather than guessed');
  assert.ok(fieldErrors(bogusDir).dir);
});

test('filters combine with pagination that cannot lie about totals', async () => {
  const a = await ctx.login('admin@test.invalid');
  const all = await ctx.api('/api/v1/equipment?perPage=2', { token: a.token });
  assert.equal(all.body.items.length, 2);
  assert.ok(all.body.pagination.total >= 6);
  const page2 = await ctx.api('/api/v1/equipment?perPage=2&page=2', { token: a.token });
  assert.notEqual(page2.body.items[0].id, all.body.items[0].id, 'page 2 differs from page 1');
  const overdue = await ctx.api('/api/v1/equipment?maintenanceState=overdue', { token: a.token });
  assert.ok(overdue.body.items.every((e) => e.maintenanceState === 'overdue'), 'PM filter is honoured');
  const status = await ctx.api('/api/v1/equipment?status=operational&categoryId=1', { token: a.token });
  assert.ok(status.body.items.every((e) => e.status === 'operational' && e.categoryId === 1), 'combined filters');
  const tooBig = await ctx.api('/api/v1/equipment?perPage=5000', { token: a.token });
  assert.ok(tooBig.body.pagination.perPage <= 100, 'page size is clamped to the server maximum');
});
test('equipment status changes are always explained and always recorded', async () => {
  const a = await ctx.login('admin@test.invalid');
  const id = ctx.ids['Microscope C'];
  const noReason = await ctx.api(`/api/v1/equipment/${id}/status`, { method: 'POST', token: a.token, body: { status: 'out_of_service' } });
  expectStatus(noReason, 400, 'out-of-service needs a reason');
  assert.ok(fieldErrors(noReason).reason);

  const ok = await ctx.api(`/api/v1/equipment/${id}/status`, { method: 'POST', token: a.token, body: { status: 'out_of_service', reason: 'Awaiting parts from the supplier' } });
  expectStatus(ok, 200);
  assert.equal(ok.body.equipment.status, 'out_of_service');
  const history = ctx.db.all('SELECT from_status, to_status, reason FROM equipment_status_history WHERE equipment_id = ? ORDER BY id', [id]);
  assert.equal(history.at(-1).to_status, 'out_of_service');
  assert.equal(history.at(-1).from_status, 'operational');
  assert.match(history.at(-1).reason, /Awaiting parts/);
});

test('deleting an item with history is refused; deactivation is offered instead', async () => {
  const a = await ctx.login('admin@test.invalid');
  const eq = ctx.ids['ECG Trainer A'];
  const r = await ctx.login('reporter@test.invalid');
  const fault = await ctx.api('/api/v1/faults', { method: 'POST', token: r.token, body: {
    equipmentId: String(eq), categoryCode: 'OTH', title: 'Loose power switch', severity: 'medium',
    description: 'The power switch has to be held at an angle for the unit to stay on.',
  } });
  expectStatus(fault, 201);

  const naive = await ctx.api(`/api/v1/equipment/${eq}`, { method: 'DELETE', token: a.token, body: {} });
  assert.equal(naive.status, 400, 'deletion requires typing the asset tag');
  const confirmed = await ctx.api(`/api/v1/equipment/${eq}`, { method: 'DELETE', token: a.token, body: { confirmTag: 'BMU-ECG-0001' } });
  assert.equal(confirmed.status, 409, 'history blocks deletion');
  assert.match(confirmed.body.error.message, /Deactivate|Decommission/i, 'and the error says what to do instead');
  assert.ok(ctx.db.value('SELECT COUNT(*) FROM fault_reports WHERE equipment_id = ?', [eq]) > 0, 'the fault still exists');

  const deactivated = await ctx.api(`/api/v1/equipment/${eq}/deactivate`, { method: 'POST', token: a.token, body: { reason: 'Retired from teaching' } });
  expectStatus(deactivated, 200);
  assert.equal(deactivated.body.isActive, false);
  assert.equal(ctx.db.value('SELECT is_active FROM equipment WHERE id = ?', [eq]), 0);
});

test('a clean record with no history can be deleted after confirmation', async () => {
  const a = await ctx.login('admin@test.invalid');
  const made = await ctx.api('/api/v1/equipment', { method: 'POST', token: a.token, body: { name: 'Accidentally duplicated item', categoryId: 3 } });
  const id = made.body.equipment.id;
  const wrongTag = await ctx.api(`/api/v1/equipment/${id}`, { method: 'DELETE', token: a.token, body: { confirmTag: 'BMU-WRONG-9999' } });
  expectStatus(wrongTag, 400, 'mistyped confirmation is refused');
  const res = await ctx.api(`/api/v1/equipment/${id}`, { method: 'DELETE', token: a.token, body: { confirmTag: made.body.equipment.assetTag } });
  expectStatus(res, 200, 'delete');
  assert.equal(ctx.db.value('SELECT COUNT(*) FROM equipment WHERE id = ?', [id]), 0);
});

test('the QR asset tag resolves the equipment profile', async () => {
  const a = await ctx.login('admin@test.invalid');
  const fresh = await ctx.api('/api/v1/equipment', { method: 'POST', token: a.token, body: { name: 'Tag lookup target', categoryId: 1 } });
  expectStatus(fresh, 201);
  const tag = fresh.body.equipment.assetTag;
  const byTag = await ctx.api(`/api/v1/equipment/${tag}`, { token: a.token });
  expectStatus(byTag, 200);
  assert.equal(byTag.body.equipment.name, 'Tag lookup target', 'the tag resolves to exactly that item');
  const publicView = await ctx.api(`/api/v1/public/equipment/${tag}`);
  expectStatus(publicView, 200, 'the QR scan target works without an account');
  assert.equal(publicView.body.assetTag, tag);
  assert.ok(!('serialNumber' in publicView.body), 'the public view withholds the serial number');
  assert.ok(!('notes' in publicView.body), 'and withholds internal notes');
  const missing = await ctx.api('/api/v1/public/equipment/BMU-NOPE-9999');
  assert.equal(missing.status, 404);
});

test('reporters see the profile without internal cost and repair detail', async () => {
  const r = await ctx.login('reporter@test.invalid');
  const id = ctx.ids['ECG Trainer A'];
  const res = await ctx.api(`/api/v1/equipment/${id}`, { token: r.token });
  expectStatus(res, 200);
  assert.deepEqual(res.body.repairs, undefined, 'no repair provenance for reporters');
  assert.equal(res.body.equipment.serialNumber, null, 'serial hidden');
  assert.equal(res.body.equipment.notes, null, 'internal notes hidden');
  assert.equal(res.body.statistics.lifetimeRepairCost, null, 'costs hidden');
  assert.ok(res.body.permissions.canEdit === false && res.body.permissions.canReport === true, 'capabilities shape the payload');
  const a = await ctx.login('admin@test.invalid');
  const full = await ctx.api(`/api/v1/equipment/${id}`, { token: a.token });
  assert.ok(Array.isArray(full.body.repairs), 'admins do get the repair history');
});
