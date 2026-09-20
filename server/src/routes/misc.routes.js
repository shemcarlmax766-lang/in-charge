import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { getDb } from '../lib/db.js';
import { validate } from '../lib/validate.js';
import { config } from '../config/index.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { requireAuth, requireCap } from '../middleware/auth.js';
import { writeLimit } from '../middleware/security.js';
import { badRequest } from '../lib/errors.js';
import { shape } from '../lib/shape.js';
import * as maintenance from '../services/maintenance.service.js';
import * as risk from '../services/risk.service.js';
import * as dashboard from '../services/dashboard.service.js';
import * as reports from '../services/report.service.js';
import * as meta from '../services/meta.service.js';
import * as notifications from '../services/notification.service.js';
import { listMine, unreadCount, markRead, remove } from '../services/notification.service.js';
import { audit } from '../lib/audit.js';
import { listParts, upsertParts } from '../services/repair.service.js';

/* ========================================================== maintenance ==== */
const pm = Router();
pm.use(requireAuth);

pm.get('/vocabulary', (req, res) => {
  res.json({
    states: maintenance.PM_STATES,
    dueSoonDays: maintenance.DUE_SOON_DAYS,
    checklistTemplates: maintenance.checklistTemplates(),
    conditions: ['pass', 'pass_with_notes', 'needs_attention', 'needs_repair', 'replaced'],
  });
});

pm.get('/schedules', asyncRoute((req, res) => {
  const { value } = validate(req.query, {
    equipmentId: { type: 'int', min: 1 },
    technicianId: { type: 'int', min: 1 },
    state: { type: 'enum', values: ['', 'overdue', 'due_soon', 'up_to_date'] },
    activeOnly: { type: 'bool', default: true },
  });
  res.json({ items: maintenance.listSchedules(getDb(), value) });
}));

pm.get('/due-board', asyncRoute((req, res) => {
  const { value } = validate(req.query, {
    days: { type: 'int', min: 1, max: 365, default: 45 },
    includeUpToDate: { type: 'bool', default: false },
  });
  const items = maintenance.dueBoard(getDb(), value);
  const buckets = items.reduce((acc, r) => {
    const k = r.pmState?.state ?? 'not_scheduled';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  res.json({ items, buckets, dueSoonDays: maintenance.DUE_SOON_DAYS });
}));

/** Reminder sweep — cron-friendly and idempotent (see notification.service.runMaintenanceReminders). */
pm.post('/reminders', requireCap('meta.manage'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.body, { dueSoonDays: { type: 'int', min: 1, max: 120, default: 14 } });
  res.json(notifications.runMaintenanceReminders(getDb(), { ...value, actor: req.user, req }));
}));

pm.get('/compliance', asyncRoute((req, res) => {
  const { value } = validate(req.query, { days: { type: 'int', min: 30, max: 1095, default: 180 } });
  res.json(maintenance.compliance(getDb(), value));
}));

pm.get('/records', asyncRoute((req, res) => {
  const { value } = validate(req.query, {
    equipmentId: { type: 'int', min: 1 },
    technicianId: { type: 'int', min: 1 },
    from: { type: 'date' },
    to: { type: 'date' },
    condition: { type: 'enum', values: ['', 'pass', 'pass_with_notes', 'needs_attention', 'needs_repair', 'replaced'] },
    lateOnly: { type: 'bool' },
    page: { type: 'int', min: 1, default: 1 },
    perPage: { type: 'int', min: 1, max: 100, default: config.limits.listPageSize },
  });
  res.json(maintenance.listRecords(getDb(), value));
}));

pm.get('/records/:id', asyncRoute((req, res) => {
  const { value } = validate(req.params, { id: { type: 'int', required: true, min: 1 } });
  res.json(maintenance.recordDetail(getDb(), value.id));
}));

const scheduleSchema = {
  equipmentId: { type: 'int', required: true, min: 1 },
  title: { type: 'string', required: true, min: 3, max: 120 },
  intervalDays: { type: 'int', required: true, min: 1, max: 3650 },
  responsibleTechnicianId: { type: 'int', min: 1 },
  nextDueOn: { type: 'date' },
  lastDoneOn: { type: 'date', noFuture: true },
  notes: { type: 'string', max: 1000 },
  checklist: { type: 'array', maxLen: 40, of: { type: 'raw' } },
  useTemplate: { type: 'bool' },
};

pm.get('/schedules/:id', asyncRoute((req, res) => {
  const { value } = validate(req.params, { id: { type: 'int', required: true, min: 1 } });
  res.json(maintenance.scheduleDetail(getDb(), value.id));
}));

pm.post('/schedules', requireCap('maintenance.schedule.manage'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.body, scheduleSchema);
  res.status(201).json(maintenance.createSchedule(getDb(), value, req.user, req));
}));

