import { getDb } from '../lib/db.js';
import { config } from '../config/index.js';
import { shape } from '../lib/shape.js';
import { nowIso } from '../lib/time.js';
import { notFound } from '../lib/errors.js';

/**
 * In-app notification fan-out with a real delivery ledger.
 *
 * `notification_deliveries` records one row per (notification, channel).  In-app is live;
 * email/SMS/push are registered but disabled, and their rows are written as `skipped`
 * with the reason.  Turning email on later means implementing `deliverEmail()` and
 * setting ENABLE_EMAIL_NOTIFY=1 — no schema change, no new call sites, and until then the
 * history still shows exactly what the department was told and what it was not.
 */

const CHANNELS = {
  in_app: { enabled: true },
  email: { enabled: config.notify.email, target: (u) => u.email },
  sms: { enabled: config.notify.sms, target: (u) => u.phone },
  push: { enabled: config.notify.push, target: () => null },
};

function recordDelivery(db, notificationId, channel, target, status, detail) {
  db.run(
    `INSERT INTO notification_deliveries (notification_id, channel, target, status, detail, created_at)
     VALUES (?,?,?,?,?,?)`,
    [notificationId, channel, target ?? null, status, detail ?? null, nowIso()],
  );
}

/**
 * Creates one notification for one user.  Returns the row id.
 * Callers inside a service transaction join it to the same commit.
 */
export function notifyUser(db, { userId, type, title, body = null, link = null, severity = 'info', entityType = null, entityId = null }) {
  if (!userId) return null;
  const recipient = db.get('SELECT id, email, phone, is_active FROM users WHERE id = ?', [userId]);
  if (!recipient || !recipient.is_active) return null;

  const { lastInsertRowid } = db.run(
    `INSERT INTO notifications (user_id, type, title, body, link, severity, entity_type, entity_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [userId, type, title, body, link, severity, entityType, entityId, nowIso()],
  );
  const id = lastInsertRowid;

  for (const [channel, cfg] of Object.entries(CHANNELS)) {
    if (channel === 'in_app') {
      recordDelivery(db, id, 'in_app', `user:${userId}`, 'sent', 'Delivered to the in-app centre');
      continue;
    }
    const target = cfg.target ? cfg.target(recipient) : null;
    if (!cfg.enabled) {
      recordDelivery(db, id, channel, target, 'skipped', 'Channel not enabled on this deployment');
    } else if (!target) {
      recordDelivery(db, id, channel, null, 'skipped', 'Recipient has no address on file');
    } else {
      // The transport itself is intentionally not implemented here; see docs/INTEGRATIONS.md.
      recordDelivery(db, id, channel, target, 'pending', 'Queued — transport not configured');
    }
  }
  return id;
}

const dedupe = (ids) => [...new Set(ids.filter(Boolean))];

export function notifyMany(db, userIds, payload) {
  return dedupe(userIds).map((userId) => notifyUser(db, { ...payload, userId })).filter(Boolean);
}

export function usersWithRole(db, ...roles) {
  if (!roles.length) return [];
  const rows = db.all(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.code IN (${roles.map(() => '?').join(',')}) AND u.is_active = 1`,
    roles,
  );
  return rows.map((r) => r.id);
}

/** Recipients for an equipment-driven event: its assigned technician plus every admin. */
export function equipmentWatchers(db, equipmentId, { includeCustodianTech = true } = {}) {
  const eq = db.get('SELECT responsible_technician_id FROM equipment WHERE id = ?', [equipmentId]);
  const ids = [...usersWithRole(db, 'admin')];
  if (includeCustodianTech && eq?.responsible_technician_id) ids.push(eq.responsible_technician_id);
  return dedupe(ids);
}

/* ------------------------------------------------------------------ read side */

export function listMine(db, user, { unreadOnly = false, limit = 50 } = {}) {
  const rows = db.all(
    `SELECT id, type, title, body, link, severity, entity_type, entity_id, is_read, created_at, read_at
       FROM notifications
      WHERE user_id = ? ${unreadOnly ? 'AND is_read = 0' : ''}
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?`,
    [user.id, Math.min(200, Math.max(1, limit))],
  );
  return rows.map((r) => shape({ ...r, is_read: !!r.is_read, unread: !r.is_read }));
}

