import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, expectStatus, fieldErrors } from './helpers.js';

/** Phase 5 — the technician repair record, parts, costs and the return-to-service gate. */
let ctx, admin, tech, reporter;
test.after(async () => ctx.close());
test.before(async () => {
  ctx = await boot();
  admin = await ctx.login('admin@test.invalid');
  tech = await ctx.login('tech@test.invalid');
  reporter = await ctx.login('reporter@test.invalid');
});

let seq = 0;
async function newFault(over = {}) {
  seq += 1;
  const eq = await ctx.api('/api/v1/equipment', { method: 'POST', token: admin.token, body: { name: `Repair target ${seq}`, categoryId: 1 } });
  const made = await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
    equipmentId: String(eq.body.equipment.id), categoryCode: 'ELEC', title: `Fault ${seq} needing repair work`,
    description: `Reproducible symptom number ${seq}: the unit loses power a few minutes after every cold start during class.`,
    severity: 'high', ...over,
  } });
  expectStatus(made, 201);
  return { fault: made.body.fault, equipment: made.body.equipment };
}

const complete = {
  diagnosis: 'Failed mains filter and swollen electrolytic on the power input board',
  rootCause: 'Mains surge during a storm; no fitted surge protection on that bench',
  troubleshooting: 'Voltage check at the input, substitution test with a known-good board, thermal inspection',
  repairActions: 'Replaced the mains filter and the two input capacitors, fitted a surge protector at the bench',
  testResults: 'Earth bond 0.12 Ω, protective leakage 24 µA, patient leakage 6 µA; 4 h continuous run at load, no shutdown',
  safetyCheckConfirmed: true,
};

test('a draft repair record can be saved but does not unlock "repaired"', async () => {
  const { fault } = await newFault();
  await ctx.api(`/api/v1/faults/${fault.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'under_inspection' } });
  await ctx.api(`/api/v1/faults/${fault.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'under_repair' } });
  const draft = await ctx.api(`/api/v1/faults/${fault.id}/repair`, { method: 'PUT', token: tech.token, body: {
    diagnosis: 'Suspected power input failure', rootCause: 'Under investigation', repairActions: 'Board removed for bench testing',
  } });
  expectStatus(draft, 200, 'technicians may save partial findings while the device is open');
  assert.equal(draft.body.record.testResults, '', 'test results not yet recorded');
  assert.equal(draft.body.readiness.canMarkRepaired, false);
  assert.deepEqual(draft.body.readiness.missing.sort(), ['safetyCheckConfirmed', 'testResults'].sort(), 'it says exactly what is still needed');

  const blocked = await ctx.api(`/api/v1/faults/${fault.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'repaired' } });
  expectStatus(blocked, 409, 'the gate holds');
  assert.deepEqual(blocked.body.error.details.missing.sort(), ['safetyCheckConfirmed', 'testResults'].sort());
});

test('costs are derived from the parts lines, never from the client total', async () => {
  const { fault } = await newFault();
  const parts = ctx.db.all('SELECT id, unit_cost FROM replacement_parts ORDER BY id');
  const res = await ctx.api(`/api/v1/faults/${fault.id}/repair`, { method: 'PUT', token: tech.token, body: {
    ...complete,
    labourCost: 60, otherCost: 12.5,
    totalCost: 999999, // a tampered payload must be ignored
    parts: [
      { partId: parts[0].id, quantity: 2 },
      { partName: 'Bench-supplied fuse holder', partNumber: 'FH-9', quantity: 1, unitCost: 7.75 },
    ],
  } });
  expectStatus(res, 200);
  const r = res.body.record;
  const expectedParts = Math.round((parts[0].unit_cost * 2 + 7.75) * 100) / 100;
  assert.equal(r.partsCost, expectedParts, 'catalogue + free-text lines both priced');
  assert.equal(r.totalCost, Math.round((expectedParts + 60 + 12.5) * 100) / 100, 'total = parts + labour + other');
  assert.notEqual(r.totalCost, 999999, 'the client-supplied total was ignored');
  assert.equal(r.parts.length, 2);
  assert.equal(r.parts[0].partName, 'Fuse kit', 'the part name is snapshotted into the line');
  assert.equal(r.partsReplacedSummary.includes('Fuse kit'), true);
  assert.equal(r.signOffReady, true);
});

test('negative costs, future dates and calibration claims are rejected', async () => {
  const { fault } = await newFault();
  const negative = await ctx.api(`/api/v1/faults/${fault.id}/repair`, { method: 'PUT', token: tech.token, body: { ...complete, labourCost: -50 } });
  expectStatus(negative, 422, "negative money never reaches the service");
  assert.ok(fieldErrors(negative).labourCost);

  const future = await ctx.api(`/api/v1/faults/${fault.id}/repair`, { method: 'PUT', token: tech.token, body: { ...complete, dateRepaired: '2099-01-01' } });
  expectStatus(future, 422, 'the date repaired cannot be in the future');

  const cal = await ctx.api(`/api/v1/faults/${fault.id}/repair`, { method: 'PUT', token: tech.token, body: { ...complete, calibrationPerformed: true } });
  expectStatus(cal, 400, 'claiming a calibration requires describing it');
  assert.ok(fieldErrors(cal).calibrationDetails);

  const thin = await ctx.api(`/api/v1/faults/${fault.id}/repair`, { method: 'PUT', token: tech.token, body: { ...complete, diagnosis: 'bad' } });
  expectStatus(thin, 422, 'a one-word diagnosis is not a record');
});

test('full path: record the repair, return to service, verify, close', async () => {
  const { fault, equipment } = await newFault();
  const techId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']);
  await ctx.api(`/api/v1/faults/${fault.id}/assign`, { method: 'POST', token: admin.token, body: { technicianId: techId } });
  await ctx.api(`/api/v1/faults/${fault.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'under_inspection' } });
  await ctx.api(`/api/v1/faults/${fault.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'under_repair' } });

  const saved = await ctx.api(`/api/v1/faults/${fault.id}/repair`, { method: 'PUT', token: tech.token, body: {
    ...complete, parts: [{ partName: 'Mains filter', quantity: 1, unitCost: 22 }], labourCost: 45, calibrationPerformed: true,
    calibrationDetails: 'Verified the internal reference against a calibrated multimeter; deviation 0.3 %, within tolerance.',
  } });
  expectStatus(saved, 200);
  assert.equal(saved.body.readiness.canMarkRepaired, true);

  const repaired = await ctx.api(`/api/v1/faults/${fault.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'repaired', comment: 'Bench tests complete' } });
  expectStatus(repaired, 200);
  assert.equal(repaired.body.equipment.status, 'operational');
  assert.equal(repaired.body.fault.diagnosisConfirmed, true);

  // The repair is now visible in the equipment profile the department reads.
  const profile = await ctx.api(`/api/v1/equipment/${equipment.id}`, { token: admin.token });
  assert.equal(profile.body.repairs.length, 1);
  assert.equal(profile.body.repairs[0].parts.length, 1);
  assert.match(profile.body.repairs[0].diagnosis, /mains filter/i);
  assert.equal(profile.body.equipment.lastFaultAt !== null, true);
});

