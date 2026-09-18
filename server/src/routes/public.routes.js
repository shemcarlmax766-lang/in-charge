import { Router } from 'express';
import { getDb } from '../lib/db.js';
import { validate } from '../lib/validate.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { notFound } from '../lib/errors.js';
import { shape } from '../lib/shape.js';
import { statusLabel } from '../services/equipment.status.js';
import { settingsValue } from '../services/fault.service.js';

/**
 * Unauthenticated surface for the QR code on the equipment itself.
 *
 * Why public at all? A label stuck on a microscope has to be useful to the student who
 * finds it faulty at 4 pm — before they can reach an account. So the scan target exposes a
 * deliberately narrow read-only view: enough to identify the item and show whether the
 * department already knows about the problem. Serial numbers, warranty terms, costs, notes
 * and internal history stay behind authentication. Reporting still requires sign-in,
 * because accountability for who raised a fault is the whole point of the system.
 */
const router = Router();

router.get('/config', (req, res) => {
  const db = getDb();
  res.json({
    application: 'Biomedical Equipment Maintenance & Fault Reporting System',
    department: settingsValue(db, 'department_name', 'Biomedical Engineering'),
    institution: settingsValue(db, 'institution_name', ''),
    // Present while the fictional demo fleet is installed, so the UI can label it honestly.
    demoData: settingsValue(db, 'demo_data_installed', '0') === '1' || settingsValue(db, 'demo_data_installed', false) === true,
    signInSection: '/login',
    reportRequiresAccount: true,
  });
});

router.get('/equipment/:tag', asyncRoute((req, res) => {
  const { value } = validate(req.params, { tag: { type: 'string', required: true, min: 3, max: 40 } });
  const db = getDb();
  const row = db.get(
    `SELECT e.id, e.asset_tag, e.name, e.status, e.criticality, e.is_active,
            cat.name AS category_name, e.manufacturer, e.model,
            l.name AS location_name, l.building, l.room,
            att.id AS image_attachment_id,
            (SELECT COUNT(*) FROM fault_reports f WHERE f.equipment_id = e.id
               AND f.status IN ('reported','assigned','acknowledged','under_inspection','under_repair','awaiting_parts')) AS open_faults,
            (SELECT f.reference FROM fault_reports f WHERE f.equipment_id = e.id
               AND f.status IN ('reported','assigned','acknowledged','under_inspection','under_repair','awaiting_parts')
               ORDER BY datetime(f.created_at) DESC LIMIT 1) AS open_fault_reference,
            (SELECT MAX(datetime(f.repaired_at)) FROM fault_reports f WHERE f.equipment_id = e.id) AS last_repaired_at
       FROM equipment e
       LEFT JOIN equipment_categories cat ON cat.id = e.category_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN attachments att ON att.owner_type = 'equipment' AND att.owner_id = e.id AND att.kind = 'photo' AND att.is_deleted = 0
      WHERE e.asset_tag = ? COLLATE NOCASE`,
    [value.tag],
  );
  if (!row || !row.is_active) throw notFound(`No active equipment record for “${value.tag}”`);

  return res.json(shape({
    asset_tag: row.asset_tag,
    name: row.name,
    category_name: row.category_name,
    manufacturer: row.manufacturer,
    model: row.model,
    location_label: [row.location_name, row.room && `Room ${row.room}`, row.building].filter(Boolean).join(' · '),
    status: row.status,
    status_label: statusLabel(row.status),
    is_available: row.status === 'operational',
    criticality: row.criticality,
    open_faults: row.open_faults,
    open_fault_reference: row.open_fault_reference,
    last_repaired_at: row.last_repaired_at,
    image_attachment_id: row.image_attachment_id,
    publicNotice: 'This page shows what the department has recorded about this item. It does not certify that the equipment is safe to use.',
    report: {
      requiresAccount: true,
      equipmentId: row.id,
      categories: db.all('SELECT id, code, name FROM fault_categories WHERE is_active = 1 ORDER BY name'),
    },
  }));
}));

/** Public view of the photo, so a QR landing page can show the device. */
router.get('/equipment/:tag/photo', asyncRoute(async (req, res) => {
  const { value } = validate(req.params, { tag: { type: 'string', required: true, min: 3, max: 40 } });
  const db = getDb();
  const att = db.get(
    `SELECT a.stored_name, a.mime_type FROM attachments a JOIN equipment e ON e.id = a.owner_id
      WHERE e.asset_tag = ? COLLATE NOCASE AND a.owner_type = 'equipment' AND a.kind = 'photo' AND a.is_deleted = 0
      ORDER BY a.id DESC LIMIT 1`,
    [value.tag],
  );
  if (!att) throw notFound('No photograph on file');
  const { resolveStored } = await import('../lib/files.js');
  const fs = await import('node:fs');
  const abs = resolveStored(att.stored_name);
  if (!fs.existsSync(abs)) throw notFound('Photograph missing from storage');
  res.set('Content-Type', att.mime_type).set('Cache-Control', 'public, max-age=300').send(fs.readFileSync(abs));
}));

export { router as publicRoutes };
