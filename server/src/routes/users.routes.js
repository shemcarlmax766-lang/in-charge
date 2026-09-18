import { Router } from 'express';
import { getDb } from '../lib/db.js';
import { validate } from '../lib/validate.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { requireAuth, requireRole, requireCap } from '../middleware/auth.js';
import { writeLimit } from '../middleware/security.js';
import * as users from '../services/user.service.js';
import { passwordProblems } from '../lib/password.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

const createSchema = {
  fullName: { type: 'string', required: true, min: 2, max: 120 },
  email: { type: 'string', required: true, max: 160, lowercase: true, trim: true },
  roleCode: { type: 'enum', required: true, values: ['admin', 'technician', 'reporter'] },
  password: { type: 'string', max: 200 },
  employeeId: { type: 'string', max: 40 },
  phone: { type: 'string', max: 30 },
  jobTitle: { type: 'string', max: 80 },
  department: { type: 'string', max: 120 },
  mustChangePassword: { type: 'bool', default: true },
};

const updateSchema = {
  ...createSchema,
  fullName: { type: 'string', min: 2, max: 120 },
  email: { type: 'string', max: 160, lowercase: true },
  roleCode: { type: 'enum', values: ['admin', 'technician', 'reporter'] },
  password: undefined,
  isActive: { type: 'bool' },
};
delete updateSchema.password;

router.get('/', asyncRoute((req, res) => {
  const { value } = validate(req.query, {
    q: { type: 'string', max: 80 },
    role: { type: 'enum', values: ['', 'admin', 'technician', 'reporter'] },
    status: { type: 'enum', values: ['all', 'active', 'disabled'], default: 'active' },
  });
  res.json({ items: users.listUsers(getDb(), value) });
}));

/** Lightweight directory for assignment selectors. */
router.get('/lookup', (req, res) => {
  const rows = getDb().all(
    `SELECT u.id, u.full_name, u.job_title, r.code AS role, u.is_active
       FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.full_name`,
  );
  res.json({ items: rows });
});

router.get('/password-strength', asyncRoute((req, res) => {
  const { value } = validate(req.query, { candidate: { type: 'string', required: true, max: 200 }, fullName: { type: 'string', max: 120 }, email: { type: 'string', max: 160 } });
  res.json({ problems: passwordProblems(value.candidate, { fullName: value.fullName, email: value.email }) });
}));

router.get('/:id', requireCap('user.view'), asyncRoute((req, res) => {
  const { value } = validate({ id: req.params.id }, { id: { type: 'int', required: true, min: 1 } });
  res.json(users.getUser(getDb(), value.id));
}));

router.post('/', writeLimit(), asyncRoute(async (req, res) => {
  const { value } = validate(req.body, createSchema);
  const created = await users.createUser(getDb(), value, req.user, req);
  res.status(201).json(created);
}));

router.patch('/:id', writeLimit(), asyncRoute(async (req, res) => {
  const { value } = validate({ id: req.params.id }, { id: { type: 'int', required: true, min: 1 } });
  const { value: body } = validate(req.body, updateSchema, { partial: true });
  res.json(await users.updateUser(getDb(), value.id, body, req.user, req));
}));

router.post('/:id/reset-password', writeLimit(), asyncRoute(async (req, res) => {
  const { value } = validate({ id: req.params.id }, { id: { type: 'int', required: true, min: 1 } });
  const { value: body } = validate(req.body, {
    newPassword: { type: 'string', max: 200 },
    mustChange: { type: 'bool', default: true },
    revokeSessions: { type: 'bool', default: true },
  });
  res.json(await users.adminResetPassword(getDb(), value.id, body, req.user, req));
}));

router.post('/:id/sign-out', writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ id: req.params.id }, { id: { type: 'int', required: true, min: 1 } });
  res.json(users.forceSignOut(getDb(), value.id, req.user, req));
}));

router.delete('/:id', writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ id: req.params.id }, { id: { type: 'int', required: true, min: 1 } });
  const { value: body } = validate(req.body ?? {}, { reason: { type: 'string', max: 300 }, confirmEmail: { type: 'string', max: 160, lowercase: true } });
  const db = getDb();
  const email = db.value('SELECT email FROM users WHERE id = ?', [value.id]);
  if (!body.confirmEmail || body.confirmEmail !== email) {
    return res.status(400).json({
      error: { code: 'confirm_required', message: `Type the account email to confirm deletion`, details: { fields: { confirmEmail: [`Expected “${email}”`] } } },
    });
  }
  return res.json(users.deleteAccount(db, value.id, body, req.user, req));
}));

export { router as usersRoutes };