test('a technician who says it is NOT safe to return cannot close the loop', async () => {
  const { fault, equipment } = await newFault();
  const techId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']);
  await ctx.api(`/api/v1/faults/${fault.id}/assign`, { method: 'POST', token: admin.token, body: { technicianId: techId } });
  await ctx.api(`/api/v1/faults/${fault.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'under_repair' } });
  await ctx.api(`/api/v1/faults/${fault.id}/repair`, { method: 'PUT', token: tech.token, body: {
    ...complete, safeToReturnToService: false, notes: 'Insulation resistance out of specification; quarantined pending a replacement unit.',
  } });
  const tryRepaired = await ctx.api(`/api/v1/faults/${fault.id}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'repaired' } });
  expectStatus(tryRepaired, 409, 'the safety decision is binding');
  assert.match(tryRepaired.body.error.message, /not safe|Out of Service/i);
  const still = await ctx.api(`/api/v1/faults/${fault.id}`, { token: tech.token });
  assert.equal(still.body.equipment.status, 'under_repair', 'the equipment stays out of circulation');
  assert.equal(still.body.fault.status, 'under_repair', 'and the fault stays open');

  // And the administrator cannot override it by writing their own diagnosis or by forcing
  // the equipment status back to operational while the fault is open.
  const force = await ctx.api(`/api/v1/equipment/${equipment.id}/status`, { method: 'POST', token: admin.token, body: { status: 'operational' } });
  expectStatus(force, 409, 'equipment with an unresolved fault cannot be declared operational');
  assert.match(force.body.error.message, /unresolved fault/i);
});

test('repair evidence is attached to the record, and only by its owner while open', async () => {
  const { fault } = await newFault();
  const techId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']);
  await ctx.api(`/api/v1/faults/${fault.id}/assign`, { method: 'POST', token: admin.token, body: { technicianId: techId } });
  const before = ctx.db.value('SELECT COUNT(*) FROM attachments');

  const noRecord = await ctx.api(`/api/v1/faults/${fault.id}/repair/photos`, {
    method: 'POST', token: tech.token, formData: multipartHelper({ kind: 'before_photo' }, ['x.png']),
  });
  assert.equal(noRecord.status, 400, 'evidence needs a repair record to belong to');

  await ctx.api(`/api/v1/faults/${fault.id}/repair`, { method: 'PUT', token: tech.token, body: complete });
  const { PNG_1PX } = await import('./helpers.js');
  const fd = new FormData();
  fd.append('kind', 'after_photo');
  fd.append('files', new Blob([PNG_1PX], { type: 'image/png' }), 'repaired-board.png');
  const up = await ctx.api(`/api/v1/faults/${fault.id}/repair/photos`, { method: 'POST', token: tech.token, formData: fd });
  expectStatus(up, 201, 'photo attached');
  assert.equal(up.body.added, 1);
  const att = ctx.db.get('SELECT * FROM attachments WHERE id = ?', [up.body.items[0].id]);
  assert.equal(att.kind, 'after_photo');
  assert.equal(att.owner_type, 'repair_record');
  assert.notEqual(att.stored_name, 'repaired-board.png', 'stored under a generated name, not the user’s');
  assert.equal(ctx.db.value('SELECT COUNT(*) FROM attachments'), before + 1);
});

function multipartHelper(fields, names) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('files', new Blob([Buffer.from('not an image')], { type: 'image/png' }), names[0]);
  return fd;
}
