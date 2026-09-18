import { getDb } from '../lib/db.js';
import { shape } from '../lib/shape.js';
import { todayDateOnly, toDateOnly, addDays } from '../lib/time.js';
import { EQUIPMENT_STATUSES, STATUS_META, OPEN_FAULT_STATUSES } from './equipment.status.js';
import { compliance } from './maintenance.service.js';
import { fleetRisk } from './risk.service.js';
import { can } from '../auth/capabilities.js';

/**
 * Dashboard aggregates (§8 of the brief).  Everything here is a read-only projection of
 * the same rows the workflow writes — no parallel counters that could drift out of step.
 * Role matters: a reporter gets *their* numbers, not the department's.
 */

const OPEN = `(${OPEN_FAULT_STATUSES.map(() => '?').join(',')})`;

/** 60-second memo so a busy dashboard refresh cannot stampede the risk model. */
const cache = new Map();
const memo = (key, ttlMs, fn) => {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = fn();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
};
export const clearDashboardCache = () => cache.clear();

export function kpis(db, user) {
  const eq = db.get(
    `SELECT
        COUNT(*) AS total_all,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN is_active = 1 AND status <> 'decommissioned' THEN 1 ELSE 0 END) AS live,
        SUM(CASE WHEN is_active = 1 AND status = 'operational' THEN 1 ELSE 0 END) AS operational,
        SUM(CASE WHEN is_active = 1 AND status = 'reported_fault' THEN 1 ELSE 0 END) AS reported_fault,
        SUM(CASE WHEN is_active = 1 AND status = 'under_inspection' THEN 1 ELSE 0 END) AS under_inspection,
        SUM(CASE WHEN is_active = 1 AND status IN ('under_repair','awaiting_parts') THEN 1 ELSE 0 END) AS under_repair,
        SUM(CASE WHEN is_active = 1 AND status = 'awaiting_parts' THEN 1 ELSE 0 END) AS awaiting_parts_count,
        SUM(CASE WHEN is_active = 1 AND status = 'out_of_service' THEN 1 ELSE 0 END) AS out_of_service,
        SUM(CASE WHEN is_active = 1 AND status = 'decommissioned' THEN 1 ELSE 0 END) AS decommissioned,
        SUM(CASE WHEN is_active = 1 AND status <> 'decommissioned' AND next_maintenance_on IS NOT NULL
                  AND date(next_maintenance_on) < date('now') THEN 1 ELSE 0 END) AS pm_overdue,
        SUM(CASE WHEN is_active = 1 AND status <> 'decommissioned' AND date(next_maintenance_on) >= date('now')
                  AND julianday(next_maintenance_on) - julianday('now') <= 14 THEN 1 ELSE 0 END) AS pm_due_soon,
        SUM(CASE WHEN is_active = 1 AND status <> 'decommissioned' AND next_maintenance_on IS NULL THEN 1 ELSE 0 END) AS pm_unscheduled
     FROM equipment`,
  ) ?? {};

  // A single expansion of the open-status list, inside a flag column, keeps the parameter
  // list and the placeholder count trivially verifiable.
  const scoped = can(user, 'fault.view.any') ? '' : 'AND f.reported_by = ?';
  const faults = db.get(
    `SELECT
        COUNT(*) AS total,
        SUM(is_open) AS open_total,
        SUM(CASE WHEN is_open = 1 AND severity = 'critical' THEN 1 ELSE 0 END) AS critical_open,
        SUM(CASE WHEN is_open = 1 AND severity = 'high' THEN 1 ELSE 0 END) AS high_open,
        SUM(CASE WHEN is_open = 1 AND assigned_to IS NULL THEN 1 ELSE 0 END) AS unassigned,
        SUM(CASE WHEN is_open = 1 AND overdue = 1 THEN 1 ELSE 0 END) AS sla_breached,
        SUM(recent30) AS last_30_days,
        SUM(today) AS today,
        SUM(diagnosis_confirmed) AS diagnosed
     FROM (
       SELECT f.severity, f.assigned_to, f.diagnosis_confirmed,
              CASE WHEN f.status IN ${OPEN} THEN 1 ELSE 0 END AS is_open,
              CASE WHEN datetime(f.due_at) < datetime('now') THEN 1 ELSE 0 END AS overdue,
              CASE WHEN date(f.created_at) >= date('now','-30 days') THEN 1 ELSE 0 END AS recent30,
              CASE WHEN date(f.created_at) = date('now') THEN 1 ELSE 0 END AS today
         FROM fault_reports f WHERE 1 = 1 ${scoped}
     ) x`,
    [...OPEN_FAULT_STATUSES, ...(scoped ? [user.id] : [])],
  ) ?? {};

  const speed = db.get(
    `SELECT
        ROUND(AVG((julianday(f.repaired_at) - julianday(f.created_at)) * 24), 1) AS avg_repair_hours,
        ROUND(AVG((julianday(f.closed_at) - julianday(f.created_at)) * 24), 1) AS avg_close_hours,
        ROUND(AVG((julianday(f.assigned_at) - julianday(f.created_at)) * 24), 1) AS avg_assign_hours,
        COUNT(*) AS resolved
     FROM fault_reports f
     WHERE f.repaired_at IS NOT NULL AND date(f.repaired_at) >= date('now','-180 days')`,
  ) ?? {};

  const cost = db.get(
    `SELECT COALESCE(SUM(total_cost),0) AS ytd, COUNT(*) AS repairs, COALESCE(MAX(currency),'USD') AS currency
       FROM repair_records WHERE strftime('%Y', date_repaired) = strftime('%Y','now')`,
  ) ?? {};

  const live = eq.live ?? 0;
  return shape({
    total_equipment: eq.total ?? 0,
    total_including_decommissioned: eq.total_all ?? 0,
    operational: eq.operational ?? 0,
    // "Faulty" = a user says it is broken, whether or not the workshop has picked it up.
    faulty: (eq.reported_fault ?? 0) + (eq.under_inspection ?? 0),
    reported_fault: eq.reported_fault ?? 0,
    under_inspection: eq.under_inspection ?? 0,
    under_repair: eq.under_repair ?? 0,
    awaiting_parts_count: eq.awaiting_parts_count ?? 0,
    out_of_service: eq.out_of_service ?? 0,
    decommissioned: eq.decommissioned ?? 0,
    maintenance_overdue: eq.pm_overdue ?? 0,
    maintenance_due_soon: eq.pm_due_soon ?? 0,
    maintenance_unscheduled: eq.pm_unscheduled ?? 0,
    open_faults: faults.open_total ?? 0,
    critical_faults: faults.critical_open ?? 0,
    high_faults: faults.high_open ?? 0,
    unassigned_faults: faults.unassigned ?? 0,
    sla_breached_faults: faults.sla_breached ?? 0,
    faults_today: faults.today ?? 0,
    faults_last_30_days: faults.last_30_days ?? 0,
    faults_total: faults.total ?? 0,
    diagnosed_faults: faults.diagnosed ?? 0,
    averageRepairHours: speed.avg_repair_hours ?? null,
    averageCloseHours: speed.avg_close_hours ?? null,
    averageAssignmentHours: speed.avg_assign_hours ?? null,
    resolvedIn180Days: speed.resolved ?? 0,
    repairCostYtd: cost.ytd ?? 0,
    repairCountYtd: cost.repairs ?? 0,
    currency: cost.currency ?? 'USD',
    fleetAvailabilityPercent: live > 0 ? Math.round(((eq.operational ?? 0) / live) * 1000) / 10 : 100,
  });
}

