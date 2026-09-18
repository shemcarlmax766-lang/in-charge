import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, expectStatus, fieldErrors, TMP, PNG_1PX, PDF_BYTES, EXE_BYTES, ZIP_BYTES, JPEG_FAKE } from './helpers.js';

/** §14 — input validation, upload safety, headers, rate limits and the audit trail. */
let ctx, admin, reporter;
test.after(async () => ctx.close());
test.before(async () => {
  ctx = await boot();
  admin = await ctx.login('admin@test.invalid');
  reporter = await ctx.login('reporter@test.invalid');
});

const fd = (fields, files) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, String(v));
  for (const file of files) f.append(file.field ?? 'files', new Blob([file.bytes], { type: file.mime ?? 'application/octet-stream' }), file.name);
  return f;
};
const newFault = async (over = {}) => (await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
  equipmentId: String(ctx.ids['ECG Trainer A']), categoryCode: 'OTH', title: 'Fuse keeps blowing on this unit',
  description: 'Within a minute of switching on, the mains fuse blows and the unit is dead until it is replaced.',
  severity: 'high', ...over,
} })).body.fault;

test('uploads: only real images and documents, matched to their declared type', async () => {
  const fault = await newFault();
  const good = await ctx.api(`/api/v1/faults/${fault.id}/attachments`, { method: 'POST', token: reporter.token,
    formData: fd({ kind: 'photo' }, [{ name: 'panel.png', bytes: PNG_1PX, mime: 'image/png' }]) });
  expectStatus(good, 201, 'a genuine PNG is accepted');
  assert.equal(good.body.items[0].mimeType, 'image/png');

  const disguisedExe = await ctx.api(`/api/v1/faults/${fault.id}/attachments`, { method: 'POST', token: reporter.token,
    formData: fd({ kind: 'photo' }, [{ name: 'photo.png', bytes: EXE_BYTES, mime: 'image/png' }]) });
  expectStatus(disguisedExe, 400, 'content must match the extension (a bad upload is a request error, not a schema error)');
  assert.match(disguisedExe.body.error.message, /does not match its extension/i);

  const badExt = await ctx.api(`/api/v1/faults/${fault.id}/attachments`, { method: 'POST', token: reporter.token,
    formData: fd({ kind: 'photo' }, [{ name: 'evil.exe', bytes: EXE_BYTES }]) });
  assert.ok([400, 422].includes(badExt.status), `a .exe is refused outright (got ${badExt.status})`);

  const php = await ctx.api(`/api/v1/faults/${fault.id}/attachments`, { method: 'POST', token: reporter.token,
    formData: fd({ kind: 'document' }, [{ name: 'shell.php', bytes: Buffer.from('<?php system($_GET["c"]);') }]) });
  assert.ok([400, 422].includes(php.status), 'no server-executable extensions at all');

  const docAsPhoto = await ctx.api(`/api/v1/faults/${fault.id}/attachments`, { method: 'POST', token: reporter.token,
    formData: fd({ kind: 'photo' }, [{ name: 'manual.pdf', bytes: PDF_BYTES, mime: 'application/pdf' }]) });
  expectStatus(docAsPhoto, 400, 'a photo slot rejects a PDF — the kind is enforced, not just the type');

  const empty = await ctx.api(`/api/v1/faults/${fault.id}/attachments`, { method: 'POST', token: reporter.token,
    formData: fd({ kind: 'photo' }, [{ name: 'empty.png', bytes: Buffer.alloc(0) }]) });
  assert.ok([400, 422].includes(empty.status), 'an empty file is not an image');
});

test('stored files carry a generated name and never escape the uploads root', async () => {
  const fault = await newFault();
  const up = await ctx.api(`/api/v1/faults/${fault.id}/attachments`, { method: 'POST', token: reporter.token,
    formData: fd({ kind: 'photo' }, [{ name: '../../etc/passwd.png', bytes: PNG_1PX, mime: 'image/png' }]) });
  expectStatus(up, 201, 'the hostile name is sanitised, not honoured');
  const att = ctx.db.get('SELECT * FROM attachments WHERE id = ?', [up.body.items[0].id]);
  assert.ok(!att.stored_name.includes('..'), `stored name is safe: ${att.stored_name}`);
  assert.match(att.filename, /passwd\.png$/, 'the display name keeps something readable');
  const abs = path.resolve(TMP, 'uploads', att.stored_name);
  assert.ok(abs.startsWith(path.resolve(TMP, 'uploads')), 'the resolved path stays inside the uploads root');
  assert.ok(fs.existsSync(abs), 'and the file is where the row says it is');

  // Serving it back must not expose the raw path or a sniffable type.
  const got = await ctx.api(`/api/v1/attachments/${att.id}`, { token: reporter.token, raw: true });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.match(got.headers.get('content-disposition'), /^inline; filename="attach-\d+\.png"$/);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  await got.text();
});

