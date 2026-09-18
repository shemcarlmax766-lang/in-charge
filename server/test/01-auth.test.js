import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { boot, expectStatus, fieldErrors, TEST_PASSWORD } from './helpers.js';

/**
 * Phase 1 — authentication, sessions and password policy.
 */

let ctx;
test.before(async () => { ctx = await boot(); });
test.after(async () => { await ctx.close?.(); });

test('login issues a revocable session, capabilities and a CSRF token', async () => {
  const s = await ctx.login('admin@test.invalid');
  assert.equal(typeof s.token, 'string');
  assert.ok(s.token.length >= 40, 'token has real entropy');
  assert.notEqual(s.token, s.user.email);
  assert.ok(s.csrfToken);
  assert.equal(s.user.roleCode, 'admin');
  assert.ok(s.capabilities.includes('equipment.create'));
  assert.ok(new Date(s.expiresAt).getTime() > Date.now(), 'session expires in the future');

  const me = await ctx.api('/api/v1/auth/me', { token: s.token });
  expectStatus(me, 200, 'auth/me');
  assert.equal(me.body.email, 'admin@test.invalid');
  assert.equal(me.body.activeSessions, 1);
});

test('the database stores a scrypt hash, never the password', async () => {
  const row = ctx.db.get('SELECT password_hash FROM users WHERE email = ?', ['admin@test.invalid']);
  assert.match(row.password_hash, /^scrypt\$1024\$\d+\$\d+\$/, 'hash records its own cost parameters');
  assert.ok(!row.password_hash.includes(TEST_PASSWORD), 'plaintext password must never be stored');
  assert.ok(row.password_hash.split('$')[4].length >= 16, 'salt present');
});

test('wrong password, unknown address and malformed input all fail safely', async () => {
  const bad = await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'admin@test.invalid', password: 'not-the-password' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.message, 'Email or password is incorrect', 'no user enumeration');

  const unknown = await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'nobody@test.invalid', password: 'whatever' } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error.message, bad.body.error.message, 'same message either way');

  const malformed = await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'admin@test.invalid' } });
  expectStatus(malformed, 422);
  assert.ok(fieldErrors(malformed).password, 'missing password reported per-field');
});

test('repeated failures lock the account and lockout expires', async () => {
  const s = await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'reporter2@test.invalid', password: 'wrong-one' } });
  assert.equal(s.status, 401);
  let blocked = null;
  for (let i = 0; i < 6; i += 1) {
    blocked = await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'reporter2@test.invalid', password: 'wrong-one' } });
    if (blocked.status === 429) break;
  }
  assert.equal(blocked.status, 429, 'lockout after the configured attempts');
  assert.match(blocked.body.error.message, /locked/i);
  assert.ok(ctx.db.get('SELECT locked_until FROM users WHERE email = ?', ['reporter2@test.invalid']).locked_until, 'lockout persisted');

  // Correct password while locked must still be refused (otherwise lockout is cosmetic).
  const whileLocked = await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'reporter2@test.invalid', password: TEST_PASSWORD } });
  assert.equal(whileLocked.status, 429);
  ctx.db.run('UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE email = ?', ['reporter2@test.invalid']);
  expectStatus(await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'reporter2@test.invalid', password: TEST_PASSWORD } }), 200, 'after lockout cleared');
});

test('a deactivated account cannot sign in', async () => {
  const res = await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'disabled@test.invalid', password: TEST_PASSWORD } });
  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /deactivated/i);
});

test('endpoints require authentication', async () => {
  for (const p of ['/api/v1/auth/me', '/api/v1/equipment', '/api/v1/faults', '/api/v1/dashboard', '/api/v1/users', '/api/v1/audit']) {
    const res = await ctx.api(p);
    assert.equal(res.status, 401, `${p} must be 401 without a token`);
  }
  const garbage = await ctx.api('/api/v1/equipment', { token: 'Bearer nonsense' });
  assert.equal(garbage.status, 401, 'an unrecognised token is not an anonymous pass');
});

test('logout revokes the session immediately (stateless JWT could not)', async () => {
  const s = await ctx.login('admin@test.invalid');
  expectStatus(await ctx.api('/api/v1/auth/me', { token: s.token }), 200);
  expectStatus(await ctx.api('/api/v1/auth/logout', { method: 'POST', token: s.token }), 200);
  const after = await ctx.api('/api/v1/auth/me', { token: s.token });
  assert.equal(after.status, 401, 'revoked token must stop working at once');
  const sessionRow = ctx.db.get('SELECT revoked_at FROM sessions WHERE token_hash = ?', [createHash('sha256').update(s.token).digest('hex')]);
  assert.equal(sessionRow.revoked_at !== null, true, 'that exact session row is marked revoked');
});

