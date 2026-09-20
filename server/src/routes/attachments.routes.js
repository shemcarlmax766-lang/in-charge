import { Router } from 'express';
import fs from 'node:fs';
import { getDb } from '../lib/db.js';
import { validate } from '../lib/validate.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { requireAuth, requireCap } from '../middleware/auth.js';
import { writeLimit } from '../middleware/security.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { shape } from '../lib/shape.js';
import { sniff, store, resolveStored, removeStored, sanitizeFilename, extensionOf, checksum } from '../lib/files.js';
import { audit } from '../lib/audit.js';
import { can } from '../auth/capabilities.js';

/**
 * Attachment storage + serving.
 *
 * Files are never exposed as a static tree: every read goes through this router, which
 * resolves the DB row, checks the caller against the *owning record*, then streams the
 * bytes with the stored (sniffed) MIME type.  That is what keeps a photograph of a fault on
 * a specific piece of equipment out of the hands of anyone who should not see it.
 */

const OWNER_TABLE = {
  equipment: 'equipment',
  fault_report: 'fault_reports',
  repair_record: 'repair_records',
  maintenance_record: 'maintenance_records',
};

/**
 * Validates and persists each multer file.  Called inside the caller's transaction, so an
 * upload never survives a rollback of the record it belongs to (the file write is
 * compensated by removeStored below on error).
 */