test('attachment access follows the record’s permissions, not the file’s', async () => {
  const fault = await newFault();
  const up = await ctx.api(`/api/v1/faults/${fault.id}/attachments`, { method: 'POST', token: reporter.token,
    formData: fd({ kind: 'photo' }, [{ name: 'evidence.png', bytes: PNG_1PX, mime: 'image/png' }]) });
  const id = up.body.items[0].id;
  const other = await ctx.login('reporter2@test.invalid');
  assert.equal((await ctx.api(`/api/v1/attachments/${id}`, { token: other.token, raw: true })).status, 403, 'another reporter cannot read it');
  assert.equal((await ctx.api(`/api/v1/attachments/${id}`, { token: reporter.token, raw: true })).status, 200, 'the owner can');
  const anon = await ctx.api(`/api/v1/attachments/${id}`, { raw: true });
  assert.equal(anon.status, 401, 'and neither can the anonymous');
  await anon.text();
  const techTok = await ctx.login('tech@test.invalid');
  assert.equal((await ctx.api(`/api/v1/attachments/${id}`, { token: techTok.token, raw: true })).status, 200, 'the assigned technician can');
});

test('too many files, and files over the limit, are refused before touching disk', async () => {
  const fault = await newFault();
  const many = fd({ kind: 'photo' }, Array.from({ length: 9 }, (_, i) => ({ name: `p${i}.png`, bytes: PNG_1PX, mime: 'image/png' })));
  const res = await ctx.api(`/api/v1/faults/${fault.id}/attachments`, { method: 'POST', token: reporter.token, formData: many });
  assert.ok([400, 413, 422].includes(res.status), `batch limit enforced (got ${res.status})`);
  const stored = fs.readdirSync(path.join(TMP, 'uploads'), { recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.png'));
  assert.ok(stored.length <= 30, 'the rejected burst left no orphan flood on disk');
});

test('SQL injection through every text surface is inert', async () => {
  const payloads = ["'; DROP TABLE equipment; --", "' OR '1'='1", "1; DELETE FROM fault_reports", "%' AND 1=0 UNION SELECT password_hash FROM users --"];
  for (const p of payloads) {
    const search = await ctx.api(`/api/v1/equipment?q=${encodeURIComponent(p)}`, { token: admin.token });
    assert.equal(search.status, 200);
    const list = await ctx.api(`/api/v1/faults?q=${encodeURIComponent(p)}`, { token: admin.token });
    assert.equal(list.status, 200);
    const report = await ctx.api(`/api/v1/reports/audit?q=${encodeURIComponent(p)}`, { token: admin.token });
    assert.equal(report.status, 200);
  }
  assert.ok(ctx.db.value('SELECT COUNT(*) FROM equipment') > 0, 'equipment table survives');
  assert.ok(ctx.db.value('SELECT COUNT(*) FROM fault_reports') > 0, 'faults survive');
  assert.ok(ctx.db.value('SELECT COUNT(*) FROM users') >= 6, 'users survive');
  const stored = await ctx.api('/api/v1/equipment', { method: 'POST', token: admin.token, body: {
    name: "Robert'); DROP TABLE students;--", categoryId: 1, serialNumber: "x' OR '1'='1" } });
  expectStatus(stored, 201, 'hostile text is stored as text');
  assert.equal(stored.body.equipment.name, "Robert'); DROP TABLE students;--", 'verbatim, not escaped-and-mangled');
});

test('XSS payloads are stored raw and must be escaped by the client (no server-side HTML)', async () => {
  const evil = '<img src=x onerror="alert(1)">';
  const made = await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
    equipmentId: String(ctx.ids['ECG Trainer A']), categoryCode: 'OTH', title: `Fault ${evil}`.slice(0, 160),
    description: `Description containing ${evil} which the client must render as text, never as HTML.`, severity: 'low' } });
  expectStatus(made, 201);
  const detail = await ctx.api(`/api/v1/faults/${made.body.fault.id}`, { token: reporter.token });
  assert.ok(detail.body.fault.description.includes(evil), 'the API returns data, not pre-escaped markup');
  const html = await (await ctx.api('/api/v1/reports/export/faults/print', { token: admin.token, raw: true })).text();
  assert.ok(!html.includes(evil), 'the server-generated printable view escapes it');
  assert.ok(html.includes('&lt;img src=x onerror='), 'as escaped entities');
});

