import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { boot, expectStatus, fieldErrors, TMP, TEST_PASSWORD } from './helpers.js';

/**
 * Phase 11 — self-service onboarding (Reporter only) and password recovery via
 * one-time code.  This suite pins the *security properties*, not just the happy path:
 * identical responses for unknown addresses, code burn after failed attempts,
 * session revocation on success, and the demo-only nature of code reveal.
 */

const GOOD_PW = 'Catheter-Lab-Trolley-2231';
const NEW_PW = 'Tourniquet-Shelf-Fuse-4417';

let ctx;
test.before(async () => { ctx = await boot(); });
test.after(async () => { await ctx.close?.(); });

const register = (body) => ctx.api('/api/v1/auth/register', { method: 'POST', body });
const forgot = (email) => ctx.api('/api/v1/auth/forgot-password', { method: 'POST', body: { email } });
const redeem = (email, code, newPassword) =>
  ctx.api('/api/v1/auth/reset-password', { method: 'POST', body: { email, code, newPassword } });

const activeResets = (email) => ctx.db.get(
  `SELECT COUNT(*) AS n FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE u.email = ? AND r.consumed_at IS NULL AND datetime(r.expires_at) > datetime('now')`,
  [email],
).n;

test('self-registration creates an active Reporter and signs in', async () => {
  const email = `trainee.${Date.now()}@test.invalid`;
  const res = await register({ fullName: 'Nurse Testing', email, password: GOOD_PW });
  expectStatus(res, 201, 'register');
  assert.equal(res.body.user.roleCode, 'reporter');
  assert.equal(res.body.user.isActive, true);
  assert.equal(res.body.user.mustChangePassword, false);

  const s = await ctx.login(email, GOOD_PW);
  assert.equal(s.user.roleCode, 'reporter');
  assert.ok(!s.capabilities.includes('repair.complete'), 'reporters cannot complete repairs');
});

test('the account a reporter cannot hold: admin surfaces are 403', async () => {
  const email = `trainee2.${Date.now()}@test.invalid`;
  expectStatus(await register({ fullName: 'Second Trainee', email, password: GOOD_PW }), 201);
  const s = await ctx.login(email, GOOD_PW);
  const users = await ctx.api('/api/v1/users', { token: s.token });
  expectStatus(users, 403, 'reporter must not list users');
});

test('registration refuses duplicate emails, weak passwords and non-emails', async () => {
  const email = `dup.${Date.now()}@test.invalid`;
  expectStatus(await register({ fullName: 'Dup Person', email, password: GOOD_PW }), 201);
  const dup = await register({ fullName: 'Dup Person', email, password: NEW_PW });
  expectStatus(dup, 409, 'duplicate email');
  assert.match(dup.body.error.message, /Forgot password/);

  const weak = await register({ fullName: 'Weak Person', email: `weak.${Date.now()}@test.invalid`, password: 'short' });
  expectStatus(weak, 400, 'weak password rejected');
  assert.ok(fieldErrors(weak).password?.length, 'field error on password');

  const notMail = await register({ fullName: 'Bad Mail', email: 'not-an-email', password: GOOD_PW });
  expectStatus(notMail, 422, 'email shape enforced');

  const selfNamed = await register({ fullName: 'Catheter Walker', email: `cw.${Date.now()}@test.invalid`, password: 'Catheter Walker-2026x' });
  expectStatus(selfNamed, 400, 'password containing the full name is rejected');
  assert.match(JSON.stringify(selfNamed.body), /reuse your name/);
});

test('registration writes an audit row and tells every active admin', async () => {
  const email = `audited.${Date.now()}@test.invalid`;
  const res = await register({ fullName: 'Audited Trainee', email, password: GOOD_PW });
  expectStatus(res, 201);
  const auditRow = ctx.db.get(
    `SELECT * FROM audit_logs WHERE action = 'user.self_register' AND entity_id = ?`,
    [res.body.user.id],
  );
  assert.ok(auditRow, 'audit row for self-registration');
  assert.equal(auditRow.actor_id, null, 'no actor — the account created itself');
  assert.doesNotMatch(JSON.stringify(auditRow), /Catheter-Lab-Trolley/, 'password never lands in the audit json');

  const notes = ctx.db.all(
    `SELECT n.* FROM notifications n JOIN users u ON u.id = n.user_id
      JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'admin' AND n.body LIKE ?`,
    [`%${email}%`],
  );
  const admins = ctx.db.get(`SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin' AND u.is_active = 1`).n;
  assert.equal(notes.length, admins, 'every active admin got one notice');
});