export function saveAttachmentFiles(db, { files, ownerType, ownerId, kind = 'photo', caption, actor, req, maxFiles }) {
  if (!OWNER_TABLE[ownerType]) throw badRequest(`Attachments cannot be attached to ${ownerType}`);
  const list = Array.isArray(files) ? files : files ? [files] : [];
  if (!list.length) return [];
  if (maxFiles && list.length > maxFiles) throw badRequest(`Attach at most ${maxFiles} files`);
  const written = [];
  try {
    const out = db.tx(() => {
      const rows = [];
      for (const file of list) {
        const detected = sniff(file.buffer, file.originalname, kind);
        const storedName = store(file.buffer, extensionOf(file.originalname));
        written.push(storedName);
        const { lastInsertRowid } = db.run(
          `INSERT INTO attachments (owner_type, owner_id, kind, stored_name, filename, mime_type, size_bytes, checksum, caption, uploaded_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [ownerType, ownerId, kind, storedName, sanitizeFilename(file.originalname), detected.mime,
            file.buffer.length, checksum(file.buffer), caption ?? null, actor.id, new Date().toISOString().slice(0, 19) + 'Z'],
        );
        rows.push(db.get('SELECT id, kind, filename, mime_type, size_bytes, caption, created_at FROM attachments WHERE id = ?', [lastInsertRowid]));
      }
      audit({ actor, action: 'attachment.create', entityType: ownerType, entityId: ownerId,
        summary: `${rows.length} file(s) attached (${rows.map((r) => r.filename).join(', ').slice(0, 160)})`, req });
      return rows.map((r) => ({ ...shape(r), sizeLabel: `${Math.max(1, Math.round(r.size_bytes / 1024))} KB`, url: `/api/v1/attachments/${r.id}` }));
    });
    return out;
  } catch (err) {
    for (const name of written) removeStored(name);
    throw err;
  }
}

/** Used when a record is deleted: the bytes go with the row. */
export function deleteAttachmentsFor(db, ownerType, ownerId) {
  const rows = db.all('SELECT id, stored_name FROM attachments WHERE owner_type = ? AND owner_id = ?', [ownerType, ownerId]);
  if (!rows.length) return 0;
  db.run('DELETE FROM attachments WHERE owner_type = ? AND owner_id = ?', [ownerType, ownerId]);
  for (const r of rows) removeStored(r.stored_name);
  return rows.length;
}

/** Owner-aware visibility. */
export function canViewAttachment(db, user, att) {
  if (!user) return false;
  if (can(user, 'attachment.view.any')) return true;
  switch (att.owner_type) {
    case 'equipment':
      // Inventory photographs are part of the equipment view reporters are entitled to.
      return can(user, 'equipment.view');
    case 'fault_report':
      return db.value(
        'SELECT COUNT(*) FROM fault_reports WHERE id = ? AND (reported_by = ? OR assigned_to = ?)',
        [att.owner_id, user.id, user.id],
      ) > 0;
    case 'repair_record':
      // The reporter may see the evidence for their own fault (verification needs eyes on it),
      // but not other people's paperwork.
      return db.value(
        `SELECT COUNT(*) FROM repair_records r JOIN fault_reports f ON f.id = r.fault_id
          WHERE r.id = ? AND (f.reported_by = ? OR f.assigned_to = ? OR r.technician_id = ?)`,
        [att.owner_id, user.id, user.id, user.id],
      ) > 0;
    case 'maintenance_record':
      return can(user, 'maintenance.view');
    default:
      return false;
  }
}

const router = Router();
router.use(requireAuth);

router.get('/:id', asyncRoute((req, res) => {
  const { value } = validate(req.params, { id: { type: 'int', required: true, min: 1 } });
  const db = getDb();
  const att = db.get('SELECT * FROM attachments WHERE id = ? AND is_deleted = 0', [value.id]);
  if (!att) throw notFound('Attachment not found');
  if (!canViewAttachment(db, req.user, att)) throw forbidden('You do not have access to this file');
  let abs;
  try {
    abs = resolveStored(att.stored_name);
  } catch {
    throw notFound('Attachment file is missing from storage');
  }
  if (!fs.existsSync(abs)) throw notFound('Attachment file is missing from storage');
  const stat = fs.statSync(abs);
  res.set({
    'Content-Type': att.mime_type,
    'Content-Length': String(stat.size),
    // Safe inline rendering of images/PDFs; never a download of an arbitrary name.
    'Content-Disposition': `inline; filename="attach-${att.id}${extensionOf(att.filename)}"`,
    'Cache-Control': 'private, max-age=300',
  });
  fs.createReadStream(abs).pipe(res);
}));

router.get('/:id/meta', asyncRoute((req, res) => {
  const { value } = validate(req.params, { id: { type: 'int', required: true, min: 1 } });
  const db = getDb();
  const att = db.get(
    `SELECT a.*, u.full_name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.id = ? AND a.is_deleted = 0`,
    [value.id],
  );
  if (!att) throw notFound('Attachment not found');
  if (!canViewAttachment(db, req.user, att)) throw forbidden('You do not have access to this file');
  res.json(shape(att));
}));

router.delete('/:id', writeLimit(), asyncRoute((req, res) => {
  const { value } = validate(req.params, { id: { type: 'int', required: true, min: 1 } });
  const db = getDb();
  const att = db.get('SELECT * FROM attachments WHERE id = ? AND is_deleted = 0', [value.id]);
  if (!att) throw notFound('Attachment not found');

  // Who may remove evidence: an administrator (correcting the record, always audited), or
  // the person who uploaded it while the owning record is still open for them to work on.
  const privileged = req.user.roleCode === 'admin';
  const uploader = att.uploaded_by === req.user.id;
  const stillWorking = (() => {
    if (!uploader) return false;
    if (att.owner_type === 'fault_report') {
      return db.value(
        `SELECT COUNT(*) FROM fault_reports WHERE id = ? AND status IN
           ('reported','assigned','acknowledged','under_inspection','under_repair','awaiting_parts')`,
        [att.owner_id],
      ) > 0;
    }
    if (att.owner_type === 'repair_record') {
      return db.value(
        `SELECT COUNT(*) FROM repair_records r JOIN fault_reports f ON f.id = r.fault_id
          WHERE r.id = ? AND f.status <> 'closed' AND f.assigned_to = ?`,
        [att.owner_id, req.user.id],
      ) > 0;
    }
    return false;
  })();

  if (!privileged && !stillWorking) {
    throw forbidden('You may only remove an attachment you uploaded, while the record it belongs to is still open for you.');
  }
  return db.tx(() => {
    db.run('UPDATE attachments SET is_deleted = 1 WHERE id = ?', [att.id]);
    removeStored(att.stored_name);
    audit({ actor: req.user, action: 'attachment.delete', entityType: att.owner_type, entityId: att.owner_id,
      summary: `Removed ${att.kind} “${att.filename}”${privileged && att.uploaded_by !== req.user.id ? ' (as administrator)' : ''}`,
      before: { kind: att.kind, filename: att.filename, mime: att.mime_type, size: att.size_bytes }, req });
    return res.json({ deleted: true, id: att.id });
  });
}));

export { router as attachmentsRoutes };
