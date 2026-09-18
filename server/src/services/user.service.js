import { getDb } from '../lib/db.js';
import { config } from '../config/index.js';
import { nowIso } from '../lib/time.js';
import { hashToken, csrfToken, randomToken, generatePassword } from '../lib/tokens.js';
import { hashPassword, verifyPassword, needsRehash, passwordProblems } from '../lib/password.js';
import { badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { capabilitiesFor, ROLES, roleLabel } from '../auth/capabilities.js';

const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const publicUser = (u) => ({
  id: u.id,
  employeeId: u.employee_id,
  fullName: u.full_name,
  email: u.email,
  phone: u.phone,
  jobTitle: u.job_title,
  department: u.department,
  roleCode: u.role_code ?? u.roleCode,
  roleLabel: roleLabel(u.role_code ?? u.roleCode),
  isActive: !!u.is_active,
  mustChangePassword: !!u.must_change_password,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
});

const USER_SELECT = `
  SELECT u.id, u.employee_id, u.full_name, u.email, u.phone, u.job_title, u.department,
         u.is_active, u.must_change_password, u.last_login_at, u.created_at, u.failed_attempts,
         u.locked_until, r.code AS role_code
    FROM users u JOIN roles r ON r.id = u.role_id`;

/* ------------------------------------------------------------------- login --- */

export async function login({ email, password, remember = false, req }) {
  const db = getDb();
  const normalized = String(email ?? '').trim().toLowerCase();
  const user = db.get(
    `SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?`,
    [normalized],
  );

  // A lockout is checked before the password, so a locked account is told it is locked
  // (the honest message) instead of being told its correct password is wrong.
  if (user?.locked_until && user.locked_until > nowIso()) {
    const mins = Math.max(1, Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60_000));
    audit({ actor: { id: user.id, roleCode: user.role_code }, action: 'auth.login_locked', entityType: 'user',
      entityId: user.id, entityRef: user.email, summary: `Sign-in refused while locked (${mins} min remaining)`, req });
    throw tooMany(`Account temporarily locked after repeated failures. Try again in ${mins} minute(s).`, mins * 60);
  }

  // Always spend a hash so "unknown address" and "wrong password" take the same time.
  const ok = user ? await verifyPassword(password, user.password_hash) : (await verifyPassword(password, DUMMY_HASH), false);

  if (!user || !ok) {
    if (user && user.is_active) {
      const attempts = (user.failed_attempts ?? 0) + 1;
      const lock = attempts >= config.auth.maxFailedAttempts;
      db.run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [
        lock ? 0 : attempts,
        lock ? new Date(Date.now() + config.auth.lockoutMinutes * 60_000).toISOString() : user.locked_until,
        user.id,
      ]);
      audit({ actor: { id: user.id, roleCode: user.role_code }, action: 'auth.login_failed', entityType: 'user', entityId: user.id, entityRef: user.email, summary: 'Failed sign-in attempt', req });
    }
    throw unauthorized('Email or password is incorrect');
  }

  if (!user.is_active) {
    audit({ actor: { id: user.id, roleCode: user.role_code }, action: 'auth.login_blocked', entityType: 'user', entityId: user.id, summary: 'Disabled account sign-in attempt', req });
    throw forbidden('This account has been deactivated. Contact the department administrator.');
  }

  if (needsRehash(user.password_hash)) {
    db.run('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?', [
      await hashPassword(password),
      user.id,
    ]);
  } else {
    db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
  }

  const session = createSession(db, user, { remember, req });
  return { ...session, user: publicUser(user) };
}

export function createSession(db, user, { remember = false, req } = {}) {
  const hours = remember ? config.auth.rememberMeTtlHours : config.auth.sessionTtlHours;
  const token = randomToken(32);
  const csrf = csrfToken();
  const created = nowIso();
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
  const { lastInsertRowid } = db.run(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      user.id, hashToken(token), csrf,
      req?.ip ?? null,
      req?.get?.('user-agent')?.slice(0, 250) ?? null,
      created, created, expiresAt,
    ],
  );
  return { token, csrf, sessionId: lastInsertRowid, expiresAt, ttlHours: hours };
}

export function logout(db, session) {
  if (session) db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowIso(), session.id]);
}

export const sessionExpiryHours = (remember = false) =>
  remember ? config.auth.rememberMeTtlHours : config.auth.sessionTtlHours;

/* ---------------------------------------------------------------- profile --- */

export function profile(db, user, session = null) {
  const row = db.get(`${USER_SELECT} WHERE u.id = ?`, [user.id]);
  if (!row) throw notFound('User not found');
  return {
    ...publicUser(row),
    // `row` is a raw snake_case DB row, so the role has to be read as role_code here.
    // (Reading `row.roleCode` silently produced an empty capability list for the SPA.)
    capabilities: capabilitiesFor({ roleCode: row.role_code ?? row.roleCode }),
    csrfToken: session?.csrf_token ?? null,
    activeSessions: db.value(
      'SELECT COUNT(*) FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?',
      [user.id, nowIso()],
    ),
    sessionExpiresAt: session?.expires_at ?? null,
  };
}

