import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, expectStatus, daysFromNow, TEST_PASSWORD } from './helpers.js';

/** Phase 10 — reports and export: same query for screen, CSV and print, and capability-gated. */
let ctx, admin, tech, reporter;
test.after(async () => ctx.close());
test.before(async () => {
  ctx = await boot();
  admin = await ctx.login('admin@test.invalid');
  tech = await ctx.login('tech@test.invalid');
  reporter = await ctx.login('reporter@test.invalid');
  // give the reports something to say
  const eqId = ctx.ids['ECG Trainer A'];
  await ctx.api(`/api/v1/equipment/${eqId}/status`, { method: 'POST', token: admin.token, body: { status: 'out_of_service', reason: 'Awaiting a part' } });
  const made = await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
    equipmentId: String(eqId), categoryCode: 'ELEC', title: 'No power on either channel',
    description: 'The unit is completely dead at the wall; the outlet is known-good and the fuse looks intact.', severity: 'high',
  } });
  const faultId = made.body.fault.id;
  const techId = ctx.db.value('SELECT id FROM users WHERE email = ?', ['tech@test.invalid']);
  await ctx.api(`/api/v1/faults/${faultId}/assign`, { method: 'POST', token: admin.token, body: { technicianId: techId } });
  await ctx.api(`/api/v1/faults/${faultId}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'under_inspection' } });
  await ctx.api(`/api/v1/faults/${faultId}/repair`, { method: 'PUT', token: tech.token, body: {
    diagnosis: 'Blown mains fuse and damaged inlet', rootCause: 'Power surge', repairActions: 'Replaced fuse and inlet',
    testResults: 'Draws rated current; leakage 12 µA', safetyCheckConfirmed: true, labourCost: 40,
    parts: [{ partName: 'Safety fuse 2A', quantity: 2, unitCost: 1.7 }],
  } });
  await ctx.api(`/api/v1/faults/${faultId}/transition`, { method: 'POST', token: tech.token, body: { targetStatus: 'repaired' } });
  await ctx.api('/api/v1/maintenance/schedules', { method: 'POST', token: admin.token, body: { equipmentId: ctx.ids['Microscope C'], title: 'Annual optics service', intervalDays: 365, nextDueOn: daysFromNow(-5) } });
  await ctx.api('/api/v1/maintenance/records', { method: 'POST', token: tech.token, body: { equipmentId: ctx.ids['Microscope C'], performedOn: daysFromNow(0), findings: 'Cleaned; replaced lamp.', actionsTaken: 'Lamp swap' } });
});

const KEYS = ['inventory', 'faults', 'maintenance', 'costs', 'downtime', 'failures', 'compliance', 'audit'];

test('every declared report runs, is shaped, and answers the brief’s questions', async () => {
  for (const key of KEYS) {
    const res = await ctx.api(`/api/v1/reports/${key}`, { token: admin.token });
    expectStatus(res, 200, key);
    const j = res.body;
    assert.equal(j.key, key);
    assert.ok(j.title && j.description, 'each report labels itself');
    assert.ok(Array.isArray(j.columns) && j.columns.length > 3, `${key} has columns`);
    assert.ok(j.columns.every((c) => c.label), 'every column has a human header');
    assert.ok(Array.isArray(j.rows), 'rows returned');
    assert.equal(j.rowCount, j.rows.length);
    assert.ok(j.generatedAt, 'timestamped');
    // the row keys must match the declared columns, or the CSV would print blanks
    if (j.rows.length) {
      for (const c of j.columns) assert.ok(c.key in j.rows[0], `${key}: column ${c.key} missing from rows`);
    }
  }
});

test('the numbers in the CSV are the numbers on the screen', async () => {
  const json = await ctx.api('/api/v1/reports/costs', { token: admin.token });
  const csvRes = await ctx.api('/api/v1/reports/export/costs/csv', { token: admin.token, raw: true });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  assert.match(csvRes.headers.get('content-disposition'), /attachment; filename="repair-costs-\d{4}-\d{2}-\d{2}\.csv"/);
  const text = await csvRes.text();
  const lines = text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  assert.equal(lines.length, json.body.rows.length + 1, 'header + one line per row');
  assert.ok(lines[0].startsWith('Reference,Date,Equipment'), 'human headers on line 1');
  const totals = json.body.totals;
  assert.ok(totals.total > 0, 'costs were totalled');
  assert.equal(totals.repairs, json.body.rows.length);
  assert.ok(text.includes('Blown mains fuse'), 'the diagnosis survives the export');
});

test('CSV is Excel-safe and neutralises spreadsheet formula injection', async () => {
  // A reporter can put arbitrary text into a fault title; a title starting with "=" would be
  // executed by Excel if exported verbatim.
  await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
    equipmentId: String(ctx.ids['Microscope C']), categoryCode: 'OTH',
    title: '=HYPERLINK("http://evil","click")',
    description: 'A deliberately hostile title used to prove that CSV export escapes formulas.',
    severity: 'low',
  } });
  const csv = await (await ctx.api('/api/v1/reports/export/faults/csv', { token: admin.token, raw: true })).text();
  assert.ok(csv.includes("'=HYPERLINK"), 'leading = is neutralised with an apostrophe');
  assert.ok(!/\n=HYPERLINK/.test(csv), 'never emitted raw');
  const quoted = await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
    equipmentId: String(ctx.ids['Microscope C']), categoryCode: 'OTH',
    title: 'Comma, quote " and newline', description: 'Characters that must survive RFC 4180 quoting in the export without shifting columns.',
    severity: 'low',
  } });
  assert.equal(quoted.status, 201);
  const raw = await (await ctx.api('/api/v1/reports/export/faults/csv', { token: admin.token, raw: true })).arrayBuffer();
  const bytes = Buffer.from(raw);
  assert.ok(bytes.subarray(0, 3).toString('hex') === 'efbbbf', 'UTF-8 BOM so Excel opens the file as Unicode');
  const csv2 = bytes.toString('utf8');
  assert.ok(csv2.includes('"Comma, quote "" and newline"'), 'quotes and commas are escaped');
  assert.ok(csv2.endsWith('\r\n'), 'and the file ends with a proper line break');
});

test('report filters narrow the rows and disagree nothing', async () => {
  const all = await ctx.api('/api/v1/reports/faults', { token: admin.token });
  const narrow = await ctx.api(`/api/v1/reports/faults?from=${daysFromNow(0)}&to=${daysFromNow(0)}`, { token: admin.token });
  expectStatus(narrow, 200);
  assert.ok(narrow.body.rows.length <= all.body.rows.length, 'a one-day window cannot exceed the total');
  assert.ok(narrow.body.rows.every((r) => r.createdAt.slice(0, 10) === daysFromNow(0)), 'every returned row is inside the window');
  const byEquipment = await ctx.api(`/api/v1/reports/faults?equipmentId=${ctx.ids['Microscope C']}`, { token: admin.token });
  assert.ok(byEquipment.body.rows.every((r) => r.equipmentLabel.includes('Microscope C')));
  const inverted = await ctx.api('/api/v1/reports/faults?from=2026-05-01&to=2026-01-01', { token: admin.token });
  expectStatus(inverted, 400, 'a reversed window is refused, not silently empty');
});

test('the printable view is self-contained and prints safely', async () => {
  const res = await ctx.api('/api/v1/reports/export/inventory/print', { token: admin.token, raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Equipment inventory/, 'titled for the PDF filename');
  assert.match(html, /@media print/, 'carries a print stylesheet');
  assert.match(html, /window\.print\(\)/, 'offers the print action');
  assert.match(html, /do not certify equipment safety/, 'and repeats the safety boundary on the page');
  // The print button is the *only* script allowed, and it must be authorised by the
  // per-response CSP nonce — inline handlers would have been silently blocked by `default-src 'none'`.
  const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  assert.equal(scripts.length, 1, 'exactly one script element (the print binding)');
  const script = scripts[0];
  assert.match(script, /window\.print\(\)/, 'that script only triggers the browser print dialog');
  assert.ok(!/<script(?![^>]*\snonce=")/i.test(script), 'and it carries a nonce');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/, 'the print page is locked down');
  const htmlNonce = /nonce="([^"]+)"/.exec(script)?.[1];
  assert.ok(htmlNonce && csp.includes(`'nonce-${htmlNonce}'`), 'the script nonce matches the CSP');
  const injected = await ctx.api(`/api/v1/reports/export/audit/print`, { token: admin.token, raw: true });
  assert.equal(injected.status, 200, 'the audit report prints too');
  await injected.text();
});

test('reports are capability-gated, per report', async () => {
  for (const [who, allowed] of [[admin, true], [tech, false], [reporter, false]]) {
    const res = await ctx.api('/api/v1/reports/audit', { token: who.token });
    // the audit report needs audit.view: admin only
    assert.equal(res.status, allowed ? 200 : 403, `${who.user.email} → audit report ${allowed ? 'allowed' : 'refused'}`);
  }
  const techCosts = await ctx.api('/api/v1/reports/costs', { token: tech.token });
  assert.equal(techCosts.status, 403, 'cost reporting is an administrator function');
  const list = await ctx.api('/api/v1/reports', { token: reporter.token });
  expectStatus(list, 200, 'the catalogue itself is visible so the UI can say "ask the administrator"');
  assert.deepEqual(list.body.items, [], 'but a reporter is offered none of them');
  const unknown = await ctx.api('/api/v1/reports/secret-report', { token: admin.token });
  expectStatus(unknown, 422, 'an unknown report key is a validation error');
});

test('downtime and failures reports derive from the same status trail as the profile', async () => {
  const dt = await ctx.api('/api/v1/reports/downtime', { token: admin.token });
  expectStatus(dt, 200);
  const row = dt.body.rows.find((r) => r.assetTag === ctx.db.value('SELECT asset_tag FROM equipment WHERE id = ?', [ctx.ids['ECG Trainer A']]));
  assert.ok(row, 'the item appears');
  assert.ok(row.incidents >= 1, 'its out-of-service period is counted');
  assert.ok(row.availabilityPercent <= 100 && row.availabilityPercent >= 0);
  const profile = await ctx.api(`/api/v1/equipment/${ctx.ids['ECG Trainer A']}`, { token: admin.token });
  assert.equal(Math.round(row.days * 10), Math.round((profile.body.downtime.days ?? 0) * 10), 'report and profile agree to the day');

  const fl = await ctx.api('/api/v1/reports/failures', { token: admin.token });
  expectStatus(fl, 200);
  assert.ok(fl.body.rows.length >= 1);
  assert.deepEqual(fl.body.rows.map((r) => r.faults), [...fl.body.rows.map((r) => r.faults)].sort((a, b) => b - a), 'ranked worst-first');
  assert.ok(fl.body.rows[0].riskScore !== undefined && fl.body.rows[0].riskLevel, 'the risk indicator rides along on the ranking');
});

test('settings appear in exports, so a report is attributable to its department', async () => {
  expectStatus(await ctx.api('/api/v1/reference/settings', { method: 'PATCH', token: admin.token, body: { department_name: 'Biomedical Engineering Unit', institution_name: 'Test Institute of Health Sciences' } }), 200);
  const html = await (await ctx.api('/api/v1/reports/export/inventory/print', { token: admin.token, raw: true })).text();
  assert.ok(html.includes('Test Institute of Health Sciences'), 'institution from settings');
  assert.ok(html.includes('Biomedical Engineering Unit'), 'department from settings');
});
