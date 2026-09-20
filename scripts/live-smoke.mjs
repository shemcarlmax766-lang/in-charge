#!/usr/bin/env node
/**
 * Live-environment smoke test — a READ-ONLY sweep you can run against any deployment:
 *
 *   node scripts/live-smoke.mjs --base https://equipment.myschool.edu
 *   SMOKE_PASSWORD=... npm run smoke -- --base http://127.0.0.1:5173
 *
 * It verifies, in order: the shell + PWA files, health, all three role logins (plus the
 * negative case), capability-based RBAC boundaries, the public QR profile contract (no
 * serials/PII), the workflow vocabulary + risk model, dashboard scoping, list/search
 * pagination, and the CSV/print report paths. With `--mutations` it additionally runs the
 * idempotent maintenance-reminder sweep (the only deliberately non-readonly check).
 *
 * Nothing here is secret: emails have demo defaults, and the password ONLY ever comes from
 * SMOKE_PASSWORD (no default — so no credential can be committed by accident).
 */
import process from 'node:process';

const args = process.argv.slice(2);
// accepts both --flag=value and --flag value
const arg = (name, dflt) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return dflt;
};
const BASE = (arg('base', process.env.SMOKE_BASE || 'http://127.0.0.1:5173')).replace(/\/+$/, '');
const MUTATIONS = args.includes('--mutations');
const PASSWORD = process.env.SMOKE_PASSWORD;
const USERS = {
  admin: process.env.SMOKE_ADMIN || 'a.okonkwo@sthospital-training.edu',
  tech: process.env.SMOKE_TECH || 'g.mbeki@sthospital-training.edu',
  reporter: process.env.SMOKE_REPORTER || 'p.nair@student.sthospital-training.edu',
};

const results = [];
let failed = 0;
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed += 1;
};

async function req(path, { token, method = 'GET', body, form, raw = false } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form; // FormData — let fetch set the multipart boundary
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  // raw: byte-level assertions (a BOM that res.text() would transparently strip, PNG magic, …)
  const data = raw ? Buffer.from(await res.arrayBuffer())
    : ct.includes('json') ? await res.json() : ct.startsWith('text') ? await res.text() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, data };
}