test('a logged-in browser page cannot use public POSTs without the CSRF header', async () => {
  const s = await ctx.login('admin@test.invalid');
  const noCsrf = await ctx.api('/api/v1/auth/register', {
    method: 'POST',
    body: { fullName: 'CSRF Probe', email: `csrf.${Date.now()}@test.invalid`, password: GOOD_PW },
    headers: { cookie: s.cookie },
  });
  expectStatus(noCsrf, 403, 'cookie without CSRF token is rejected');
});

test('forgot-password answers are identical for unknown addresses', async () => {
  const known = await forgot('reporter@test.invalid');
  expectStatus(known, 202);
  const unknown = await forgot(`nobody.${Date.now()}@test.invalid`);
  expectStatus(unknown, 202);
  assert.equal(unknown.body.message, known.body.message, 'same generic acknowledgement');
  assert.equal(unknown.body.devOtp, undefined, 'nothing leaks for unknown addresses');
  assert.ok(known.body.devOtp, /^\d{6}$/.test(known.body.devOtp), 'test build (no SMTP) reveals the code');
  assert.equal(known.body.sent, true);
});

test('codes land in the outbox ledger and never in the database as plaintext', async () => {
  const email = `outbox.${Date.now()}@test.invalid`;
  expectStatus(await register({ fullName: 'Outbox Person', email, password: GOOD_PW }), 201);
  const r = await forgot(email);
  const row = ctx.db.get(
    `SELECT r.* FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE u.email = ? ORDER BY r.id DESC LIMIT 1`, [email],
  );
  assert.ok(row, 'reset row written');
  assert.equal(row.delivery_status, 'outbox');
  assert.match(row.delivery_detail, /^data\/outbox\//);
  assert.notEqual(row.code_hash, r.body.devOtp, 'only the hash is stored');
  const file = path.join(TMP, 'outbox', path.basename(row.delivery_detail));
  assert.ok(fs.existsSync(file), 'a real artifact exists for the mail');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(r.body.devOtp), 'the outbox copy carries the same code the UI was given');
});

test('a second request inside the throttle window does not pile up codes', async () => {
  const email = `throttle.${Date.now()}@test.invalid`;
  expectStatus(await register({ fullName: 'Throttle Person', email, password: GOOD_PW }), 201);
  const first = await forgot(email);
  expectStatus(first, 202);
  const second = await forgot(email);
  expectStatus(second, 202, 'still 202 — no behaviour signal to attackers');
  assert.equal(second.body.devOtp, undefined, 'no second code issued while the first is live');
  assert.equal(activeResets(email), 1, 'exactly one active row');
});

test('wrong codes burn the reset; policy failures do not', async () => {
  const email = `burn.${Date.now()}@test.invalid`;
  expectStatus(await register({ fullName: 'Burn Person', email, password: GOOD_PW }), 201);
  const r = await forgot(email);
  const code = r.body.devOtp;

  // Valid code but a weak new password: rejected, and the code SURVIVES for a retry.
  const weak = await redeem(email, code, 'nope');
  expectStatus(weak, 400, 'policy checked before burning attempts');
  assert.ok(fieldErrors(weak).newPassword, 'field error on newPassword');

  for (let i = 0; i < 5; i += 1) {
    const wrong = await redeem(email, '000000' === code ? '111111' : '000000', NEW_PW);
    expectStatus(wrong, 400, `wrong attempt ${i + 1}`);
    assert.equal(wrong.body.error.message, 'That code is not valid or has expired. Request a new one.');
  }
  const afterBurn = await redeem(email, code, NEW_PW);
  expectStatus(afterBurn, 400, 'correct code after burn limit is still refused');
  assert.equal(activeResets(email), 0, 'the burned row is consumed');
});

test('a superseded code dies the moment a newer one is issued', async () => {
  const email = `supersede.${Date.now()}@test.invalid`;
  expectStatus(await register({ fullName: 'Supersede Person', email, password: GOOD_PW }), 201);
  const first = (await forgot(email)).body.devOtp;
  // Backdate to step around the throttle, exactly like waiting a minute would.
  ctx.db.run(`UPDATE password_resets SET created_at = datetime('now','-2 minutes') WHERE
    user_id = (SELECT id FROM users WHERE email = ?)`, [email]);
  const second = await forgot(email);
  expectStatus(second, 202);
  const secondCode = second.body.devOtp;
  assert.ok(secondCode, 'a new code after the throttle window');
  expectStatus(await redeem(email, first, NEW_PW), 400, 'the old code is dead');
  expectStatus(await redeem(email, secondCode, NEW_PW), 200, 'the new code works');
});

