import { Router } from 'express';
import { getDb } from '../lib/db.js';
import { validate } from '../lib/validate.js';
import { config } from '../config/index.js';
import { asyncRoute, collectFiles } from '../middleware/errorHandler.js';
import { requireAuth, requireCap } from '../middleware/auth.js';
import { writeLimit } from '../middleware/security.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { shape } from '../lib/shape.js';
import * as faults from '../services/fault.service.js';
import * as repairs from '../services/repair.service.js';
import { FAULT_STATUSES, SEVERITIES, STATUS_META, TRANSITIONS, DEFAULT_SLA_HOURS } from '../services/fault.service.js';
import { saveAttachmentFiles } from './attachments.routes.js';

const router = Router();
router.use(requireAuth);

const createSchema = {
  equipmentId: { type: 'string', required: true, max: 40 },
  categoryId: { type: 'int', min: 1 },
  categoryCode: { type: 'string', max: 24 },
  title: { type: 'string', required: true, min: 4, max: 160 },
  description: { type: 'string', required: true, min: 10, max: 4000 },
  severity: { type: 'enum', required: true, values: SEVERITIES },
  observedAt: { type: 'datetime', noFuture: true },
  locationId: { type: 'int', min: 1 },
  onBehalfOf: { type: 'string', max: 120 },
};

const idParam = { id: { type: 'int', required: true, min: 1 } };

/* ------------------------------------------------------------------ listing -- */

const listSchema = {
  q: { type: 'string', max: 80 },
  status: { type: 'enum', values: ['', ...FAULT_STATUSES] },
  severity: { type: 'enum', values: ['', ...SEVERITIES] },
  categoryId: { type: 'int', min: 1 },
  equipmentId: { type: 'int', min: 1 },
  technicianId: { type: 'int', min: 1 },
  reporterId: { type: 'int', min: 1 },
  locationId: { type: 'int', min: 1 },
  unassigned: { type: 'bool' },
  overdue: { type: 'bool' },
  scope: { type: 'enum', values: ['', 'mine', 'assigned', 'open', 'unassigned'] },
  from: { type: 'date' },
  to: { type: 'date' },
  sort: { type: 'string', max: 20 },
  dir: { type: 'enum', values: ['', 'asc', 'desc'] },
  page: { type: 'int', min: 1, default: 1 },
  perPage: { type: 'int', min: 1, default: config.limits.listPageSize },
};

router.get('/', asyncRoute((req, res) => {
  const { value } = validate(req.query, listSchema);
  res.json(faults.listFaults(getDb(), value, req.user));
}));

/** Workflow metadata so the UI renders the state machine instead of hard-coding it. */
router.get('/vocabulary', (req, res) => {
  const db = getDb();
  res.json({
    statuses: FAULT_STATUSES.map((value) => ({ value, ...STATUS_META[value] })),
    severities: SEVERITIES.map((value) => ({ value, slaHours: DEFAULT_SLA_HOURS[value], label: value[0].toUpperCase() + value.slice(1) })),
    transitions: Object.fromEntries(Object.entries(TRANSITIONS).map(([k, v]) => [k, v])),
    categories: db.all('SELECT id, code, name, description, default_severity FROM fault_categories WHERE is_active = 1 ORDER BY name').map(shape),
    yourRole: req.user.roleCode,
    rules: {
      repairedRequiresRepairRecord: true,
      technicalStagesRequireTechnician: true,
      reporterMayEditWhileReported: true,
      reopenIsAdminOnly: true,
    },
  });
});

router.post('/', writeLimit(), collectFiles('files', config.uploads.maxFiles), asyncRoute((req, res) => {
  const { value } = validate(req.body, createSchema);
  if (!value.categoryId && !value.categoryCode) {
    throw badRequest('Choose a fault category', { fields: { categoryId: ['Required'] } });
  }
  const db = getDb();
  const created = faults.createFault(db, value, req.user, req);
  const attached = saveAttachmentFiles(db, {
    files: req.files, ownerType: 'fault_report', ownerId: created.fault.id, kind: 'photo', actor: req.user, req,
  });
  res.status(201).json({ ...created, attachments: { added: attached.length, ids: attached.map((a) => a.id) } });
}));

router.get('/:id', asyncRoute((req, res) => {
  const { value } = validate(req.params, idParam);
  res.json(faults.faultDetail(getDb(), value.id, req.user));
}));

/** Reporters may correct their own report only while nobody has started work on it. */
router.patch('/:id', writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.params, idParam);
  const { value: body } = validate(req.body, {
    title: { type: 'string', min: 4, max: 160 },
    description: { type: 'string', min: 10, max: 4000 },
    severity: { type: 'enum', values: SEVERITIES },
    categoryId: { type: 'int', min: 1 },
    locationId: { type: 'int', min: 1 },
    observedAt: { type: 'datetime', noFuture: true },
    onBehalfOf: { type: 'string', max: 120 },
  }, { partial: true });
  res.json(faults.updateFault(getDb(), value.id, body, req.user, req));
}));