pm.patch('/schedules/:id', requireCap('maintenance.schedule.manage'), writeLimit(), asyncRoute((req, res) => {
  const { id, ...body } = { ...req.params, ...req.body };
  const { value } = validate(body, {
    title: { type: 'string', min: 3, max: 120 },
    intervalDays: { type: 'int', min: 1, max: 3650 },
    responsibleTechnicianId: { type: 'int', min: 1 },
    nextDueOn: { type: 'date' },
    lastDoneOn: { type: 'date', noFuture: true },
    notes: { type: 'string', max: 1000 },
    checklist: { type: 'array', maxLen: 40, of: { type: 'raw' } },
    isActive: { type: 'bool' },
  }, { partial: true });
  res.json(maintenance.updateSchedule(getDb(), Number(id), value, req.user, req));
}));

pm.delete('/schedules/:id', requireCap('meta.manage'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, {
    id: { type: 'int', required: true, min: 1 }, reason: { type: 'string', max: 300 },
  });
  res.json(maintenance.deleteSchedule(getDb(), value.id, value, req.user, req));
}));

const recordSchema = {
  scheduleId: { type: 'int', min: 1 },
  equipmentId: { type: 'int', min: 1 },
  performedOn: { type: 'date', noFuture: true },
  startedAt: { type: 'datetime', noFuture: true },
  completedAt: { type: 'datetime' },
  durationMinutes: { type: 'int', min: 0, max: 10080 },
  downtimeMinutes: { type: 'int', min: 0, max: 10080 },
  findings: { type: 'string', max: 4000 },
  actionsTaken: { type: 'string', max: 4000 },
  conditionFound: { type: 'enum', values: ['pass', 'pass_with_notes', 'needs_attention', 'needs_repair', 'replaced'] },
  nextDueOn: { type: 'date' },
  dueOn: { type: 'date' },
  markAsMissed: { type: 'bool', default: false },
  checklistResults: { type: 'array', maxLen: 60, of: { type: 'raw' } },
};

pm.post('/records', requireCap('maintenance.record.write', 'meta.manage'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.body, recordSchema);
  res.status(201).json(maintenance.createRecord(getDb(), value, req.user, req));
}));

pm.post('/schedules/:id/complete', requireCap('maintenance.record.write', 'meta.manage'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, {
    ...recordSchema, id: { type: 'int', required: true, min: 1 },
  });
  const { id, ...rest } = value;
  res.status(201).json(maintenance.createRecord(getDb(), { ...rest, scheduleId: id }, req.user, req));
}));

pm.delete('/records/:id', requireCap('meta.manage'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, {
    id: { type: 'int', required: true, min: 1 }, reason: { type: 'string', required: true, min: 5, max: 300 },
  });
  res.json(maintenance.deleteRecord(getDb(), value.id, value, req.user, req));
}));

/* ============================================================ notifications = */
const nt = Router();
nt.use(requireAuth);

nt.get('/', asyncRoute((req, res) => {
  const { value } = validate(req.query, { unreadOnly: { type: 'bool', default: false }, limit: { type: 'int', min: 1, max: 100, default: 50 } });
  const db = getDb();
  res.json({ items: listMine(db, req.user, value), unread: unreadCount(db, req.user) });
}));

nt.get('/unread-count', asyncRoute((req, res) => {
  res.json({ unread: unreadCount(getDb(), req.user) });
}));

nt.post('/read', writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.body, { ids: { type: 'idList' } });
  res.json({ unread: markRead(getDb(), req.user, value.ids ?? []) });
}));

nt.delete('/:id', writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.params, { id: { type: 'int', required: true, min: 1 } });
  remove(getDb(), req.user, value.id);
  res.json({ deleted: true });
}));

/** Shows exactly which channels a notification was sent/skipped on (proof the plumbing works). */
nt.get('/:id/deliveries', requireCap('meta.manage', 'notification.view.own'), asyncRoute((req, res) => {
  const { value } = validate(req.params, { id: { type: 'int', required: true, min: 1 } });
  const db = getDb();
  const owner = db.value('SELECT user_id FROM notifications WHERE id = ?', [value.id]);
  if (owner === null) return res.status(404).json({ error: { code: 'not_found', message: 'Notification not found' } });
  if (owner !== req.user.id && req.user.roleCode !== 'admin') return res.status(403).json({ error: { code: 'forbidden', message: 'Not your notification' } });
  return res.json({ items: notifications.deliveryLedger(db, value.id) });
}));

nt.post('/prune', requireCap('meta.manage'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.body, { days: { type: 'int', min: 7, max: 3650, default: 90 } });
  res.json({ removed: notifications.prune(getDb(), value.days) });
}));

/* ============================================================ dashboard ==== */
const db_ = Router();
db_.use(requireAuth);