export function equipmentByStatus(db, { includeDecommissioned = true } = {}) {
  const rows = db.all(
    `SELECT status, COUNT(*) AS count FROM equipment
      ${includeDecommissioned ? '' : "WHERE status <> 'decommissioned'"}
      GROUP BY status`,
  );
  const map = new Map(rows.map((r) => [r.status, r.count]));
  return EQUIPMENT_STATUSES
    .map((status) => ({
      status,
      label: STATUS_META[status].label,
      tone: STATUS_META[status].tone,
      count: map.get(status) ?? 0,
    }))
    .filter((r, i) => includeDecommissioned || r.count > 0 || i < 5);
}

export function faultsByCategory(db, { days = 365, user = null } = {}) {
  const scoped = user && !can(user, 'fault.view.any') ? 'AND f.reported_by = ?' : '';
  const params = [toDateOnly(addDays(todayDateOnly(), -days))];
  if (scoped) params.push(user.id);
  return db.all(
    `SELECT c.id, c.code, c.name AS label, COUNT(f.id) AS count,
            SUM(CASE WHEN f.severity = 'critical' THEN 1 ELSE 0 END) AS critical_count
       FROM fault_categories c
       LEFT JOIN fault_reports f ON f.category_id = c.id AND date(f.created_at) >= date(?)
      WHERE c.is_active = 1 ${scoped}
      GROUP BY c.id ORDER BY count DESC, c.name`,
    params,
  ).map(shape);
}

