import { config } from '../config/index.js';
import { hashToken } from '../lib/tokens.js';
import { getDb } from '../lib/db.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { capabilitiesFor, can, hintFor } from '../auth/capabilities.js';

export const SESSION_COOKIE = 'bmems_session';

const splitCookie = (header) => {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
};

export const bearerToken = (req) => {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
};

/**
 * Resolves the session for every request that opts in.  A token may arrive as an
 * httpOnly cookie (browser) or a Bearer token (mobile client / scripts).  Sessions are
 * stored server-side and revocable — logout and admin "sign out everywhere" take effect
 * on the next request, which a stateless JWT cannot promise.
 */
export function authenticate(req, _res, next) {
  try {
    const db = getDb();
    const fromCookie = splitCookie(req.headers.cookie)[SESSION_COOKIE];
    const fromHeader = bearerToken(req);
    const token = fromCookie || fromHeader;
    req.authVia = fromCookie ? 'cookie' : fromHeader ? 'bearer' : null;
    if (!token) return next();

    const session = db.get(
      `SELECT s.*, u.id AS uid, u.full_name, u.email, u.is_active, u.must_change_password,
              u.job_title, u.department, u.phone, u.employee_id, r.code AS role_code
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN roles r ON r.id = u.role_id
        WHERE s.token_hash = ?`,
      [hashToken(token)],
    );
    if (!session) return next();

    const nowIso = new Date().toISOString();
    if (session.revoked_at || session.expires_at < nowIso) return next();
    if (!session.is_active) {
      db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowIso, session.id]);
      return next();
    }

    req.token = token;
    req.tokenFromCookie = !!fromCookie;
    req.session = session;
    req.user = {
      id: session.uid,
      fullName: session.full_name,
      email: session.email,
      phone: session.phone,
      employeeId: session.employee_id,
      jobTitle: session.job_title,
      department: session.department,
      roleCode: session.role_code,
      mustChangePassword: !!session.must_change_password,
      capabilities: capabilitiesFor({ roleCode: session.role_code }),
    };

    // Touch at most once a minute to keep writes off the hot path.
    if (Date.parse(nowIso) - Date.parse(session.last_seen_at) > 60_000) {
      db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [nowIso, session.id]);
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized('Sign in to continue'));
  next();
}

/**
 * CSRF: cookie credentials are the ambient ones, so any write authenticated by a cookie
 * must also carry the session's unguessable header.  Bearer clients are immune (no
 * ambient credential) and are exempt.
 */
export function csrfGuard(req, _res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (safe || !req.tokenFromCookie) return next();
  const sent = req.get('x-bm-csrf');
  if (!sent || sent !== req.session?.csrf_token) {
    return next(forbidden('Missing or invalid CSRF token. Reload the page and try again.', {
      hint: 'Send the value from GET /api/v1/auth/me as the X-BM-CSRF header.',
    }));
  }
  return next();
}

/** Role gate. */
export function requireRole(...roles) {
  const set = new Set(roles);
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!set.has(req.user.roleCode)) {
      // Same shape as requireCap 403s: human message + details.hint (UI renders both).
      const friendly = roles.map((r) => ROLE_FRIENDLY[r] ?? `the “${r}” role`).join(' or ');
      return next(forbidden(`This area is for ${friendly}.`, {
        hint: 'Ask a department administrator if your role should include this.',
        requiredRole: roles,
      }));
    }
    return next();
  };
}
const ROLE_FRIENDLY = {
  admin: 'a department administrator',
  technician: 'biomedical engineering staff',
  reporter: 'a registered reporter',
};

/** Capability gate — the preferred form, since it describes intent, not seniority. */
export function requireCap(...capabilities) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    const granted = capabilities.find((c) => can(req.user, c));
    if (!granted) {
      const hint = capabilities.map(hintFor).find(Boolean)
        ?? `Your role (${req.user.roleCode}) is not permitted to perform this action.`;
      return next(forbidden(hint, { requiredCapability: capabilities.join(' or '), role: req.user.roleCode }));
    }
    req.capabilityUsed = granted;
    return next();
  };
}

/** Response helper shared by auth routes. */
export const cookieOptions = (maxAgeSeconds) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
  path: '/',
  maxAge: Math.max(0, Math.floor(maxAgeSeconds) * 1000),
});
