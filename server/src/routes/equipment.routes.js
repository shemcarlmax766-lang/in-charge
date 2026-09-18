import { Router } from 'express';
import { getDb } from '../lib/db.js';
import { validate } from '../lib/validate.js';
import { config } from '../config/index.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { collectFiles } from '../middleware/errorHandler.js';
import { requireAuth, requireCap } from '../middleware/auth.js';
import { writeLimit } from '../middleware/security.js';
import * as equipment from '../services/equipment.service.js';
import { EQUIPMENT_STATUSES, STATUS_META, CRITICALITIES } from '../services/equipment.status.js';
import { qrPng, qrSvg, qrDataUrl, equipmentUrl, publicBaseFrom } from '../lib/qr.js';
import { badRequest } from '../lib/errors.js';
import { shape } from '../lib/shape.js';
import { nowIso } from '../lib/time.js';
import { audit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth);

/* ----------------------------------------------------------------- schemas -- */

const common = {
  name: { type: 'string', required: true, min: 2, max: 160 },
  categoryId: { type: 'int', required: true, min: 1 },
  manufacturer: { type: 'string', max: 120 },
  model: { type: 'string', max: 120 },
  serialNumber: { type: 'string', max: 80 },
  department: { type: 'string', max: 120 },
  locationId: { type: 'int', min: 1 },
  custodianUserId: { type: 'int', min: 1 },
  custodianNote: { type: 'string', max: 160 },
  acquiredOn: { type: 'date', noFuture: true },
  warrantyProvider: { type: 'string', max: 120 },
  warrantyExpiresOn: { type: 'date' },
  criticality: { type: 'enum', values: CRITICALITIES },
  notes: { type: 'string', max: 2000 },
  maintenanceIntervalDays: { type: 'int', min: 1, max: 3650 },
  lastMaintenanceOn: { type: 'date', noFuture: true },
  nextMaintenanceOn: { type: 'date' },
  responsibleTechnicianId: { type: 'int', min: 1 },
};

const listSchema = {
  q: { type: 'string', max: 80 },
  status: { type: 'enum', values: ['', ...EQUIPMENT_STATUSES] },
  categoryId: { type: 'int', min: 1 },
  locationId: { type: 'int', min: 1 },
  criticality: { type: 'enum', values: ['', ...CRITICALITIES] },
  technicianId: { type: 'int', min: 1 },
  custodianId: { type: 'int', min: 1 },
  maintenanceState: { type: 'enum', values: ['', 'overdue', 'due_soon', 'up_to_date', 'not_scheduled'] },
  hasOpenFaults: { type: 'bool' },
  needsAttention: { type: 'bool' },
  showInactive: { type: 'bool' },
  sort: { type: 'string', max: 30 },
  dir: { type: 'enum', values: ['', 'asc', 'desc'] },
  page: { type: 'int', min: 1, default: 1 },
  perPage: { type: 'int', min: 1, default: config.limits.listPageSize } // oversize values are clamped by the service,
};

const idParam = { id: { type: 'string', required: true, max: 40 } };

/* -------------------------------------------------------------------- list -- */

/** GET /equipment — search + filter, one parameter for all free-text fields. */
router.get('/', asyncRoute((req, res) => {
  const { value } = validate(req.query, listSchema);
  const db = getDb();
  const { rows, pagination } = equipment.listEquipment(db, value, req.user);
  res.json({ items: rows, pagination, filters: value });
}));

/** Vocabulary + counts for filters. Declared before `/:id` so it is not swallowed. */
router.get('/vocabulary', (req, res) => {
  const db = getDb();
  const counts = db.all('SELECT status, COUNT(*) AS count FROM equipment WHERE is_active = 1 GROUP BY status');
  res.json({
    statuses: EQUIPMENT_STATUSES.map((value) => ({
      value,
      ...STATUS_META[value],
      count: counts.find((c) => c.status === value)?.count ?? 0,
    })),
    criticalities: CRITICALITIES.map((value) => ({ value, label: value.replace('_', ' ') })),
    dueSoonDays: equipment.PM_DUE_SOON_DAYS,
  });
});

router.get('/needs-attention', asyncRoute((req, res) => {
  const { value } = validate(req.query, { limit: { type: 'int', min: 1, max: 100, default: 10 } });
  const db = getDb();
  const rows = db.all(
    `SELECT e.id, e.asset_tag, e.name, e.status,
            (SELECT COUNT(*) FROM fault_reports f WHERE f.equipment_id = e.id
              AND f.status IN ('reported','assigned','acknowledged','under_inspection','under_repair','awaiting_parts')) AS open_faults,
            CASE WHEN e.next_maintenance_on IS NULL THEN 'not_scheduled'
                 WHEN date(e.next_maintenance_on) < date('now') THEN 'overdue'
                 WHEN julianday(e.next_maintenance_on) - julianday('now') <= 14 THEN 'due_soon'
                 ELSE 'up_to_date' END AS maintenance_state,
            CAST(julianday(e.next_maintenance_on) - julianday('now') AS INTEGER) AS days_until_pm
       FROM equipment e
      WHERE e.is_active = 1 AND e.status <> 'decommissioned'
        AND (e.status <> 'operational' OR (e.next_maintenance_on IS NOT NULL AND julianday(e.next_maintenance_on) - julianday('now') <= 14))
      ORDER BY open_faults DESC, julianday(e.next_maintenance_on)
      LIMIT ?`,
    [value.limit],
  );
  res.json({ items: rows.map(shape) });
}));

