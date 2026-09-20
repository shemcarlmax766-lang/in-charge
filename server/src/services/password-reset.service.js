import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import { hashPassword, passwordProblems } from '../lib/password.js';
import { hashToken } from '../lib/tokens.js';
import { nowIso } from '../lib/time.js';
import { badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { sendMail, mailConfigured } from './mail.service.js';
import { notifyUser } from './notification.service.js';

/**
 * Self-service password recovery with a 6-digit one-time code.
 *
 * Design rules, all testable:
 *  - the response to a recovery request is identical whether or not the address exists
 *    (anti user-enumeration); the code row is only created when an active account matches;
 *  - only the SHA-256 of the code is stored, codes expire (default 15 min) and allow a
 *    bounded number of verification attempts before being burned;
 *  - a successful reset revokes *every* session of the account — if the code thief got in,
 *    the real owner's signed-out devices prove it just as loudly as the notification does;
 *  - the plaintext code is echoed in the API response ONLY when this deployment has no mail
 *    server (and is not production) — a labelled demo convenience, documented in
 *    docs/SECURITY.md; the same code is written to the outbox so the flow is inspectable.
 */

const GENERIC_REQUEST_ACK = 'If that address belongs to an active account, a six-digit code is on its way. It expires soon.';
const GENERIC_CODE_REJECT = 'That code is not valid or has expired. Request a new one.';

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Equal-length hex comparison without short-circuit timing differences. */
function codeMatches(plain, storedHash) {
  const a = createHash('sha256').update(String(plain)).digest();
  const b = Buffer.from(String(storedHash), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const activeRow = (db, userId) => db.get(
  `SELECT * FROM password_resets
    WHERE user_id = ? AND consumed_at IS NULL AND datetime(expires_at) > datetime('now')
    ORDER BY id DESC LIMIT 1`,
  [userId],
);

/**
 * Step 1 — issue a code for `email` (or pretend to). Never reveals whether the account
 * exists, is disabled, or already has a code in flight.
 */
export async function requestReset(db, { email, req }) {
  const user = db.get('SELECT id, email, full_name, is_active FROM users WHERE email = ?', [email]);
  if (!user || !user.is_active) return { sent: true, message: GENERIC_REQUEST_ACK };

  const existing = activeRow(db, user.id);
  if (existing && Date.now() - Date.parse(existing.created_at) < config.auth.recovery.throttleSeconds * 1000) {
    return { sent: true, message: GENERIC_REQUEST_ACK }; // one code at a time; the first is still live
  }
  if (existing) db.run('UPDATE password_resets SET consumed_at = ? WHERE id = ?', [nowIso(), existing.id]);

  const code = newCode();
  const ttl = config.auth.recovery.codeTtlMinutes;
  const mail = await sendMail({
    to: user.email,
    subject: `Your BEM-FRS password recovery code: ${code}`,
    text: [
      `Someone asked to reset the password for ${user.email} on the Biomedical Equipment`,
      'Maintenance & Fault Reporting System.',
      '',
      `One-time code: ${code}`,
      `This code expires in ${ttl} minutes and can be tried ${config.auth.recovery.maxAttempts} times.`,
      '',
      'If this was not you, sign in normally and tell the biomedical engineering department —',
      'your password is still unchanged until this code is used.',
      '',
      '(Automated message — demo deployment. Do not share this code with anyone.)',
    ].join('\n'),
  });

  const reveal = config.auth.recovery.revealCodeInResponse && !config.isProd && !mailConfigured() && mail.status === 'sent';
  db.run(
    `INSERT INTO password_resets
       (user_id, code_hash, requested_ip_hash, delivered_to, delivery_status, delivery_detail,
        attempts, created_at, expires_at)
     VALUES (?,?,?,?,?,?,0,?,?)`,
    [
      user.id,
      hashToken(code),
      req?.ip ? hashToken(String(req.ip).replace(/^::ffff:/, '')) : null,
      user.email,
      mail.channel === 'outbox' ? 'outbox' : mail.status,
      mail.detail,
      nowIso(),
      new Date(Date.now() + ttl * 60_000).toISOString(),
    ],
  );
  audit({
    actor: null, action: 'user.password_reset_requested', entityType: 'user', entityId: user.id,
    entityRef: user.email, summary: `Password recovery code issued (${mail.channel}, ${mail.status})`, req,
  });

  return {
    sent: true,
    message: mail.status === 'sent' ? GENERIC_REQUEST_ACK : 'The recovery mail could not be delivered right now — try again shortly or ask an administrator.',
    ...(reveal ? { devOtp: code, devNote: 'Demo build without a mail server: the code is also in data/outbox/ on the server. Configure SMTP_HOST for real deployments.' } : {}),
  };
}

/**
 * Step 2 — redeem the code and set a new password. `newPassword` policy is checked
 * BEFORE the code so a typo in the password box does not burn a verification attempt.
 */
export async function completeReset(db, { email, code, newPassword, req }) {
  const reject = () => { throw badRequest(GENERIC_CODE_REJECT); };
  const user = db.get('SELECT id, email, full_name, is_active FROM users WHERE email = ?', [email]);
  const row = user && activeRow(db, user.id);
  if (!user || !user.is_active || !row) reject();

  if (row.attempts >= config.auth.recovery.maxAttempts) {
    db.run('UPDATE password_resets SET consumed_at = ? WHERE id = ?', [nowIso(), row.id]);
    reject();
  }
  if (!codeMatches(code, row.code_hash)) {
    const attempts = row.attempts + 1;
    const burned = attempts >= config.auth.recovery.maxAttempts;
    db.run(`UPDATE password_resets SET attempts = ?${burned ? ', consumed_at = ?' : ''} WHERE id = ?`,
      burned ? [attempts, nowIso(), row.id] : [attempts, row.id]);
    if (burned) audit({ actor: null, action: 'user.password_reset_burned', entityType: 'user', entityId: user.id,
      entityRef: user.email, summary: 'Recovery code burned after too many wrong attempts', req });
    reject();
  }

  const problems = passwordProblems(newPassword, { fullName: user.full_name, email: user.email });
  if (problems.length) throw badRequest('New password does not meet policy', { fields: { newPassword: problems } });

  const now = nowIso();
  db.run('UPDATE users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
    [await hashPassword(newPassword), now, user.id]);
  db.run('UPDATE password_resets SET consumed_at = ? WHERE id = ?', [now, row.id]);
  const revoked = db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, user.id]).changes;

  audit({
    actor: { id: user.id, roleCode: 'owner' }, action: 'user.self_password_reset', entityType: 'user',
    entityId: user.id, entityRef: user.email,
    summary: `Password reset with a one-time code; ${revoked} active session(s) signed out`, req,
  });
  notifyUser(db, {
    userId: user.id, type: 'account', severity: 'warning',
    title: 'Your password was changed',
    body: `The password on ${user.email} was reset via the one-time-code flow${revoked ? ` and ${revoked} session(s) were signed out` : ''}. If this was not you, contact the biomedical engineering department immediately.`,
  });

  return { reset: true, sessionsRevoked: revoked };
}