export const unreadCount = (db, user) =>
  db.value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0', [user.id]) ?? 0;

export function markRead(db, user, ids) {
  if (ids?.length) {
    db.run(
      `UPDATE notifications SET is_read = 1, read_at = ?
        WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      [nowIso(), user.id, ...ids],
    );
  } else {
    db.run('UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0', [nowIso(), user.id]);
  }
  return unreadCount(db, user);
}

export function remove(db, user, id) {
  const row = db.get('SELECT id FROM notifications WHERE id = ? AND user_id = ?', [id, user.id]);
  if (!row) throw notFound('Notification not found');
  db.run('DELETE FROM notification_deliveries WHERE notification_id = ?', [id]);
  db.run('DELETE FROM notifications WHERE id = ?', [id]);
}

/**
 * Reminder sweep — the piece that makes "notifications for overdue and upcoming
 * maintenance" real rather than aspirational.  Run it from cron/systemd (see
 * docs/OPERATIONS.md) or `POST /api/v1/maintenance/reminders`; it is idempotent, so a
 * twice-run schedule cannot spam the department: an item that already received a reminder of
 * that kind within the last 7 days is skipped.
 */
export function runMaintenanceReminders(db, { dueSoonDays = 14, actor = null, req = null } = {}) {
  const due = db.all(
    `SELECT e.id, e.asset_tag, e.name, e.next_maintenance_on, e.responsible_technician_id,
            CAST(julianday(e.next_maintenance_on) - julianday('now') AS INTEGER) AS days_until
       FROM equipment e
      WHERE e.is_active = 1 AND e.status <> 'decommissioned' AND e.next_maintenance_on IS NOT NULL
        AND julianday(e.next_maintenance_on) - julianday('now') <= ?
      ORDER BY julianday(e.next_maintenance_on)`,
    [dueSoonDays],
  );
  let sent = 0;
  let skipped = 0;
  for (const e of due) {
    const overdue = e.days_until < 0;
    const type = overdue ? 'maintenance_overdue' : 'maintenance_due';
    const recentlySent = db.value(
      `SELECT COUNT(*) FROM notifications
        WHERE entity_type = 'equipment' AND entity_id = ? AND type = ?
          AND datetime(created_at) > datetime('now', '-7 days')`,
      [e.id, type],
    );
    if (recentlySent > 0) { skipped += 1; continue; }
    const recipients = new Set([
      e.responsible_technician_id,
      ...db.all(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin' AND u.is_active = 1`).map((r) => r.id),
      ...(actor ? [actor.id] : []),
    ].filter(Boolean));
    notifyMany(db, [...recipients], {
      type,
      severity: overdue ? 'warning' : 'info',
      title: overdue ? `Maintenance overdue: ${e.asset_tag}` : `Maintenance due ${e.days_until === 0 ? 'today' : `in ${e.days_until} day(s)`}: ${e.asset_tag}`,
      body: `${e.name} — scheduled for ${e.next_maintenance_on}${overdue ? ` and now ${Math.abs(e.days_until)} day(s) past due.` : '. Please book the visit.'}`,
      link: `/equipment/${e.id}`, entityType: 'equipment', entityId: e.id,
    });
    sent += 1;
  }
  if (actor) {
    db.run('INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, summary, created_at) VALUES (?,?,?,?,?,?,?)',
      [actor.id, actor.roleCode, 'notification.maintenance_reminders', 'equipment', null,
        `${sent} reminder(s) sent, ${skipped} already recent`, new Date().toISOString().slice(0, 19) + 'Z']);
  }
  return shape({ considered: due.length, sent, skipped, dueSoonDays });
}

/** Housekeeping: 90 days of in-app history is plenty for a teaching department. */
export function prune(db, days = 90) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const { changes } = db.run(
    'DELETE FROM notifications WHERE is_read = 1 AND created_at < ?',
    [cutoff],
  );
  return changes;
}

export const deliveryLedger = (db, notificationId) =>
  db.all(
    'SELECT channel, target, status, detail, created_at FROM notification_deliveries WHERE notification_id = ? ORDER BY id',
    [notificationId],
  );