db_.get('/', asyncRoute((req, res) => {
  const { value } = validate(req.query, { chartMonths: { type: 'int', min: 3, max: 36, default: 12 } });
  res.json(dashboard.dashboard(getDb(), req.user, value));
}));

db_.get('/risk', asyncRoute((req, res) => {
  const { value } = validate(req.query, {
    limit: { type: 'int', min: 1, max: 200, default: 25 },
    level: { type: 'enum', values: ['', 'low', 'moderate', 'high'] },
  });
  res.json(risk.fleetRisk(getDb(), value));
}));

db_.get('/risk/model', (req, res) => {
  res.json(risk.modelMetadata());
});

db_.get('/risk/:equipmentId', asyncRoute((req, res) => {
  const { value } = validate(req.params, { equipmentId: { type: 'int', required: true, min: 1 } });
  const assessment = risk.assessRisk(getDb(), value.equipmentId);
  if (!assessment) return res.status(404).json({ error: { code: 'not_found', message: 'Equipment not found' } });
  return res.json(assessment);
}));

/* ============================================================== reports ==== */
const rp = Router();
rp.use(requireAuth);

rp.get('/', (req, res) => {
  res.json({ items: reports.reportList(req.user), note: 'CSV downloads and a print-to-PDF view are generated from the same query as the on-screen table.' });
});

rp.get('/:key', asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.query }, reportQuery(req));
  res.json(reports.runReport(getDb(), value.key, value, req.user));
}));

rp.get('/export/:key/csv', asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.query }, reportQuery(req));
  const { csv, filename } = reports.reportCsv(getDb(), value.key, value, req.user);
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${filename}"`).send(csv);
}));

