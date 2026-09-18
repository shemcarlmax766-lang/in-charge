/**
 * Records real API responses (from the running dev server, against the seeded demo database)
 * into a fixture file, so the render tests exercise the exact payloads the browser receives.
 * Re-run with `node client/test/record-fixtures.mjs` after changing an endpoint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.API_ORIGIN || 'http://127.0.0.1:4000/api/v1';
const PASSWORD = process.env.SEED_PASSWORD || 'Demo-Access-2026';

const ACCOUNTS = {
  admin: 'a.okonkwo@sthospital-training.edu',
  technician: 'g.mbeki@sthospital-training.edu',
  reporter: 'p.nair@student.sthospital-training.edu',
};

async function login(email) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  const body = await res.json();
  return { token: body.token, csrf: body.csrfToken, user: body.user };
}

async function grab(token, pathname) {
  const res = await fetch(`${BASE}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 400), _ct: res.headers.get('content-type') }; }
  return { status: res.status, body: json };
}

const routes = {
  '/auth/me': '/auth/me',
  '/auth/policy': '/auth/policy',
  '/auth/sessions': '/auth/sessions',
  '/reference/picklists': '/reference/picklists',
  '/reference/categories': '/reference/categories',
  '/reference/locations': '/reference/locations',
  '/reference/fault-categories': '/reference/fault-categories',
  '/reference/settings': '/reference/settings',
  '/parts': '/parts',
  '/equipment/vocabulary': '/equipment/vocabulary',
  '/equipment/needs-attention': '/equipment/needs-attention?limit=8',
  '/dashboard': '/dashboard',
  '/dashboard/risk/model': '/dashboard/risk/model',
  '/reports': '/reports',
  '/notifications': '/notifications',
  '/notifications/unread-count': '/notifications/unread-count',
  '/notifications?unreadOnly=true': '/notifications?unreadOnly=true',
  '/audit': '/audit',
  '/dashboard/risk?limit=50': '/dashboard/risk?limit=50',
  '/dashboard/risk?limit=10&level=high': '/dashboard/risk?limit=10&level=high',
  '/users': '/users',
  '/faults/vocabulary': '/faults/vocabulary',
  '/faults?scope=open&sort=createdAt&dir=desc&page=1&perPage=25': '/faults?scope=open&sort=createdAt&dir=desc&page=1&perPage=25',
  '/faults?sort=createdAt&dir=desc&page=1&perPage=25': '/faults?sort=createdAt&dir=desc&page=1&perPage=25',
  '/maintenance/vocabulary': '/maintenance/vocabulary',
};

const byRole = {
  admin: [
    '/equipment', '/equipment/1', '/equipment/1/history', '/faults', '/faults?scope=open', '/faults/1', '/faults/1/repair',
    '/maintenance/schedules', '/maintenance/due-board', '/maintenance/compliance', '/maintenance/records',
    '/dashboard/risk?limit=20', '/dashboard/risk/1', '/reports/faults', '/reports/inventory', '/audit', '/users',
    '/reference/picklists', '/equipment/needs-attention',
  ],
  technician: ['/equipment', '/equipment/1', '/faults?scope=assigned', '/faults?scope=unassigned', '/faults?scope=assigned&perPage=50&sort=severity&dir=asc',
    '/faults?scope=unassigned&perPage=50&sort=severity&dir=asc', '/faults/1', '/faults/1/repair', '/maintenance/due-board', '/maintenance/schedules',
    '/dashboard', '/dashboard/risk?limit=10', '/dashboard/risk?limit=50', '/notifications'],
  reporter: ['/equipment', '/equipment/1', '/faults?scope=mine', '/dashboard', '/notifications', '/reference/picklists'],
};

const out = { base: BASE, recordedAt: new Date().toISOString(), accounts: {}, public: {}, fixtures: {} };

for (const [role, email] of Object.entries(ACCOUNTS)) {
  const session = await login(email);
  out.accounts[role] = { email, token: session.token, csrf: session.csrf, user: session.user };
  const paths = [...new Set([...Object.entries(routes).map(([, p]) => p), ...(byRole[role] ?? [])])];
  out.fixtures[role] = {};
  for (const p of paths) {
    try {
      out.fixtures[role][p] = await grab(session.token, p);
    } catch (err) {
      out.fixtures[role][p] = { status: 0, body: { error: { message: String(err.message) } } };
    }
  }
}

for (const p of ['/public/config', '/public/equipment/BMU-ECG-0001', '/public/equipment/BMU-NOPE-9999']) {
  const res = await fetch(`${BASE}${p}`);
  out.public[p] = { status: res.status, body: await res.json() };
}
// a couple of role-shaped list pages need a non-empty page-2 too
out.fixtures.admin['/equipment?page=2&perPage=25'] = await grab(out.accounts.admin.token, '/equipment?page=2&perPage=25');

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1));
const size = fs.statSync(file).size;
console.log(`fixtures written → ${file} (${(size / 1024).toFixed(0)} KB, ${Object.values(out.fixtures).reduce((n, r) => n + Object.keys(r).length, 0)} responses)`);