export function faultsByMonth(db, { months = 12, user = null } = {}) {
  const scoped = user && !can(user, 'fault.view.any') ? 'AND f.reported_by = ?' : '';
  const params = [`-${months} months`];
  if (scoped) params.push(user.id);
  const rows = db.all(
    `SELECT strftime('%Y-%m', f.created_at) AS month,
            COUNT(*) AS reported,
            SUM(CASE WHEN f.severity = 'critical' THEN 1 ELSE 0 END) AS critical,
            SUM(CASE WHEN f.severity = 'high' THEN 1 ELSE 0 END) AS high,
            SUM(CASE WHEN f.status IN ('repaired','verified','closed') THEN 1 ELSE 0 END) AS resolved
       FROM fault_reports f
      WHERE date(f.created_at) >= date('now', ?) ${scoped}
      GROUP BY month ORDER BY month`,
    params,
  );
  // Fill gaps so the chart's x-axis is continuous (a missing month must read as 0, not as
  // "no data", otherwise trends look artificially smooth).
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const out = [];
  const base = new Date();
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = byMonth.get(key);
    out.push(shape({ month: key, reported: row?.reported ?? 0, critical: row?.critical ?? 0, high: row?.high ?? 0, resolved: row?.resolved ?? 0 }));
  }
  return out;
}

export function topFailingEquipment(db, { limit = 8, days = 730 } = {}) {
  const rows = db.all(
    `SELECT e.id, e.asset_tag, e.name, e.status, e.criticality,
            cat.name AS category_name, l.name AS location_name,
            COUNT(f.id) AS fault_count,
            SUM(CASE WHEN f.severity = 'critical' THEN 1 ELSE 0 END) AS critical_count,
            SUM(CASE WHEN f.status IN ${OPEN} THEN 1 ELSE 0 END) AS open_count,
            MAX(datetime(f.created_at)) AS last_fault_at,
            CAST(julianday('now') - julianday(MAX(f.created_at)) AS INTEGER) AS days_since_fault
       FROM equipment e
       LEFT JOIN fault_reports f ON f.equipment_id = e.id AND date(f.created_at) >= date('now', ?)
       LEFT JOIN equipment_categories cat ON cat.id = e.category_id
       LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.is_active = 1
      GROUP BY e.id
     HAVING fault_count > 0
      ORDER BY fault_count DESC, critical_count DESC, days_since_fault ASC
      LIMIT ?`,
    [...OPEN_FAULT_STATUSES, `-${days} days`, limit],
  );
  return rows.map(shape);
}