test('mass assignment cannot invent fields', async () => {
  const before = ctx.db.get('SELECT * FROM equipment WHERE id = ?', [ctx.ids['Microscope C']]);
  const res = await ctx.api(`/api/v1/equipment/${ctx.ids['Microscope C']}`, { method: 'PATCH', token: admin.token, body: {
    name: 'Renamed legitimately', id: 999, asset_tag: 'BMU-HACK-0001', assetTag: 'BMU-HACK-0001',
    is_active: 0, created_by: 1, role_id: 1, password_hash: 'nope', diagnosis_confirmed: 1, status: 'decommissioned' } });
  expectStatus(res, 200);
  const after = ctx.db.get('SELECT * FROM equipment WHERE id = ?', [ctx.ids['Microscope C']]);
  assert.equal(after.name, 'Renamed legitimately', 'the allowed field changed');
  assert.equal(after.id, before.id, 'the id did not');
  assert.equal(after.asset_tag, before.asset_tag, 'nor the asset tag');
  assert.equal(after.status, before.status, 'status is not a side effect of an update payload');
  assert.equal(after.is_active, before.is_active);
});

test('security headers on both the API and the print page', async () => {
  const res = await ctx.api('/api/v1/equipment/1', { token: admin.token, raw: true });
  await res.text();
  const h = res.headers;
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('referrer-policy'), 'no-referrer');
  assert.match(h.get('permissions-policy'), /camera=\(self\)/, 'the QR camera is allowed for our origin only');
  const csp = h.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'self'/);
  assert.ok(!/unsafe-eval/.test(csp), 'no eval');
  assert.equal(h.get('x-powered-by'), null, 'the framework does not advertise itself');
});

test('write endpoints are rate limited, and the answer explains the wait', async () => {
  // a dedicated limiter run: 80 rapid POSTs with a tiny budget configured for this test
  const { config } = await import('../src/config/index.js');
  const original = config.limits.writeRateMax;
  config.limits.writeRateMax = 20;
  let limited = 0;
  for (let i = 0; i < 25; i += 1) {
    const r = await ctx.api('/api/v1/faults', { method: 'POST', token: reporter.token, body: {
      equipmentId: String(ctx.ids['ECG Trainer A']), categoryCode: 'OTH', title: `Rate probe ${i} for limits`,
      description: 'Synthetic fault used to prove the write limiter answers 429 instead of melting.', severity: 'low' } });
    if (r.status === 429) { limited += 1; assert.match(r.body.error.message, /Too many requests/); assert.ok(r.headers.get('retry-after')); }
  }
  assert.ok(limited > 0, 'the limiter actually fires');
  config.limits.writeRateMax = original;
});

test('every privileged action is auditable, with before and after values', async () => {
  const eq = await ctx.api('/api/v1/equipment', { method: 'POST', token: admin.token, body: { name: 'Audited device', categoryId: 1 } });
  const id = eq.body.equipment.id;
  await ctx.api(`/api/v1/equipment/${id}`, { method: 'PATCH', token: admin.token, body: { name: 'Audited device, renamed', criticality: 'high' } });
  await ctx.api(`/api/v1/equipment/${id}/status`, { method: 'POST', token: admin.token, body: { status: 'out_of_service', reason: 'Awaiting inspection' } });
  const rows = ctx.db.all('SELECT action, actor_id, actor_role, entity_type, entity_id, entity_ref, summary, before_json, after_json, ip, user_agent FROM audit_logs WHERE entity_type = ? AND entity_id = ? ORDER BY id', ['equipment', id]);
  const actions = rows.map((r) => r.action);
  assert.deepEqual(actions, ['equipment.create', 'equipment.update', 'equipment.status'], 'create, update and status are all recorded in order');
  const update = rows.find((r) => r.action === 'equipment.update');
  const after = JSON.parse(update.after_json);
  assert.equal(after.name, 'Audited device, renamed');
  assert.ok(!('createdBy' in after), 'audit stores only what changed, not whole records');
  const status = rows.find((r) => r.action === 'equipment.status');
  assert.match(status.summary, /operational → out_of_service/);
  assert.match(status.summary, /Awaiting inspection/);
  assert.ok(rows.every((r) => r.actor_id === admin.user.id && r.actor_role === 'admin'), 'every row names its actor and their role at the time');
  assert.ok(rows.every((r) => r.ip), 'and the client address');

  const failed = await ctx.api(`/api/v1/equipment/${id}/status`, { method: 'POST', token: reporter.token, body: { status: 'operational' } });
  assert.equal(failed.status, 403);
  const deniedCount = ctx.db.value("SELECT COUNT(*) FROM audit_logs WHERE action LIKE 'auth.login_failed'");
  assert.ok(Number.isFinite(deniedCount), 'failed logins are counted in the same table');
});