test('expired codes are refused', async () => {
  const email = `expiry.${Date.now()}@test.invalid`;
  expectStatus(await register({ fullName: 'Expiry Person', email, password: GOOD_PW }), 201);
  const code = (await forgot(email)).body.devOtp;
  ctx.db.run(`UPDATE password_resets SET created_at = datetime('now','-2 hours'), expires_at = datetime('now','-1 hour') WHERE
    consumed_at IS NULL AND user_id = (SELECT id FROM users WHERE email = ?)`, [email]);
  expectStatus(await redeem(email, code, NEW_PW), 400, 'expired');
});

test('successful reset: new password works, old one does not, every session is revoked', async () => {
  const email = `rotate.${Date.now()}@test.invalid`;
  expectStatus(await register({ fullName: 'Rotate Person', email, password: GOOD_PW }), 201);
  const session = await ctx.login(email, GOOD_PW);
  expectStatus(await ctx.api('/api/v1/auth/me', { token: session.token }), 200, 'live before');

  const code = (await forgot(email)).body.devOtp;
  const ok = await redeem(email, code, NEW_PW);
  expectStatus(ok, 200);
  assert.equal(ok.body.reset, true);
  assert.ok(ok.body.sessionsRevoked >= 1, 'the pre-reset session was revoked');

  expectStatus(await ctx.api('/api/v1/auth/me', { token: session.token }), 401, 'old token is dead');
  expectStatus(await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email, password: GOOD_PW } }), 401, 'old password is dead');
  const fresh = await ctx.login(email, NEW_PW);
  assert.equal(fresh.user.mustChangePassword, false, 'self-chosen password needs no forced change');

  const auditRow = ctx.db.get(`SELECT * FROM audit_logs WHERE action = 'user.self_password_reset' ORDER BY id DESC LIMIT 1`);
  assert.ok(auditRow, 'reset is audited');
  assert.match(auditRow.summary, /session\(s\) signed out/);
  const note = ctx.db.get(`SELECT * FROM notifications WHERE user_id = ? AND type = 'account' AND title = 'Your password was changed'`, [fresh.user.id]);
  assert.ok(note, 'the owner was notified in-app');
});

test('disabled accounts can neither receive nor redeem codes', async () => {
  const r = await forgot('disabled@test.invalid');
  expectStatus(r, 202, 'same 202 as everyone');
  assert.equal(r.body.devOtp, undefined, 'no code for a disabled account');
  assert.equal(activeResets('disabled@test.invalid'), 0);
  expectStatus(await redeem('disabled@test.invalid', '123456', NEW_PW), 400);
});

test('unknown-email redemption gets the identical refusal as a wrong code', async () => {
  const ghost = await redeem(`ghost.${Date.now()}@test.invalid`, '123456', NEW_PW);
  const wrong = await redeem('reporter@test.invalid', '123456', NEW_PW);
  assert.equal(ghost.body.error.message, wrong.body.error.message, 'no enumeration via redemption');
});

test('the policy endpoint advertises what the login screen may promise', async () => {
  const p = await ctx.api('/api/v1/auth/policy');
  expectStatus(p, 200);
  assert.equal(p.body.selfRegistration, true);
  assert.equal(p.body.recoveryCodeTtlMinutes, 15);
  const cfg = await ctx.api('/api/v1/public/config');
  expectStatus(cfg, 200);
  assert.equal(cfg.body.selfRegistration, true);
  assert.equal(cfg.body.passwordMinLength, 12);
});

test('repeated failed logins still lock the account (recovery does not bypass the lockout)', async () => {
  const email = `lockout.${Date.now()}@test.invalid`;
  expectStatus(await register({ fullName: 'Lockout Person', email, password: GOOD_PW }), 201);
  for (let i = 0; i < 6; i += 1) await ctx.login(email, 'wrong-guess-here-1').catch(() => {});
  const locked = await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email, password: GOOD_PW } });
  expectStatus(locked, 429, 'account locked after repeated failures');

  // A valid reset lifts the lockout — the point of recovery is to get locked-out people back in.
  const code = (await forgot(email)).body.devOtp;
  expectStatus(await redeem(email, code, NEW_PW), 200);
  expectStatus(await ctx.api('/api/v1/auth/login', { method: 'POST', body: { email, password: NEW_PW } }), 200, 'reset clears the lockout');
});