async function login(email) {
  const r = await req('/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return r;
}

async function main() {
  if (!PASSWORD) {
    console.error('Set SMOKE_PASSWORD (the deployment password for the smoke accounts).\n'
      + 'For the demo fleet that is the value you seeded with (or the one the seeder printed).');
    process.exit(2);
  }
  console.log(`BEM-FRS live smoke → ${BASE}${MUTATIONS ? '  (incl. --mutations)' : '  (read-only)'}`);

  /* ---------- shell & PWA surface ---------- */
  const shell = await req('/');
  ok('SPA shell serves HTML with app root', shell.status === 200 && String(shell.data).includes('id="root"'));
  const manifestRes = await req('/manifest.webmanifest');
  const manifestJson = typeof manifestRes.data === 'object'
    ? manifestRes.data
    : (() => { try { return JSON.parse(manifestRes.data); } catch { return null; } })();
  ok('PWA manifest serves and parses', manifestRes.status === 200 && !!manifestJson?.icons?.length,
    manifestJson?.icons?.length ? `${manifestJson.icons.length} icons` : `status ${manifestRes.status}`);
  const sw = await req('/sw.js');
  ok('service worker script serves (prod only registers)', sw.status === 200 && String(sw.data).includes('bems-shell-v1'));
  const icon = await req('/icons/icon-192.png');
  ok('app icon serves as PNG', icon.status === 200 && (icon.headers.get('content-type') || '').includes('image/png'));

  /* ---------- health ---------- */
  const health = await req('/api/health');
  ok('GET /api/health → 200 ok', health.status === 200 && health.data?.status === 'ok',
    health.data?.counts ? `equipment=${health.data.counts.equipment}, open faults=${health.data.counts.open_faults}` : '');

  /* ---------- auth ---------- */
  const tokens = {};
  const bad = await login(`${USERS.admin.split('@')[0]}@nonexistent.invalid`);
  ok('unknown account cannot sign in (401, generic message)', bad.status === 401 && !String(bad.data?.error?.message || '').includes('SQL'));
  for (const [role, email] of Object.entries(USERS)) {
    const r = await login(email);
    tokens[role] = r.data?.token;
    ok(`sign in as ${role}`, r.status === 200 && !!tokens[role],
      r.status === 200 ? r.data.user.roleLabel : `status ${r.status}`);
  }
  const me = await req('/api/v1/auth/me', { token: tokens.reporter });
  ok('auth/me returns capabilities + CSRF token', me.status === 200 && !!me.data?.csrfToken && Array.isArray(me.data?.capabilities),
    `${me.data?.capabilities?.length ?? 0} capabilities for a reporter`);

  /* ---------- RBAC boundaries ---------- */
  const usersAsReporter = await req('/api/v1/users', { token: tokens.reporter });
  ok('reporter blocked from /users (403, human message + hint)', usersAsReporter.status === 403
    && /[a-z]{4,}\s[a-z]/.test(usersAsReporter.data?.error?.message ?? '') && !!usersAsReporter.data?.error?.details?.hint);
  const createAsReporter = await req('/api/v1/equipment', { token: tokens.reporter, method: 'POST', body: {} });
  ok('reporter blocked from creating equipment (403)', createAsReporter.status === 403);
  const auditAsTech = await req('/api/v1/audit', { token: tokens.tech });
  ok('technician blocked from /audit (403)', auditAsTech.status === 403);
  // the report *catalogue* is informational and open to authed staff; the DATA endpoint is gated
  const reportDataAsTech = await req('/api/v1/reports/faults', { token: tokens.tech });
  ok('technician blocked from report DATA (403)', reportDataAsTech.status === 403);
  const anon = await req('/api/v1/dashboard');
  ok('anonymous dashboard → 401', anon.status === 401);
  const notFound = await req('/api/v1/no-such-route');
  ok('unknown API route → 404 JSON', notFound.status === 404 && !!notFound.data?.error?.code);

  /* ---------- public QR contract ---------- */
  const eqList = await req('/api/v1/equipment?pageSize=1', { token: tokens.admin });
  const first = eqList.data?.items?.[0];
  const eqTotal = eqList.data?.pagination?.total ?? eqList.data?.total;
  ok('equipment list paginates', eqList.status === 200 && !!first && typeof eqTotal === 'number', `total=${eqTotal}`);
  if (first?.assetTag) {
    const pub = await req(`/api/v1/public/equipment/${first.assetTag}`);
    ok('public QR profile serves for a real tag', pub.status === 200 && pub.data?.assetTag === first.assetTag);
    ok('public QR profile withholds serial', pub.status === 200 && pub.data?.serialNumber == null
      && !JSON.stringify(pub.data).toLowerCase().includes('serial'));
    const qr = await req(`/api/v1/equipment/${first.id}/qr.png`, { token: tokens.reporter });
    ok('QR PNG renders for a signed-in reporter', qr.status === 200
      && (qr.headers.get('content-type') || '').includes('image/png') && qr.data.length > 150, `${qr.data.length} B`);
    const missing = await req('/api/v1/public/equipment/NO-THIS-TAG');
    ok('unknown tag → 404 (no enumeration)', missing.status === 404);
  }

  /* ---------- domain surfaces ---------- */
  const vocab = await req('/api/v1/faults/vocabulary', { token: tokens.reporter });
  ok('fault vocabulary exposes 9 statuses + severities', vocab.status === 200
    && (vocab.data?.statuses?.length ?? 0) >= 9 && (vocab.data?.severities?.length ?? 0) >= 4);
  const model = await req('/api/v1/dashboard/risk/model', { token: tokens.tech });
  ok('risk model published with 7 transparent factors', model.status === 200 && (model.data?.factors?.length ?? 0) === 7);
  const dashA = await req('/api/v1/dashboard', { token: tokens.admin });
  const dashR = await req('/api/v1/dashboard', { token: tokens.reporter });
  ok('dashboard scoped per role', dashA.data?.scope === 'department' && dashR.data?.scope === 'personal'
    && typeof dashA.data?.kpis?.openFaults === 'number', `admin=${dashA.data?.scope}, reporter=${dashR.data?.scope}`);
  const due = await req('/api/v1/maintenance/due-board?pageSize=5', { token: tokens.tech });
  ok('PM due-board answers', due.status === 200 && Array.isArray(due.data?.items),
    `${due.data?.pagination?.total ?? due.data?.total ?? due.data?.items?.length ?? 0} rows`);
  const search = await req(`/api/v1/equipment?q=${encodeURIComponent('ECG')}`, { token: tokens.reporter });
  const searchTotal = search.data?.pagination?.total ?? search.data?.total;
  ok('search narrows (subset of unfiltered)', search.status === 200 && typeof searchTotal === 'number'
    && searchTotal <= eqTotal && searchTotal > 0, `${searchTotal} hits`);
  const notifications = await req('/api/v1/notifications', { token: tokens.tech });
  ok('notifications list for technician', notifications.status === 200 && Array.isArray(notifications.data?.items));

  /* ---------- reports ---------- */
  const repList = await req('/api/v1/reports', { token: tokens.admin });
  ok('report catalogue lists 8 reports', repList.status === 200 && (repList.data?.items?.length ?? 0) === 8);
  const csv = await req('/api/v1/reports/export/inventory/csv', { token: tokens.admin, raw: true });
  ok('CSV exports with BOM + header row', csv.status === 200
    && csv.data[0] === 0xef && csv.data[1] === 0xbb && csv.data[2] === 0xbf
    && csv.data.subarray(3, 14).toString().includes('Asset'), `${csv.data.length} B`);
  const print = await req('/api/v1/reports/export/faults/print', { token: tokens.admin });
  ok('print view serves locked-down HTML', print.status === 200
    && /<title>/.test(print.data) && /default-src 'none'/.test(print.headers.get('content-security-policy') || ''));

  /* ---------- optional mutation probe ---------- */
  if (MUTATIONS) {
    const sweep = await req('/api/v1/maintenance/reminders', { token: tokens.admin, method: 'POST', body: {} });
    const sweep2 = await req('/api/v1/maintenance/reminders', { token: tokens.admin, method: 'POST', body: {} });
    ok('reminder sweep runs + is idempotent (repeat sends nothing)',
      sweep.status === 200 && sweep2.status === 200
      && (sweep2.data?.sent ?? 1) === 0 && (sweep2.data?.considered ?? 0) > 0,
      `run 1 sent ${sweep.data?.sent}, run 2 sent ${sweep2.data?.sent} of ${sweep2.data?.considered} considered`);
  } else {
    console.log('· mutations skipped — pass --mutations for the (idempotent) reminder-sweep probe');
  }

  console.log('');
  for (const line of results) console.log(line);
  console.log(`\n${results.length - failed}/${results.length} checks passed  (${BASE})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSMOKE RUN CRASHED (network? wrong --base?):', err.message);
  process.exit(2);
});
