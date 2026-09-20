import { Router } from 'express';
import { config } from '../config/index.js';
import { getDb } from '../lib/db.js';
import { validate } from '../lib/validate.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { loginLimit } from '../middleware/security.js';
import { requireAuth } from '../middleware/auth.js';
import { SESSION_COOKIE, cookieOptions } from '../middleware/auth.js';
import * as users from '../services/user.service.js';
import { requestReset, completeReset } from '../services/password-reset.service.js';
import { capabilitiesFor, ROLES } from '../auth/capabilities.js';

const router = Router();

const loginSchema = {
  email: { type: 'string', required: true, max: 160, trim: true, lowercase: true },
  password: { type: 'string', required: true, max: 200 },
  remember: { type: 'bool', default: false },
};

const sendCookie = (res, token, ttlHours) =>
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(ttlHours * 3600) });

/**
 * POST /auth/login
 * Returns the session token in an httpOnly cookie (browser) *and* in the body (for the
 * mobile client / API consumers that store it in secure storage and send it as Bearer).
 */
router.post('/login', loginLimit(), asyncRoute(async (req, res) => {
  const { value } = validate(req.body, loginSchema);
  const result = await users.login({ ...value, req });
  const hours = users.sessionExpiryHours(value.remember);
  sendCookie(res, result.token, hours);
  res.json({
    user: result.user,
    token: result.token,
    csrfToken: result.csrf,
    expiresAt: result.expiresAt,
    capabilities: capabilitiesFor(result.user),
    roles: Object.values(ROLES).map(({ code, label }) => ({ code, label })),
  });
}));

/**
 * POST /auth/register — self-service account creation, Reporter role only (enforced
 * server-side; see user.service.selfRegister for the why).
 */
router.post('/register', loginLimit(), asyncRoute(async (req, res) => {
  const { value } = validate(req.body, {
    fullName: { type: 'string', required: true, min: 2, max: 120, trim: true },
    email: { type: 'string', required: true, max: 160, trim: true, lowercase: true, pattern: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address' },
    password: { type: 'string', required: true, max: 200 },
    phone: { type: 'string', max: 40 },
    department: { type: 'string', max: 120 },
  });
  res.status(201).json(await users.selfRegister(getDb(), value, req));
}));

const forgotSchema = {
  email: { type: 'string', required: true, max: 160, trim: true, lowercase: true },
};

/**
 * POST /auth/forgot-password — always 202, never reveals whether the address exists.
 * In dev mode without a mail server, the response additionally carries `devOtp`
 * (see docs/SECURITY.md); production builds can never get that field.
 */
router.post('/forgot-password', loginLimit(), asyncRoute(async (req, res) => {
  const { value } = validate(req.body, forgotSchema);
  res.status(202).json(await requestReset(getDb(), { email: value.email, req }));
}));

/** POST /auth/reset-password — redeem code + choose new password in one atomic step. */
router.post('/reset-password', loginLimit(), asyncRoute(async (req, res) => {
  const { value } = validate(req.body, {
    ...forgotSchema,
    code: { type: 'string', required: true, pattern: /^\d{6}$/, message: 'Enter the six-digit code you received' },
    newPassword: { type: 'string', required: true, max: 200 },
  });
  res.json(await completeReset(getDb(), { ...value, req }));
}));

router.post('/logout', asyncRoute((req, res) => {
  if (req.user) users.logout(getDb(), req.session);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ loggedOut: true });
}));

/** Who am I — drives the client's capability-based rendering. */
router.get('/me', requireAuth, asyncRoute((req, res) => {
  res.json(users.profile(getDb(), req.user, req.session));
}));

router.post('/change-password', requireAuth, loginLimit(), asyncRoute(async (req, res) => {
  const { value } = validate(req.body, {
    currentPassword: { type: 'string', required: true, max: 200 },
    newPassword: { type: 'string', required: true, max: 200 },
  });
  await users.changePassword(getDb(), req.user, { ...value, req });

  // Revoke everything, then re-issue a session for *this* device bound to the new password.
  getDb().run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ?', [new Date().toISOString(), req.user.id, req.session.id]);
  const session = users.createSession(getDb(), { id: req.user.id }, { req });
  sendCookie(res, session.token, session.ttlHours);
  res.json({ updated: true, csrfToken: session.csrf, expiresAt: session.expiresAt });
}));

router.get('/sessions', requireAuth, asyncRoute((req, res) => {
  res.json({ items: users.listSessions(getDb(), req.user, req.session), sessionTtlHours: config.auth.sessionTtlHours });
}));

router.delete('/sessions/:id', requireAuth, asyncRoute((req, res) => {
  const { value } = validate({ id: req.params.id }, { id: { type: 'int', required: true, min: 1 } });
  res.json(users.revokeSession(getDb(), req.user, value.id));
}));

router.post('/sessions/revoke-all', requireAuth, asyncRoute((req, res) => {
  const out = users.revokeAllSessions(getDb(), req.user, req.session?.id ?? null);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json(out);
}));

/** Static vocabulary the forms need, fetched once after login. */
router.get('/policy', asyncRoute((_req, res) => {
  res.json({
    minPasswordLength: config.auth.minPasswordLength,
    maxFailedAttempts: config.auth.maxFailedAttempts,
    lockoutMinutes: config.auth.lockoutMinutes,
    sessionTtlHours: config.auth.sessionTtlHours,
    maxUploadFiles: config.uploads.maxFiles,
    maxUploadMb: Math.round(config.uploads.maxFileBytes / 1024 / 1024),
    allowedExtensions: config.uploads.allowedExt,
    selfRegistration: config.auth.selfRegistration,
    recoveryCodeTtlMinutes: config.auth.recovery.codeTtlMinutes,
  });
}));

export { router as authRoutes };