router.post('/:id/assign', requireCap('fault.assign', 'fault.selfAssign'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, {
    ...idParam,
    technicianId: { type: 'int', required: true, min: 1 },
    note: { type: 'string', max: 500 },
  });
  res.json(faults.assignFault(getDb(), value.id, value, req.user, req));
}));

router.post('/:id/transition', writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, {
    ...idParam,
    targetStatus: { type: 'enum', required: true, values: FAULT_STATUSES.filter((s) => s !== 'assigned') },
    comment: { type: 'string', max: 1500 },
  });
  res.json(faults.transitionFault(getDb(), value.id, { toStatus: value.targetStatus, comment: value.comment }, req.user, req));
}));

router.post('/:id/notes', writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, { ...idParam, comment: { type: 'string', required: true, min: 2, max: 1500 } });
  res.json(faults.addNote(getDb(), value.id, value, req.user, req));
}));

router.post('/:id/reopen', writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, {
    ...idParam, reason: { type: 'string', max: 300 }, comment: { type: 'string', required: true, min: 5, max: 1000 },
  });
  res.json(faults.reopenFault(getDb(), value.id, value, req.user, req));
}));

/* ------------------------------------------------------------- attachments -- */

router.post('/:id/attachments', writeLimit(), collectFiles('files', config.uploads.maxFiles), asyncRoute((req, res) => {
  const { value } = validate(req.body, { kind: { type: 'enum', values: ['photo', 'document'], default: 'photo' }, caption: { type: 'string', max: 200 } });
  const { value: params } = validate(req.params, idParam);
  if (!req.files?.length) throw badRequest('Attach at least one file');
  const db = getDb();
  const detail = faults.getFault(db, params.id, req.user);
  const attached = saveAttachmentFiles(db, { files: req.files, ownerType: 'fault_report', ownerId: detail.id, kind: value.kind, caption: value.caption, actor: req.user, req });
  res.status(201).json({ added: attached.length, items: attached });
}));

/* ------------------------------------------------------------------ repairs -- */

const repairSchema = {
  diagnosis: { type: 'string', required: true, min: 5, max: 2000, collapseNewlines: true },
  rootCause: { type: 'string', required: true, min: 5, max: 2000, collapseNewlines: true },
  troubleshooting: { type: 'string', max: 4000 },
  repairActions: { type: 'string', required: true, min: 5, max: 4000, collapseNewlines: true },
  testResults: { type: 'string', max: 4000 },
  calibrationPerformed: { type: 'bool', default: false },
  calibrationDetails: { type: 'string', max: 2000 },
  parts: { type: 'raw' },
  partsCost: { type: 'float', min: 0 },
  labourCost: { type: 'float', min: 0, default: 0 },
  otherCost: { type: 'float', min: 0, default: 0 },
  currency: { type: 'string', max: 3 },
  safetyCheckConfirmed: { type: 'bool', default: false },
  safeToReturnToService: { type: 'bool', default: true },
  dateRepaired: { type: 'date', noFuture: true },
  notes: { type: 'string', max: 4000 },
};

router.get('/:id/repair', asyncRoute((req, res) => {
  const { value } = validate(req.params, idParam);
  const record = repairs.detailForFault(getDb(), value.id, req.user);
  if (!record) return res.json({ record: null, readiness: repairs.readiness(getDb(), value.id) });
  return res.json({ record, readiness: repairs.readiness(getDb(), value.id) });
}));

/** Draft or finalise the repair record (technician only). */
router.put('/:id/repair', requireCap('repair.write'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.params, idParam);
  const { value: body } = validate(req.body, repairSchema, { partial: true });
  if (typeof body.parts === 'string') {
    try { body.parts = JSON.parse(body.parts); } catch { throw badRequest('parts must be a JSON array'); }
  }
  const record = repairs.saveRepair(getDb(), value.id, body, req.user, req);
  res.json({ record, readiness: repairs.readiness(getDb(), value.id) });
}));

router.get('/:id/repair/readiness', asyncRoute((req, res) => {
  const { value } = validate(req.params, idParam);
  res.json(repairs.readiness(getDb(), value.id));
}));

/** Before/after photographs and signed-off test sheets for the repair record. */
router.post('/:id/repair/photos', requireCap('repair.write'), writeLimit(), collectFiles('files', config.uploads.maxFiles), asyncRoute(async (req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, {
    ...idParam,
    kind: { type: 'enum', required: true, values: ['before_photo', 'after_photo', 'document', 'certificate'] },
    caption: { type: 'string', max: 200 },
  });
  const db = getDb();
  const detail = faults.getFault(db, value.id, req.user);
  const record = db.get('SELECT id FROM repair_records WHERE fault_id = ?', [detail.id]);
  if (!record) throw badRequest('Save the repair record before attaching its evidence', { fields: { files: ['No repair record'] } });
  const out = saveAttachmentFiles(db, {
    files: req.files, ownerType: 'repair_record', ownerId: record.id, kind: value.kind, caption: value.caption, actor: req.user, req,
  });
  res.status(201).json({ added: out.length, items: out });
}));

export { router as faultsRoutes };