/** Printable QR label sheet (PNG data URLs, one per selected item). */
router.post('/labels', writeLimit(), asyncRoute(async (req, res) => {
  const { value } = validate(req.body, { ids: { type: 'idList', required: true, maxLen: 60 } });
  const db = getDb();
  const base = publicBaseFrom(req);
  const items = equipment.forLabels(db, value.ids);
  const labels = [];
  for (const item of items) {
    const url = equipmentUrl(base, item.assetTag);
    // A data URL rather than a Buffer: the label sheet must render straight from JSON, and a
    // base64 <img> prints identically without a binary download step.
    labels.push({ ...item, url, png: await qrDataUrl(url, { width: 260 }) });
  }
  res.json({ items: labels, note: 'Print at 100% scale on adhesive label stock. Laminate for clinical areas.' });
}));

/* -------------------------------------------------------------------- read -- */

router.get('/:id', asyncRoute((req, res) => {
  const { value } = validate(req.params, idParam);
  const db = getDb();
  const detail = equipment.equipmentDetail(db, value.id, req.user, { baseUrl: publicBaseFrom(req) });
  res.json(detail);
}));

router.get('/:id/qr.png', asyncRoute(async (req, res) => {
  const { value } = validate({ ...req.params, ...req.query }, { ...idParam, width: { type: 'int', min: 120, max: 1200, default: 320 } });
  const eq = equipment.resolveEquipment(getDb(), value.id);
  const png = await qrPng(equipmentUrl(publicBaseFrom(req), eq.assetTag), { width: value.width });
  res.set('Content-Type', 'image/png').set('Cache-Control', 'no-store').send(png);
}));

router.get('/:id/qr.svg', asyncRoute(async (req, res) => {
  const { value } = validate(req.params, idParam);
  const eq = equipment.resolveEquipment(getDb(), value.id);
  const svg = await qrSvg(equipmentUrl(publicBaseFrom(req), eq.assetTag), { width: 320 });
  res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'no-store').send(svg);
}));

router.get('/:id/history', asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.query }, {
    ...idParam, page: { type: 'int', min: 1, default: 1 }, perPage: { type: 'int', min: 5, max: 100, default: 25 },
    type: { type: 'enum', values: ['', 'all', 'fault', 'maintenance', 'repair', 'status'] },
  });
  res.json(equipment.equipmentHistory(getDb(), value.id, value, req.user));
}));

/* ------------------------------------------------------------------- write -- */

router.post('/', requireCap('equipment.create'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.body, common);
  const db = getDb();
  const created = equipment.createEquipment(db, value, req.user, req);
  res.status(201).json({
    equipment: created,
    qr: { url: equipmentUrl(publicBaseFrom(req), created.assetTag) },
  });
}));

router.patch('/:id', requireCap('equipment.update'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.params, idParam);
  const { value: body } = validate(req.body, { ...Object.fromEntries(Object.entries(common).map(([k, v]) => [k, { ...v, required: false }])), isActive: { type: 'bool' } }, { partial: true });
  res.json(equipment.updateEquipment(getDb(), Number(value.id) || value.id, body, req.user, req));
}));

router.post('/:id/status', requireCap('equipment.status.set'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, {
    ...idParam,
    status: { type: 'enum', required: true, values: EQUIPMENT_STATUSES },
    reason: { type: 'string', max: 400 },
  });
  const db = getDb();
  const eq = equipment.resolveEquipment(db, value.id);
  const result = db.tx(() => equipment.setEquipmentStatus(db, {
    equipmentId: eq.id, status: value.status, reason: value.reason, actor: req.user, req,
  }));
  res.json({ ...result, equipment: equipment.findEquipment(db, eq.id) });
}));

/** Photograph upload — multipart field `file`. */
router.post('/:id/image', requireCap('equipment.image'), writeLimit(), collectFiles('file', 1), asyncRoute((req, res) => {
  const { value } = validate(req.params, idParam);
  const file = req.files?.[0];
  if (!file) throw badRequest('Attach one image file in the “file” field', { fields: { file: ['Missing'] } });
  const out = equipment.setImage(getDb(), value.id, { buffer: file.buffer, filename: file.originalname }, req.user, req);
  res.status(201).json(out);
}));

router.delete('/:id/image', requireCap('equipment.image'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.params, idParam);
  res.json(equipment.clearImage(getDb(), value.id, req.user, req));
}));

router.post('/:id/deactivate', requireCap('equipment.deactivate'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, { ...idParam, reason: { type: 'string', max: 400 } });
  const db = getDb();
  const eq = equipment.resolveEquipment(db, value.id);
  const out = db.tx(() => {
    const updated = equipment.setEquipmentActive(db, eq.id, false, req.user, req);
    audit({ actor: req.user, action: 'equipment.deactivate_reason', entityType: 'equipment', entityId: eq.id,
      entityRef: eq.assetTag, summary: value.reason ? `Reason: ${value.reason}` : 'No reason recorded', req });
    return updated;
  });
  res.json(out);
}));

router.post('/:id/activate', requireCap('equipment.deactivate'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.params, idParam);
  const db = getDb();
  const eq = equipment.resolveEquipment(db, value.id);
  res.json(equipment.setEquipmentActive(db, eq.id, true, req.user, req));
}));

/** Destructive and rare: requires typing the asset tag, and refuses if history exists. */
router.delete('/:id', requireCap('equipment.delete'), writeLimit(), asyncRoute((req, res) => {
  const { value } = validate({ ...req.params, ...req.body }, {
    ...idParam, confirmTag: { type: 'string', max: 40 }, reason: { type: 'string', max: 400 },
  });
  res.json(equipment.deleteEquipment(getDb(), value.id, value, req.user, req));
}));

export { router as equipmentRoutes };