export async function changePassword(db, user, { currentPassword, newPassword, req }) {
  const row = db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  if (!row) throw notFound('User not found');
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw badRequest('Your current password is incorrect', { fields: { currentPassword: ['Incorrect password'] } });
  }
  const problems = passwordProblems(newPassword, { fullName: row.full_name, email: row.email });
  if (problems.length) throw badRequest('The new password does not meet policy', { fields: { newPassword: problems } });
  if (newPassword === currentPassword) throw badRequest('The new password must differ from the current one');

  db.run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', [
    await hashPassword(newPassword), nowIso(), user.id,
  ]);
  // Any password change invalidates every other session — stolen-token hygiene.
  db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ?', [nowIso(), user.id, req?.session?.id ?? -1]);
  audit({ actor: user, action: 'auth.password_changed', entityType: 'user', entityId: user.id, summary: 'Self-service password change; other sessions revoked', req });
  return { revokedOtherSessions: true };
}

/* ------------------------------------------------------------------ admin --- */

export function listUsers(db, { q = '', role = '', status = 'active' } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.employee_id LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (role) { where.push('r.code = ?'); params.push(role); }
  if (status === 'active') where.push('u.is_active = 1');
  if (status === 'disabled') where.push('u.is_active = 0');
  return db.all(
    `${USER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.code, u.full_name`,
    params,
  ).map(publicUser);
}

export const getUser = (db, id) => {
  const row = db.get(USER_SELECT + ' WHERE u.id = ?', [id]);
  if (!row) throw notFound('User not found');
  const counts = db.get(
    `SELECT (SELECT COUNT(*) FROM fault_reports WHERE reported_by = u.id) AS reports,
            (SELECT COUNT(*) FROM fault_reports WHERE assigned_to = u.id AND status NOT IN ('repaired','verified','closed')) AS open_assigned,
            (SELECT COUNT(*) FROM repair_records WHERE technician_id = u.id) AS repairs,
            (SELECT COUNT(*) FROM maintenance_records WHERE performed_by = u.id) AS maintenance
       FROM users u WHERE u.id = ?`,
    [id],
  );
  return { ...publicUser(row), stats: counts };
};

export async function createUser(db, input, actor, req) {
  const email = String(input.email).trim().toLowerCase();
  if (db.get('SELECT id FROM users WHERE email = ?', [email])) throw conflict('A user with that email already exists');
  if (input.employeeId && db.get('SELECT id FROM users WHERE employee_id = ?', [input.employeeId])) {
    throw conflict('That employee/student ID is already registered');
  }
  const role = ROLES[input.roleCode];
  if (!role) throw badRequest('Unknown role');

  let password = input.password || '';
  let generated = false;
  if (!password) {
    password = generatePassword(3);
    generated = true;
  }
  const problems = passwordProblems(password, { fullName: input.fullName, email });
  if (problems.length) throw badRequest('Password does not meet policy', { fields: { password: problems } });

  const { lastInsertRowid } = db.run(
    `INSERT INTO users (employee_id, full_name, email, phone, job_title, department, password_hash,
                        role_id, is_active, must_change_password, created_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`,
    [input.employeeId ?? null, input.fullName.trim(), email, input.phone ?? null, input.jobTitle ?? null,
      input.department ?? 'Biomedical Engineering', await hashPassword(password), role.id,
      generated ? 1 : input.mustChangePassword ? 1 : 0, nowIso(), actor.id],
  );
  audit({ actor, action: 'user.create', entityType: 'user', entityId: lastInsertRowid, entityRef: email,
    summary: `Created ${role.label} account${generated ? ' with a generated password' : ''}`,
    after: { email, role: input.roleCode, fullName: input.fullName }, req });

  const created = getUser(db, lastInsertRowid);
  return { user: created, temporaryPassword: generated ? password : null };
}

const UPDATABLE = {
  fullName: 'full_name', email: 'email', phone: 'phone', jobTitle: 'job_title',
  department: 'department', employeeId: 'employee_id', isActive: 'is_active',
};

