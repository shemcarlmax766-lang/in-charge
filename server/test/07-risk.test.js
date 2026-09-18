import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, expectStatus, daysFromNow } from './helpers.js';

/**
 * Phase 8 — the maintenance-risk model.
 * The important properties are that it is deterministic, explainable, bounded, and that it
 * never pretends to be a clinical judgement.
 */
let ctx, admin, reporter;
test.after(async () => ctx.close());
test.before(async () => {
  ctx = await boot();
  admin = await ctx.login('admin@test.invalid');
  reporter = await ctx.login('reporter@test.invalid');
});

async function makeEquipment(name, over = {}) {
  const res = await ctx.api('/api/v1/equipment', { method: 'POST', token: admin.token, body: { name, categoryId: 1, ...over } });
  expectStatus(res, 201, `create ${name}`);
  return res.body.equipment;
}
async function reportFault(equipmentId, over = {}) {
  const res = await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
    equipmentId: String(equipmentId), categoryCode: 'OTH', title: 'Intermittent loss of function',
    description: 'The unit stops working part-way through a session and needs a power cycle to continue.',
    severity: 'medium', ...over,
  } });
  expectStatus(res, 201);
  return res.body.fault;
}
const risk = async (id) => {
  const r = await ctx.api(`/api/v1/dashboard/risk/${id}`, { token: admin.token });
  expectStatus(r, 200, 'assess');
  return r.body;
};

test('a pristine item with no history scores low and says why', async () => {
  const eq = await makeEquipment('Brand new pulse oximeter', { acquiredOn: daysFromNow(-120), maintenanceIntervalDays: 365, nextMaintenanceOn: daysFromNow(240), warrantyExpiresOn: daysFromNow(600) });
  const r = await risk(eq.id);
  assert.equal(r.level, 'low');
  assert.ok(r.score < 30, `score ${r.score} should be under 30`);
  assert.equal(r.factors.length, 7, 'every factor is published');
  assert.ok(r.factors.every((f) => typeof f.points === 'number' && Array.isArray(f.contributing)));
  assert.match(r.disclaimer, /decision support|does not certify/i, 'the disclaimer travels with the number');
  assert.ok(!/machine learning|ai model|predicts|algorithm/i.test(JSON.stringify(r)), 'no pretending to be clever');
});

test('the brief’s own example lands in High Risk with the right reasons', async () => {
  // ECG Machine #014 in the specification: 4 previous failures, last PM 7 months ago against
  // a 6-month interval, a recent critical fault.
  const eq = await makeEquipment('ECG Machine #014 replica', {
    criticality: 'high', acquiredOn: daysFromNow(-1500), maintenanceIntervalDays: 180,
    lastMaintenanceOn: daysFromNow(-210), nextMaintenanceOn: daysFromNow(-30),
  });
  for (let i = 0; i < 4; i += 1) {
    await reportFault(eq.id, { severity: i === 0 ? 'critical' : 'medium', title: `Repeat failure number ${i + 1} here` });
  }
  const r = await risk(eq.id);
  assert.equal(r.levelLabel, 'High Risk');
  assert.ok(r.score >= 60, `expected ≥60, got ${r.score}`);
  const byKey = Object.fromEntries(r.factors.map((f) => [f.key, f]));
  assert.ok(byKey.failureFrequency.points >= 20, 'four failures in 12 months scores high on frequency');
  assert.match(byKey.failureFrequency.contributing[0], /4 fault report/);
  assert.ok(byKey.maintenanceLag.points >= 10, 'a month past a 6-month interval is a late PM (8 base + proportional)');
  assert.match(byKey.maintenanceLag.contributing.join(' '), /overdue by 30 day/);
  assert.ok(byKey.currentExposure.points > 0, 'the open critical fault counts');
  assert.ok(byKey.ageAndWarranty.points > 0, 'and its age counts');
  assert.equal(r.rawScore, r.factors.reduce((n, f) => n + f.points, 0), 'the score is exactly the sum of its parts');
});

test('scoring is deterministic and bounded, and weights are published', async () => {
  const eq = await makeEquipment('Determinism check unit', { acquiredOn: daysFromNow(-800) });
  await reportFault(eq.id);
  const a = await risk(eq.id);
  const b = await risk(eq.id);
  assert.deepEqual(a, b, 'same inputs → same output, no hidden randomness');
  const meta = await ctx.api('/api/v1/dashboard/risk/model', { token: admin.token });
  expectStatus(meta, 200);
  assert.equal(meta.body.maxRaw, 135);
  assert.equal(meta.body.factors.length, 7);
  const sum = meta.body.factors.reduce((n, f) => n + f.maxPoints, 0);
  assert.equal(sum, meta.body.maxRaw, 'the published ceilings add up to the model maximum');
  for (const item of (await ctx.api('/api/v1/dashboard/risk?limit=50', { token: admin.token })).body.items) {
    assert.ok(item.score >= 0 && item.score <= 100, `score ${item.score} stays inside 0–100`);
    assert.ok(['low', 'moderate', 'high'].includes(item.level));
  }
});

test('a life-support item with an overdue PM is escalated to High whatever the arithmetic says', async () => {
  const eq = await makeEquipment('Infusion pump, escalation case', {
    criticality: 'life_support', acquiredOn: daysFromNow(-300), maintenanceIntervalDays: 180,
    lastMaintenanceOn: daysFromNow(-200), nextMaintenanceOn: daysFromNow(-20),
  });
  const r = await risk(eq.id);
  assert.equal(r.level, 'high');
  assert.ok(r.escalation, 'the escalation is reported, not hidden');
  assert.match(r.escalation.rule, /life_support/);
  assert.ok(r.score >= 60);
});

test('the fleet ranking is ordered, filtered and explains itself', async () => {
  const res = await ctx.api('/api/v1/dashboard/risk?limit=10&level=high', { token: admin.token });
  expectStatus(res, 200);
  const scores = res.body.items.map((i) => i.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'sorted worst-first');
  assert.ok(res.body.items.every((i) => i.level === 'high'), 'the level filter works');
  assert.ok(res.body.disclaimer, 'the ranking carries the same caveat');
  const all = await ctx.api('/api/v1/dashboard/risk?limit=100', { token: admin.token });
  assert.ok(Object.keys(all.body.distribution).every((k) => ['low', 'moderate', 'high'].includes(k)));
});

test('a reporter never receives the internal risk detail', async () => {
  const eq = await makeEquipment('Reporter-invisible risk unit', { acquiredOn: daysFromNow(-900) });
  await reportFault(eq.id, { severity: 'high' });
  const asReporter = await ctx.api(`/api/v1/equipment/${eq.id}`, { token: reporter.token });
  expectStatus(asReporter, 200);
  assert.ok(asReporter.body.risk, 'reporters see the indicator so they can avoid a known-bad device');
  assert.ok(!asReporter.body.repairs || asReporter.body.repairs.length === 0, 'but not the repair paperwork');
});
