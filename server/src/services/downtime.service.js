import { parseDate, minutesBetween } from '../lib/time.js';
import { UNAVAILABLE_STATUSES } from './equipment.status.js';

/**
 * Downtime accounting from `equipment_status_history`.
 *
 * Lives in its own module (rather than inside equipment.service) because both the
 * equipment profile and the risk model consume it, and a dependency cycle between two
 * services is how this kind of code eventually rots.
 */
export function computeDowntime(db, equipmentId, { days = 180 } = {}) {
  const rows = db.all(
    `SELECT id, to_status, changed_at FROM equipment_status_history
      WHERE equipment_id = ? ORDER BY datetime(changed_at), id`,
    [equipmentId],
  );
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 86_400_000);

  let totalMinutes = 0;
  let windowMinutes = 0;
  let longestMinutes = 0;
  let incidents = 0;
  let currentSince = null;

  for (let i = 0; i < rows.length; i += 1) {
    if (!UNAVAILABLE_STATUSES.includes(rows[i].to_status)) continue;
    const start = parseDate(rows[i].changed_at);
    const end = i + 1 < rows.length ? parseDate(rows[i + 1].changed_at) : null;
    if (!start) continue;
    const effectiveEnd = end ?? now;
    const mins = minutesBetween(start, effectiveEnd) ?? 0;
    totalMinutes += mins;
    incidents += 1;
    longestMinutes = Math.max(longestMinutes, mins);
    if (effectiveEnd >= windowStart) {
      const from = start < windowStart ? windowStart : start;
      windowMinutes += Math.max(0, minutesBetween(from, effectiveEnd) ?? 0);
    }
    if (!end) currentSince = rows[i].changed_at;
  }

  const windowMinutesPossible = days * 1440;
  return {
    minutes: totalMinutes,
    hours: Math.round((totalMinutes / 60) * 10) / 10,
    days: Math.round((totalMinutes / 1440) * 10) / 10,
    minutesInWindow: windowMinutes,
    windowDays: days,
    incidents,
    longestIncidentMinutes: longestMinutes,
    unavailableSince: currentSince,
    currentlyDown: !!currentSince,
    availabilityPercent: rows.length
      ? Math.round((1 - Math.min(1, windowMinutes / windowMinutesPossible)) * 1000) / 10
      : 100,
  };
}

/** Fleet-wide downtime, used by the reports module (same rule, batched). */
export function computeDowntimeForMany(db, equipmentIds, { days = 180 } = {}) {
  const out = new Map();
  for (const id of equipmentIds) out.set(id, computeDowntime(db, id, { days }));
  return out;
}