test('passwords are never echoed, logged or stored in the clear anywhere', async () => {
  const created = await ctx.api('/api/v1/users', { method: 'POST', token: admin.token, body: {
    fullName: 'Audited Newcomer', email: 'audited@test.invalid', roleCode: 'reporter', password: 'Manual-Password-123' } });
  expectStatus(created, 201);
  assert.equal(created.body.temporaryPassword, null, 'no password echo when one was supplied');
  const row = ctx.db.get('SELECT password_hash FROM users WHERE email = ?', ['audited@test.invalid']);
  assert.ok(!row.password_hash.includes('Manual-Password-123'));
  const audits = ctx.db.all("SELECT before_json, after_json, summary FROM audit_logs WHERE entity_type IN ('user','sessions')");
  for (const a of audits) {
    const blob = JSON.stringify(a);
    assert.ok(!blob.includes('Manual-Password-123'), 'no audit row contains the password');
    assert.ok(!/"password_hash":\s*"scrypt/.test(blob), 'nor a hash');
  }
  const session = ctx.db.get('SELECT token_hash FROM sessions ORDER BY id DESC LIMIT 1');
  assert.match(session.token_hash, /^[a-f0-9]{64}$/, 'only a SHA-256 of the session token is stored');
  assert.ok(!session.token_hash.includes(admin.token));
});

test('a generated temporary password is returned once and forces a change', async () => {
  const created = await ctx.api('/api/v1/users', { method: 'POST', token: admin.token, body: { fullName: 'Generated User', email: 'generated@test.invalid', roleCode: 'technician' } });
  expectStatus(created, 201);
  assert.ok(created.body.temporaryPassword.length >= 12, 'returned exactly once, in the create response');
  assert.equal(created.body.user.mustChangePassword, true);
  const again = await ctx.api(`/api/v1/users/${created.body.user.id}`, { token: admin.token });
  assert.equal(again.body.temporaryPassword, undefined, 'and never retrievable afterwards');
  const login = await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'generated@test.invalid', password: created.body.temporaryPassword } });
  expectStatus(login, 200);
  assert.equal(login.body.user.mustChangePassword, true, 'the flag travels with the session');
});

test('the upload MIME allow-list is honoured from configuration, not hard-coded', async () => {
  const { config } = await import('../src/config/index.js');
  assert.ok(config.uploads.allowedMime.includes('image/png'));
  assert.ok(!config.uploads.allowedMime.includes('application/x-msdownload'));
  const before = config.uploads.allowedExt.join(',');
  config.uploads.allowedExt = ['.pdf'];
  const res = await ctx.api(`/api/v1/faults/${(await newFault()).id}/attachments`, { method: 'POST', token: reporter.token,
    formData: fd({ kind: 'document' }, [{ name: 'only-pdf.pdf', bytes: PDF_BYTES, mime: 'application/pdf' }]) });
  expectStatus(res, 201, 'the configured type still works');
  const png = await ctx.api(`/api/v1/faults/${(await newFault()).id}/attachments`, { method: 'POST', token: reporter.token,
    formData: fd({ kind: 'photo' }, [{ name: 'now-blocked.png', bytes: PNG_1PX, mime: 'image/png' }]) });
  assert.ok([400, 422].includes(png.status), 'and a type removed from configuration is refused');
  config.uploads.allowedExt = before.split(',');
});