export function technicianWorkload(db) {
  return db.all(
    `SELECT u.id, u.full_name, u.job_title,
            SUM(CASE WHEN f.status IN ${OPEN} THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN f.status IN ${OPEN} AND f.severity = 'critical' THEN 1 ELSE 0 END) AS critical_count,
            SUM(CASE WHEN f.status IN ('repaired','verified','closed') THEN 1 ELSE 0 END) AS done_90d,
            ROUND(AVG(CASE WHEN f.repaired_at IS NOT NULL THEN (julianday(f.repaired_at) - julianday(f.created_at)) * 24 END), 1) AS avg_repair_hours
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN fault_reports f ON f.assigned_to = u.id AND date(COALESCE(f.created_at,'now')) >= date('now','-90 days')
      WHERE r.code = 'technician' AND u.is_active = 1
      GROUP BY u.id ORDER BY open_count DESC, u.full_name`,
    [...OPEN_FAULT_STATUSES, ...OPEN_FAULT_STATUSES],
  ).map(shape);
}

export function recentActivity(db, { limit = 12 } = {}) {
  return db.all(
    `SELECT h.id, h.fault_id, f.reference, h.from_status, h.to_status, h.comment, h.auto_action,
            h.changed_at, u.full_name AS actor_name, e.asset_tag, e.name AS equipment_name
       FROM fault_status_history h
       JOIN fault_reports f ON f.id = h.fault_id
       JOIN equipment e ON e.id = f.equipment_id
       LEFT JOIN users u ON u.id = h.changed_by
      ORDER BY datetime(h.changed_at) DESC, h.id DESC LIMIT ?`,
    [limit],
  ).map(shape);
}

export function recentMaintenance(db, { limit = 8 } = {}) {
  return db.all(
    `SELECT m.id, m.reference, m.performed_on, m.condition_found, m.days_late,
            e.asset_tag, e.name AS equipment_name, u.full_name AS performed_by_name, s.title AS schedule_title
       FROM maintenance_records m
       JOIN equipment e ON e.id = m.equipment_id
       JOIN users u ON u.id = m.performed_by
       LEFT JOIN maintenance_schedules s ON s.id = m.schedule_id
      ORDER BY m.performed_on DESC, m.id DESC LIMIT ?`,
    [limit],
  ).map(shape);
}

/** Everything one screen needs, in one round trip. */
export function dashboard(db, user, { chartMonths = 12 } = {}) {
  const isPrivate = !can(user, 'fault.view.any');
  const key = `risk:${todayDateOnly()}`;
  const risk = memo(key, 60_000, () => {
    const r = fleetRisk(db, { limit: 200, includeUnscheduled: true });
    return { distribution: r.distribution, top: r.items.slice(0, 6), modelVersion: r.modelVersion, disclaimer: r.disclaimer };
  });

  const myWork = isPrivate
    ? db.get(
        `SELECT COUNT(*) AS mine,
                SUM(CASE WHEN status IN ${OPEN} THEN 1 ELSE 0 END) AS mine_open,
                SUM(CASE WHEN status IN ('repaired','verified') THEN 1 ELSE 0 END) AS awaiting_my_verification
           FROM fault_reports WHERE reported_by = ?`,
        [...OPEN_FAULT_STATUSES, user.id],
      )
    : null;

  return shape({
    generatedAt: new Date().toISOString(),
    scope: isPrivate ? 'personal' : 'department',
    kpis: kpis(db, user),
    equipmentByStatus: equipmentByStatus(db),
    faultsByCategory: faultsByCategory(db, { user }),
    faultsByMonth: faultsByMonth(db, { months: chartMonths, user }),
    topFailingEquipment: topFailingEquipment(db),
    maintenanceCompliance: compliance(db, { days: 180 }),
    technicianWorkload: isPrivate ? [] : technicianWorkload(db),
    recentActivity: recentActivity(db),
    recentMaintenance: recentMaintenance(db),
    risk,
    myWork: myWork ? shape(myWork) : null,
  });
}
