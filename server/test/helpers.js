/**
 * Test harness.
 *
 * Boots the *real* Express app (identical middleware order to production: security headers,
 * rate limiting, authentication, CSRF, validation) against a throwaway SQLite file in a temp
 * directory, with a deterministic minimal dataset.  Nothing is mocked except time, and only
 * where a test needs a fixed clock.
 *
 * Import this module first in every test file: it sets the environment that
 * `src/config/index.js` snapshots at import time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmems-test-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(dir, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(dir, 'uploads');
process.env.DATA_DIR = dir;
process.env.PORT = '0';
process.env.SEED_PASSWORD = 'Test-Password-2026';
process.env.SCRYPT_N = '1024'; // keep hashing cheap in tests; production uses 16384
process.env.RATE_MAX = '100000';
process.env.LOGIN_RATE_MAX = process.env.LOGIN_RATE_MAX ?? '100000';

export const TMP = dir;
export const TEST_PASSWORD = 'Test-Password-2026';

export const USERS = [
  { email: 'admin@test.invalid', role: 'admin', full_name: 'Test Administrator' },
  { email: 'tech@test.invalid', role: 'technician', full_name: 'Test Technician', job_title: 'Biomedical Engineer' },
  { email: 'tech2@test.invalid', role: 'technician', full_name: 'Second Technician' },
  { email: 'reporter@test.invalid', role: 'reporter', full_name: 'Test Reporter' },
  { email: 'reporter2@test.invalid', role: 'reporter', full_name: 'Second Reporter' },
  { email: 'disabled@test.invalid', role: 'reporter', full_name: 'Disabled User', is_active: 0 },
];

let ctx = null;
let base = null;

/** Creates the schema + a minimal, predictable dataset. */
export async function boot({ seed = true } = {}) {
  if (ctx) return ctx;
  const { Db, migrate, setDb } = await import('../src/lib/db.js');
  const db = new Db(process.env.DATABASE_PATH);
  migrate(db);
  setDb(db);

  const { hashPassword } = await import('../src/lib/password.js');
  const { assetTag } = await import('../src/lib/tokens.js');
  const { nextSequence } = await import('../src/lib/db.js');
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const hash = await hashPassword(TEST_PASSWORD);

  const ids = {};
  if (seed) {
    const roleIds = new Map(db.all('SELECT id, code FROM roles').map((r) => [r.code, r.id]));
    for (const u of USERS) {
      const { lastInsertRowid } = db.run(
        `INSERT INTO users (employee_id, full_name, email, password_hash, role_id, is_active, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [null, u.full_name, u.email, hash, roleIds.get(u.role), u.is_active ?? 1, now],
      );
      ids[u.email] = lastInsertRowid;
    }
    for (const [code, name] of [['ECG', 'ECG Machine'], ['MON', 'Patient Monitor'], ['MIC', 'Microscope']]) {
      db.run('INSERT INTO equipment_categories (code, name, created_at) VALUES (?,?,?)', [code, name, now]);
    }
    db.run(`INSERT INTO locations (code, name, building, room, created_at) VALUES ('LAB1','Physiology Lab','Block B','B-204',?)`, [now]);
    for (const [code, name, sev] of [['ELEC', 'Electrical', 'high'], ['MECH', 'Mechanical', 'medium'], ['OTH', 'Unknown / Other', 'medium']]) {
      db.run('INSERT INTO fault_categories (code, name, default_severity, created_at) VALUES (?,?,?,?)', [code, name, sev, now]);
    }
    for (const [code, name, cost] of [['P-1', 'Fuse kit', 4.5], ['P-2', 'Cable assembly', 30.25]]) {
      db.run('INSERT INTO replacement_parts (code, name, unit_cost, created_at) VALUES (?,?,?,?)', [code, name, cost, now]);
    }
    for (const [name, cat, crit] of [['ECG Trainer A', 'ECG', 'life_support'], ['Patient Monitor B', 'MON', 'medium'], ['Microscope C', 'MIC', 'low']]) {
      const seq = nextSequence(db, `asset:${cat}`);
      const { lastInsertRowid } = db.run(
        `INSERT INTO equipment (asset_tag, name, category_id, status, criticality, location_id, maintenance_interval_days,
            last_maintenance_on, next_maintenance_on, acquired_on, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [assetTag(cat, seq), name, db.value('SELECT id FROM equipment_categories WHERE code = ?', [cat]), 'operational', crit, 1,
          180, new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10),
          new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10),
          '2019-01-15', now],
      );
      db.run(`INSERT INTO equipment_status_history (equipment_id, to_status, reason, changed_at) VALUES (?, 'operational', 'seed', ?)`, [lastInsertRowid, now]);
      ids[name] = lastInsertRowid;
    }
  }

  const { createApp } = await import('../src/app.js');
  const app = createApp({ serveClient: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  ctx = { db, base, ids, hash, server, api, login, asAdmin: () => login('admin@test.invalid'), asTech: () => login('tech@test.invalid'), asReporter: () => login('reporter@test.invalid'), close };
  return ctx;
}

/** Thin fetch wrapper that keeps cookie + CSRF semantics identical to a browser. */
async function api(pathname, { method = 'GET', body, token, csrf, headers = {}, formData, raw = false } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (csrf) h['x-bm-csrf'] = csrf;
  let payload;
  if (formData) payload = formData;
  else if (body !== undefined) { h['content-type'] = h['content-type'] ?? 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
  const res = await fetch(base + pathname, { method, headers: h, body: payload, redirect: 'manual' });
  if (raw) return res;
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json, headers: res.headers };
}

/**
 * Signs in and returns {token, csrf, cookie, user}.  Tests normally use the Bearer token so
 * they do not have to model cookies, and use the cookie path explicitly in the CSRF tests.
 */
async function login(email, password = TEST_PASSWORD) {
  const res = await api('/api/v1/auth/login', { method: 'POST', body: { email, password } });
  if (res.status !== 200) {
    const err = new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    err.response = res;
    throw err;
  }
  return { ...res.body, cookie: res.headers.getSetCookie?.()[0] ?? '', password };
}

async function close() {
  if (!ctx) return;
  await new Promise((r) => ctx.server.close(r));
  try { ctx.db.close(); } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  ctx = null;
}

/* ---- small assertion helpers used across files ---- */
export const expectStatus = (res, expected, label = '') => {
  if (res.status !== expected) {
    throw new AssertionError(`expected HTTP ${expected}${label ? ` (${label})` : ''}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 700)}`);
  }
  return res;
};
class AssertionError extends Error { constructor(m) { super(m); this.name = 'AssertionError'; } }

export const fieldErrors = (res) => res?.body?.error?.details?.fields ?? {};

/** Builds a valid multipart body for the upload endpoints. */
export function multipart(fields, files = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const f of files) fd.append(f.field ?? 'files', new Blob([f.bytes], { type: f.mime }), f.name);
  return fd;
}

/* Minimal but *valid* 1×1 files, so content sniffing has something honest to inspect. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
export const JPEG_FAKE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);
export const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
export const ZIP_BYTES = Buffer.from('PK\x03\x04' + '\0'.repeat(60), 'latin1');
export const EXE_BYTES = Buffer.from('MZ\x90\x00' + '\0'.repeat(64), 'latin1');

/** Day helpers keep date-dependent tests readable. */
export const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
export const isoFromNow = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