rp.get('/export/:key/print', asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.query }, reportQuery(req));
  const settings = meta.getSettings(getDb());
  // base64url keeps the nonce safe for both the CSP header and the HTML attribute.
  const nonce = randomBytes(16).toString('base64url');
  const html = reports.reportHtml(getDb(), value.key, value, req.user, {
    department: settings.department_name.value, institution: settings.institution_name.value, nonce,
  });
  res.set('Content-Type', 'text/html; charset=utf-8')
    .set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`)
    .send(html);
}));

function reportQuery(req) {
  return {
    key: { type: 'enum', required: true, values: Object.keys(reports.REPORTS) },
    from: { type: 'date' }, to: { type: 'date' },
    status: { type: 'string', max: 120 }, severity: { type: 'string', max: 120 },
    categoryId: { type: 'int', min: 1 }, locationId: { type: 'int', min: 1 },
    technicianId: { type: 'int', min: 1 }, equipmentId: { type: 'int', min: 1 },
    actorId: { type: 'int', min: 1 }, q: { type: 'string', max: 80 },
  };
}

/* ===================================================== reference data ======= */
const ref = Router();
ref.use(requireAuth);

ref.get('/picklists', asyncRoute((req, res) => res.json(meta.picklists(getDb()))));
ref.get('/categories', asyncRoute((req, res) => {
  const { value } = validate(req.query, { q: { type: 'string', max: 60 }, includeInactive: { type: 'bool', default: true } });
  res.json({ items: meta.listReference(getDb(), 'category', value) });
}));
ref.get('/locations', asyncRoute((req, res) => {
  const { value } = validate(req.query, { q: { type: 'string', max: 60 }, includeInactive: { type: 'bool', default: true } });
  res.json({ items: meta.listReference(getDb(), 'location', value) });
}));
ref.get('/fault-categories', asyncRoute((req, res) => {
  const { value } = validate(req.query, { q: { type: 'string', max: 60 }, includeInactive: { type: 'bool', default: true } });
  res.json({ items: meta.listReference(getDb(), 'faultCategory', value) });
}));

for (const [route, kind] of [['categories', 'category'], ['locations', 'location'], ['fault-categories', 'faultCategory']]) {
  ref.post(`/${route}`, requireCap('meta.manage'), writeLimit(), asyncRoute((req, res) => {
    const { value } = validate(req.body, referenceSchema(kind));
    res.status(201).json(meta.upsertReference(getDb(), kind, value, req.user, req));
  }));
  ref.patch(`/${route}/:id`, requireCap('meta.manage'), writeLimit(), asyncRoute((req, res) => {
    const { value } = validate({ ...req.params, ...req.body }, { id: { type: 'int', required: true, min: 1 }, ...referenceSchema(kind) }, { partial: true });
    const { id, ...body } = value;
    res.json(meta.upsertReference(getDb(), kind, { ...body, id: Number(id) }, req.user, req));
  }));
  ref.delete(`/${route}/:id`, requireCap('meta.manage'), writeLimit(), asyncRoute((req, res) => {
    const { value } = validate({ ...req.params, ...req.body }, {
      id: { type: 'int', required: true, min: 1 }, force: { type: 'bool', default: false },
    });
    res.json(meta.deleteReference(getDb(), kind, value.id, value, req.user, req));
  }));
}

function referenceSchema(kind) {
  const base = {
    id: { type: 'int', min: 1 },
    code: { type: 'string', required: true, max: 12 },
    name: { type: 'string', required: true, max: 120 },
    isActive: { type: 'bool' },
  };
  if (kind === 'category') return { ...base, description: { type: 'string', max: 300 } };
  if (kind === 'location') return { ...base, building: { type: 'string', max: 80 }, floor: { type: 'string', max: 40 }, room: { type: 'string', max: 40 } };
  return { ...base, description: { type: 'string', max: 300 }, defaultSeverity: { type: 'enum', values: SEVERITY_VALUES } };
}
const SEVERITY_VALUES = ['low', 'medium', 'high', 'critical'];

ref.get('/settings', asyncRoute((req, res) => {
  res.json({ settings: meta.getSettings(getDb()), definitions: meta.settingDefinitions() });
}));
ref.patch('/settings', requireCap('settings.manage'), writeLimit(), asyncRoute((req, res) => {
  if (!req.body || typeof req.body !== 'object') throw badRequest('Send an object of settings to change');
  res.json(meta.updateSettings(getDb(), req.body, req.user, req));
}));

/* ============================================================== parts ====== */
const parts = Router();
parts.use(requireAuth);
parts.get('/', asyncRoute((req, res) => {
  const { value } = validate(req.query, { q: { type: 'string', max: 60 }, activeOnly: { type: 'bool', default: true } });
  const db = getDb();
  res.json({ items: listParts(db, value) });
}));
parts.post('/', requireCap('meta.manage'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.body, {
    id: { type: 'int', min: 1 },
    code: { type: 'string', required: true, max: 24 },
    name: { type: 'string', required: true, max: 120 },
    category: { type: 'string', max: 60 },
    unit: { type: 'string', max: 16 },
    unitCost: { type: 'float', min: 0 },
    inStock: { type: 'int', min: 0, max: 1_000_000 },
    isActive: { type: 'bool' },
  });
  res.status(201).json(upsertParts(getDb(), value, req.user, req));
}));

/* ============================================================ audit log ===== */
const au = Router();
au.use(requireAuth, requireCap('audit.view'));
au.get('/', asyncRoute((req, res) => {
  const { value } = validate(req.query, {
    q: { type: 'string', max: 60 }, entityType: { type: 'string', max: 40 }, entityId: { type: 'int', min: 1 },
    actorId: { type: 'int', min: 1 }, action: { type: 'string', max: 40 },
    from: { type: 'date' }, to: { type: 'date' },
    page: { type: 'int', min: 1, default: 1 }, perPage: { type: 'int', min: 1, max: 200, default: 50 },
  });
  const db = getDb();
  const where = [];
  const params = [];
  if (value.q) { where.push('(a.action LIKE ? OR a.summary LIKE ? OR a.entity_ref LIKE ?)'); params.push(`%${value.q}%`, `%${value.q}%`, `%${value.q}%`); }
  if (value.entityType) { where.push('a.entity_type = ?'); params.push(value.entityType); }
  if (value.entityId) { where.push('a.entity_id = ?'); params.push(value.entityId); }
  if (value.actorId) { where.push('a.actor_id = ?'); params.push(value.actorId); }
  if (value.action) { where.push('a.action = ?'); params.push(value.action); }
  if (value.from) { where.push('date(a.created_at) >= date(?)'); params.push(value.from); }
  if (value.to) { where.push('date(a.created_at) <= date(?)'); params.push(value.to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.value(`SELECT COUNT(*) FROM audit_logs a ${whereSql}`, params) ?? 0;
  const items = db.all(
    `SELECT a.id, a.created_at, a.action, a.entity_type, a.entity_id, a.entity_ref, a.summary,
            a.ip, a.actor_role, u.full_name AS actor_name, a.before_json, a.after_json
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
      ${whereSql} ORDER BY datetime(a.created_at) DESC, a.id DESC LIMIT ? OFFSET ?`,
    [...params, value.perPage, (value.page - 1) * value.perPage],
  );
  res.json({
    items: items.map((r) => ({ ...shape(r), before: safeParse(r.before_json), after: safeParse(r.after_json) })),
    pagination: { page: value.page, perPage: value.perPage, total, pages: Math.max(1, Math.ceil(total / value.perPage)) },
  });
}));
const safeParse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

export { pm as maintenanceRoutes, nt as notificationRoutes, db_ as dashboardRoutes, rp as reportRoutes, ref as metaRoutes, parts as partsRoutes, au as auditRoutes };