test('cookie sessions enforce CSRF, Bearer clients are exempt', async () => {
  const login = await ctx.api('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'admin@test.invalid', password: TEST_PASSWORD },
  });
  const cookie = (login.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookie.includes('bmems_session='), 'session cookie set');
  assert.match(login.headers.getSetCookie()[0], /HttpOnly/i, 'cookie is httpOnly');
  assert.match(login.headers.getSetCookie()[0], /SameSite=Lax/i, 'cookie is SameSite');

  // A cross-site form post carries the cookie but cannot read the CSRF token.
  const noCsrf = await ctx.api('/api/v1/equipment', { method: 'POST', body: { name: 'Sneaky device', categoryId: 1 }, headers: { cookie } });
  expectStatus(noCsrf, 403, 'cookie write without CSRF header');
  assert.match(noCsrf.body.error.message, /CSRF/i);

  const ok = await ctx.api('/api/v1/equipment', {
    method: 'POST',
    body: { name: 'Legit device', categoryId: 1 },
    headers: { cookie },
    csrf: login.body.csrfToken,
  });
  expectStatus(ok, 201, 'cookie write with CSRF header');

  // Bearer has no ambient credential, so it needs no CSRF header.
  expectStatus(await ctx.api('/api/v1/equipment', { method: 'POST', body: { name: 'Bearer device', categoryId: 1 }, token: login.body.token }), 201);
});

test('password change enforces policy and signs other devices out', async () => {
  const s = await ctx.login('reporter@test.invalid');
  const other = await ctx.login('reporter@test.invalid'); // second device

  const weak = await ctx.api('/api/v1/auth/change-password', {
    method: 'POST', token: s.token, csrf: null,
    body: { currentPassword: TEST_PASSWORD, newPassword: 'short1' },
  });
  assert.equal(weak.status, 400, 'policy violation is a 400 from the service');
  assert.ok(fieldErrors(weak).newPassword?.length, 'explains what is wrong with the password');

  const wrongCurrent = await ctx.api('/api/v1/auth/change-password', {
    method: 'POST', token: s.token, body: { currentPassword: 'not it', newPassword: 'Completely-Different-99' },
  });
  assert.equal(wrongCurrent.status, 400);

  const good = await ctx.api('/api/v1/auth/change-password', {
    method: 'POST', token: s.token, body: { currentPassword: TEST_PASSWORD, newPassword: 'Completely-Different-99' },
  });
  expectStatus(good, 200, 'change-password');

  assert.equal((await ctx.api('/api/v1/auth/me', { token: other.token })).status, 401, 'other devices are revoked');
  assert.equal((await ctx.api('/api/v1/auth/me', { token: s.token })).status, 200, 'this device stays signed in');
  expectStatus(await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'reporter@test.invalid', password: 'Completely-Different-99' } }), 200, 'new password works');
});

test('session list shows the current session and supports individual revoke', async () => {
  const a = await ctx.login('admin@test.invalid');
  const b = await ctx.login('admin@test.invalid');
  const list = await ctx.api('/api/v1/auth/sessions', { token: b.token });
  expectStatus(list, 200);
  const mine = list.body.items.filter((s) => s.current);
  assert.equal(mine.length, 1, 'exactly one item is flagged current');
  const aRow = ctx.db.get('SELECT id FROM sessions WHERE token_hash = ?', [createHash('sha256').update(a.token).digest('hex')]);
  const otherId = aRow.id;
  expectStatus(await ctx.api(`/api/v1/auth/sessions/${otherId}`, { method: 'DELETE', token: b.token }), 200);
  assert.equal((await ctx.api('/api/v1/auth/me', { token: a.token })).status, 401, 'revoked session dead');
  assert.equal((await ctx.api('/api/v1/auth/me', { token: b.token })).status, 200, 'own session survives');
});

test('CSRF token is delivered through /auth/me for SPA bootstrapping', async () => {
  const login = await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email: 'admin@test.invalid', password: TEST_PASSWORD } });
  const cookie = (login.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
  const me = await ctx.api('/api/v1/auth/me', { headers: { cookie } });
  expectStatus(me, 200);
  assert.equal(me.body.csrfToken, login.body.csrfToken);
});