export async function updateUser(db, id, data, actor, req) {
  const existing = db.get(USER_SELECT + ' WHERE u.id = ?', [id]);
  if (!existing) throw notFound('User not found');

  const sets = [];
  const params = [];
  const before = {};
  const after = {};
  for (const [field, column] of Object.entries(UPDATABLE)) {
    if (data[field] === undefined) continue;
    let value = data[field];
    if (field === 'email') value = String(value).trim().toLowerCase();
    if (field === 'isActive') value = value ? 1 : 0;
    if (field === 'email' && db.get('SELECT id FROM users WHERE email = ? AND id <> ?', [value, id])) {
      throw conflict('Another user already uses that email');
    }
    if (field === 'employeeId' && value && db.get('SELECT id FROM users WHERE employee_id = ? AND id <> ?', [value, id])) {
      throw conflict('Another user already uses that ID');
    }
    sets.push(`${column} = ?`);
    params.push(value);
    before[column] = existing[column];
    after[column] = value;
  }
  if (data.roleCode !== undefined && data.roleCode !== existing.role_code) {
    const role = ROLES[data.roleCode];
    if (!role) throw badRequest('Unknown role');
    sets.push('role_id = ?');
    params.push(role.id);
    before.role = existing.role_code;
    after.role = data.roleCode;
  }

  // Refuse to remove the last active administrator — a department must not lock itself out.
  const demoting = data.roleCode !== undefined && data.roleCode !== 'admin';
  const disabling = data.isActive === false;
  if ((demoting || disabling) && existing.role_code === 'admin') {
    const others = db.value(
      "SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin' AND u.is_active = 1 AND u.id <> ?",
      [id],
    );
    if (others < 1) throw conflict('At least one active administrator account must remain');
  }

  if (!sets.length) return getUser(db, id);
  sets.push('updated_at = ?');
  params.push(nowIso());
  if (disabling) {
    sets.push('deactivated_at = ?', 'deactivated_by = ?');
    params.push(nowIso(), actor.id);
    db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), id]);
  }
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);

  audit({ actor, action: 'user.update', entityType: 'user', entityId: id, entityRef: existing.email,
    summary: `Updated profile${after.role ? ` (role → ${after.role})` : ''}${disabling ? ' and deactivated' : ''}`,
    before, after, req });
  return getUser(db, id);
}

export async function adminResetPassword(db, id, { newPassword, revokeSessions = true, mustChange = true }, actor, req) {
  const user = db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) throw notFound('User not found');
  const pwd = newPassword || generatePassword(3);
  const problems = passwordProblems(pwd, { fullName: user.full_name, email: user.email });
  if (problems.length) throw badRequest('Replacement password does not meet policy', { fields: { password: problems } });
  db.run('UPDATE users SET password_hash = ?, must_change_password = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
    [await hashPassword(pwd), mustChange ? 1 : 0, nowIso(), id]);
  if (revokeSessions) db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), id]);
  audit({ actor, action: 'user.password_reset', entityType: 'user', entityId: id, entityRef: user.email,
    summary: `Password reset by ${actor.roleCode}${revokeSessions ? '; all sessions revoked' : ''}`, req });
  return { temporaryPassword: pwd, mustChange: !!mustChange, sessionsRevoked: revokeSessions ? 1 : 0 };
}

export function deleteAccount(db, id, { reason }, actor, req) {
  if (id === actor.id) throw badRequest('You cannot delete your own account');
  const user = db.get(USER_SELECT + ' WHERE u.id = ?', [id]);
  if (!user) throw notFound('User not found');

  const refs = db.get(
    `SELECT (SELECT COUNT(*) FROM fault_reports WHERE reported_by = ?) AS reports,
            (SELECT COUNT(*) FROM fault_reports WHERE assigned_to = ?) AS assignments,
            (SELECT COUNT(*) FROM repair_records WHERE technician_id = ?) AS repairs,
            (SELECT COUNT(*) FROM equipment WHERE custodian_user_id = ? OR responsible_technician_id = ?) AS equipment`,
    [id, id, id, id, id],
  );
  const blocking = Object.entries(refs).filter(([, v]) => v > 0);
  if (blocking.length) {
    throw conflict(
      `This account is referenced by official records (${blocking.map(([k, v]) => `${v} ${k}`).join(', ')}). ` +
        'Deactivate it instead — departmental history must stay attributable.',
      { refs },
    );
  }
  db.tx(() => {
    db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    db.run('DELETE FROM notifications WHERE user_id = ?', [id]);
    db.run('DELETE FROM users WHERE id = ?', [id]);
    audit({ actor, action: 'user.delete', entityType: 'user', entityId: id, entityRef: user.email,
      summary: `Deleted account (${reason || 'no reason given'})`, before: { email: user.email, role: user.role_code }, req });
  });
  return { deleted: true };
}

export const setActive = (db, id, isActive, actor, req) =>
  updateUser(db, id, { isActive }, actor, req);

export function listSessions(db, user, session = null) {
  return db.all(
    `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at,
            (id = ?) AS current
       FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY datetime(last_seen_at) DESC`,
    [session?.id ?? -1, user.id, nowIso()],
  );
}

export function revokeSession(db, user, sessionId) {
  const { changes } = db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?', [nowIso(), sessionId, user.id]);
  if (!changes) throw notFound('Session not found');
  return { revoked: true };
}

export const revokeAllSessions = (db, user, exceptId) => {
  const { changes } = db.run(
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL ${exceptId ? 'AND id <> ?' : ''}`,
    exceptId ? [nowIso(), user.id, exceptId] : [nowIso(), user.id],
  );
  return { revoked: changes };
};

/** Sign-out everywhere by an admin (lost phone / leaver). */
export function forceSignOut(db, id, actor, req) {
  const { changes } = db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), id]);
  audit({ actor, action: 'user.sessions_revoked', entityType: 'user', entityId: id, summary: `${changes} session(s) revoked`, req });
  return { revoked: changes };
}

export { publicUser, USER_SELECT };
