import { getDb } from '../lib/db.js';
import { shape } from '../lib/shape.js';
import { nowIso, todayDateOnly, diffDays, diffExactDays, toDateOnly } from '../lib/time.js';
import { OPEN_FAULT_STATUSES, statusLabel } from './equipment.status.js';
import { computeDowntime } from './downtime.service.js';

/**
 * Maintenance-risk scoring — §9 of the brief.
 *
 * This is a **transparent, additive, rule-based decision-support indicator for qualified
 * staff**.  It is deliberately *not* machine learning: a small rubric whose every point can
 * be traced to a row in the database is more useful to a biomedical department than a model
 * whose output nobody can interrogate, and it is auditable when the department head asks
 * "why was this machine's service interval halved?".
 *
 * It does NOT:
 *   • assess patient safety or clinical risk;
 *   • diagnose an equipment fault;
 *   • authorise or forbid any repair or return-to-service decision.
 * Those remain human, professional, documented judgements.
 *
 * Score = Σ factor points (0–135) normalised to 0–100.  Every factor publishes its rule,
 * its ceiling and the exact inputs that fired, which the UI renders next to the score.
 */

export const RISK_MODEL = {
  version: 'dept-rule-based/1.0',
  maxRaw: 135,
  bands: [
    { level: 'low', label: 'Low Risk', min: 0, max: 29, tone: 'ok',
      advice: 'Keep the current preventive-maintenance interval.' },
    { level: 'moderate', label: 'Moderate Risk', tone: 'warn', min: 30, max: 59,
      advice: 'Review the PM interval and confirm consumables/spares are available.' },
    { level: 'high', label: 'High Risk', tone: 'bad', min: 60, max: 100,
      advice: 'Shorten the PM interval, plan an overhaul or replacement, and consider a backup unit.' },
  ],
  factors: [
    { key: 'failureFrequency', label: 'Failure frequency', maxPoints: 30,
      basis: 'Fault reports on this item in the last 365 days.' },
    { key: 'severityHistory', label: 'Severity of past faults', maxPoints: 25,
      basis: 'Worst severity recorded, plus any critical fault in the last 180 days.' },
    { key: 'maintenanceLag', label: 'Preventive maintenance lag', maxPoints: 25,
      basis: 'Time since the last PM measured against the configured interval.' },
    { key: 'currentExposure', label: 'Current fault exposure', maxPoints: 20,
      basis: 'Open fault reports right now, by severity and stage.' },
    { key: 'ageAndWarranty', label: 'Age and warranty', maxPoints: 15,
      basis: 'Years in service since acquisition, and warranty status.' },
    { key: 'repairRecency', label: 'Recent repair activity', maxPoints: 10,
      basis: 'Time since the last completed repair (repeats soon after a fix imply an unresolved cause).' },
    { key: 'downtimeShare', label: 'Downtime share', maxPoints: 10,
      basis: 'Proportion of the last 180 days the item was not usable.' },
  ],
  rubric: {
    failureFrequency: { 0: 0, 1: 8, 2: 14, 3: 20, 4: 26, more: 30 },
    severityHistory: { low: 2, medium: 6, high: 14, critical: 25, recentCriticalBonus: 5 },
    // Overdue at all costs 8 points; then up to 12 more in proportion to how far past the
    // interval the item is (a full interval late ⇒ the ceiling).  Proportional, so a device
    // 5 days late on a yearly PM is not scored like one 6 months late.
    maintenanceLag: { overdueBase: 8, overdueProportionalMax: 12, unscheduledPenalty: 10 },
    currentExposure: { low: 4, medium: 8, high: 14, critical: 20, awaitingPartsBonus: 4, outOfServiceBonus: 8, cap: 20 },
    ageAndWarranty: { years: [[10, 15], [7, 11], [4, 6]], base: 2, unknown: 5, expiredWarrantyBonus: 3, cap: 15 },
    repairRecency: { days: [[30, 10], [90, 7], [180, 4], [365, 2]], older: 0 },
    downtimeShare: { thresholds: [[10, 10], [5, 7], [2, 4]], below: 0 },
  },
  escalation: {
    rule: 'life_support_or_high_criticality + (PM overdue OR an open critical fault) ⇒ at least High',
    reason: 'A device whose failure interrupts teaching or patient-adjacent use gets no benefit of the doubt.',
  },
  disclaimer:
    'Decision-support indicator only. It ranks maintenance attention using this department’s own ' +
    'history; it does not certify that equipment is safe, does not diagnose faults, and does not ' +
    'replace inspection by a qualified biomedical engineer.',
};

const bandFor = (score) => RISK_MODEL.bands.find((b) => score >= b.min && score <= b.max) ?? RISK_MODEL.bands[0];

/** One function per factor so each rule can be unit-tested in isolation with fake history. */
function factorFailureFrequency(count, { windowDays }) {
  const r = RISK_MODEL.rubric.failureFrequency;
  const points = count >= 5 ? r.more : r[count] ?? 0;
  return {
    key: 'failureFrequency',
    points,
    maxPoints: RISK_MODEL.factors[0].maxPoints,
    inputs: { faultsInWindow: count, windowDays },
    contributing: count
      ? [`${count} fault report(s) in the last ${Math.round(windowDays / 30)} months`]
      : [`No fault reports in the last ${Math.round(windowDays / 30)} months`],
    advice: count >= 4 ? 'Repeated failures: review root causes and the PM scope, not just the fixes.' : null,
  };
}

function factorSeverity({ maxSeverity, recentCritical }, windowDays = 180) {
  const r = RISK_MODEL.rubric.severityHistory;
  let points = maxSeverity ? r[maxSeverity] ?? 0 : 0;
  const contributing = [];
  if (maxSeverity) contributing.push(`Worst severity on record: ${maxSeverity.toUpperCase()}`);
  else contributing.push('No severity history on this item');
  if (recentCritical) {
    points = Math.min(r.critical, points + r.recentCriticalBonus);
    contributing.push(`Critical fault within the last ${Math.round(windowDays / 30)} months (+${r.recentCriticalBonus})`);
  }
  return {
    key: 'severityHistory', points, maxPoints: RISK_MODEL.factors[1].maxPoints,
    inputs: { maxSeverity, recentCritical }, contributing,
    advice: maxSeverity === 'critical' ? 'Retain critical incidents for trend review even after closure.' : null,
  };
}

function factorMaintenanceLag({ lastMaintenanceOn, intervalDays, nextMaintenanceOn, pmRecordCount }) {
  const r = RISK_MODEL.rubric.maintenanceLag;
  const contributing = [];
  let points = 0;
  const today = todayDateOnly();

  if (!nextMaintenanceOn) {
    points = r.unscheduledPenalty;
    contributing.push('No preventive-maintenance schedule is configured (unknown state is not a good state)');
  } else {
    const daysUntil = diffDays(today, nextMaintenanceOn);
    if (daysUntil >= 0) {
      contributing.push(`Next PM due in ${daysUntil} day(s)`);
    } else {
      const overdueDays = Math.abs(daysUntil);
      if (overdueDays > 0) {
        const ratio = intervalDays ? Math.min(1, overdueDays / intervalDays) : 1;
        points = r.overdueBase + Math.round(ratio * r.overdueProportionalMax);
        contributing.push(`PM overdue by ${overdueDays} day(s)${intervalDays ? ` = ${Math.round(ratio * 100)}% of the ${intervalDays}-day interval (${r.overdueBase} + ${Math.round(ratio * r.overdueProportionalMax)})` : ''}`);
      } else {
        contributing.push('PM is not yet due');
      }
    }
    if (lastMaintenanceOn) {
      const sinceDays = diffDays(lastMaintenanceOn, today) ?? 0;
      contributing.push(`Last PM ${sinceDays} day(s) ago (${(sinceDays / 30.44).toFixed(1)} months)${intervalDays ? `, interval ${intervalDays} day(s)` : ''}`);
    } else {
      contributing.push('No completed PM record on file');
    }
  }
  return {
    key: 'maintenanceLag', points, maxPoints: RISK_MODEL.factors[2].maxPoints,
    inputs: { lastMaintenanceOn, intervalDays, nextMaintenanceOn, pmRecordCount },
    contributing,
    advice: points >= r.overdueBase + r.overdueProportionalMax / 2
      ? 'Book the PM before the next teaching block, and record why it slipped — that is what the compliance report will show.'
      : null,
  };
}

function factorCurrentExposure(openFaults, equipmentStatus) {
  const r = RISK_MODEL.rubric.currentExposure;
  const contributing = [];
  let points = 0;
  for (const f of openFaults) {
    const p = r[f.severity] ?? 0;
    if (p > points) points = p;
    contributing.push(`Open ${f.severity.toUpperCase()} fault ${f.reference} (${statusLabel(f.status)})`);
  }
  if (!openFaults.length) contributing.push('No unresolved fault reports');
  if (equipmentStatus === 'awaiting_parts') {
    points = Math.min(r.cap, points + r.awaitingPartsBonus);
    contributing.push(`Awaiting spare parts (+${r.awaitingPartsBonus})`);
  }
  if (equipmentStatus === 'out_of_service') {
    points = Math.min(r.cap, points + r.outOfServiceBonus);
    contributing.push(`Marked out of service (+${r.outOfServiceBonus})`);
  }
  return {
    key: 'currentExposure', points, maxPoints: r.cap,
    inputs: { openFaultCount: openFaults.length, equipmentStatus }, contributing,
    advice: equipmentStatus === 'awaiting_parts' ? 'Escalate the parts order; a long wait is the usual cause of repeat faults.' : null,
  };
}

function factorAge({ acquiredOn, warrantyExpiresOn }, totalFaultsLifetime) {
  const r = RISK_MODEL.rubric.ageAndWarranty;
  const contributing = [];
  let points = 0;
  if (!acquiredOn) {
    points = r.unknown;
    contributing.push('Acquisition date unknown, so age cannot be assessed');
  } else {
    const years = (diffExactDays(acquiredOn, todayDateOnly()) ?? 0) / 365.25;
    contributing.push(`${years.toFixed(1)} years in service (acquired ${acquiredOn})`);
    for (const [threshold, pts] of r.years) if (years >= threshold) { points = pts; break; }
    if (points === 0) points = r.base;
  }
  if (warrantyExpiresOn) {
    if (toDateOnly(warrantyExpiresOn) >= todayDateOnly()) contributing.push('Still under warranty');
    else {
      points = Math.min(r.cap, points + r.expiredWarrantyBonus);
      contributing.push(`Warranty expired ${warrantyExpiresOn} (+${r.expiredWarrantyBonus})`);
    }
  }
  if (totalFaultsLifetime >= 3 && points === r.base) {
    contributing.push(`${totalFaultsLifetime} lifetime fault report(s) on a comparatively young item`);
  }
  return {
    key: 'ageAndWarranty', points, maxPoints: r.cap,
    inputs: { acquiredOn, warrantyExpiresOn, totalFaultsLifetime }, contributing,
    advice: points >= 11 ? 'Plan end-of-life review: repair-vs-replace assessment with training impact.' : null,
  };
}

function factorRepairRecency(lastRepairDays) {
  const r = RISK_MODEL.rubric.repairRecency;
  let points = 0;
  const contributing = [];
  if (lastRepairDays === null || lastRepairDays === undefined) {
    contributing.push('No completed repair on record');
  } else {
    for (const [days, pts] of r.days) if (lastRepairDays <= days) { points = pts; break; }
    contributing.push(`Last repair completed ${lastRepairDays} day(s) ago${points ? ` (+${points}: faults shortly after a repair suggest the root cause is unresolved)` : ''}`);
  }
  return {
    key: 'repairRecency', points, maxPoints: RISK_MODEL.factors[5].maxPoints,
    inputs: { daysSinceLastRepair: lastRepairDays }, contributing,
    advice: points >= 7 ? 'Re-test the failed subsystem and record the acceptance criteria used.' : null,
  };
}

function factorDowntime(availabilityPercent) {
  const r = RISK_MODEL.rubric.downtimeShare;
  const unavailable = availabilityPercent === null ? 0 : Math.max(0, 100 - availabilityPercent);
  let points = r.below;
  for (const [threshold, pts] of r.thresholds) if (unavailable >= threshold) { points = pts; break; }
  return {
    key: 'downtimeShare', points, maxPoints: RISK_MODEL.factors[6].maxPoints,
    inputs: { unavailablePercent180: Math.round(unavailable * 10) / 10 },
    contributing: [`Not usable for ${Math.round(unavailable * 10) / 10}% of the last 180 days`],
    advice: points >= 7 ? 'Availability is being lost repeatedly — consider loan/backup provision.' : null,
  };
}

/* ------------------------------------------------------------------- assess -- */

export function assessRisk(db, equipmentId, { at = new Date(), lightweight = false } = {}) {
  const eq = db.get(
    `SELECT e.id, e.asset_tag, e.name, e.status, e.criticality, e.acquired_on, e.warranty_expires_on,
            e.last_maintenance_on, e.next_maintenance_on, e.maintenance_interval_days,
            (SELECT COUNT(*) FROM maintenance_records m WHERE m.equipment_id = e.id) AS pm_record_count,
            (SELECT COUNT(*) FROM fault_reports f WHERE f.equipment_id = e.id) AS total_faults
       FROM equipment e WHERE e.id = ?`,
    [equipmentId],
  );
  if (!eq) return null;

  const windowDays = 365;
  const windowStart = toDateOnly(new Date(at.getTime() - windowDays * 86_400_000));
  const counts = db.get(
    `SELECT COUNT(*) AS faults FROM fault_reports
      WHERE equipment_id = ? AND date(created_at) >= date(?)`,
    [equipmentId, windowStart],
  ) ?? {};
  // MAX(severity) in SQL would rank alphabetically, not clinically: pick the worst by an
  // explicit CASE ranking instead (critical > high > medium > low).
  const worst = db.value(
    `SELECT severity FROM fault_reports WHERE equipment_id = ?
      ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
               datetime(created_at) DESC LIMIT 1`,
    [equipmentId],
  ) ?? null;
  const recentCritical = db.value(
    `SELECT COUNT(*) FROM fault_reports WHERE equipment_id = ? AND severity = 'critical'
       AND date(created_at) >= date(?)`,
    [equipmentId, toDateOnly(new Date(at.getTime() - 180 * 86_400_000))],
  ) > 0;

  const openFaults = db.all(
    `SELECT id, reference, severity, status FROM fault_reports
      WHERE equipment_id = ? AND status IN (${OPEN_FAULT_STATUSES.map(() => '?').join(',')})
      ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END`,
    [equipmentId, ...OPEN_FAULT_STATUSES],
  );
  const lastRepairDays = db.value(
    `SELECT CAST(julianday(?) - julianday(MAX(date_repaired)) AS INTEGER) FROM repair_records WHERE equipment_id = ?`,
    [todayDateOnly(at), equipmentId],
  );
  const downtime = lightweight ? { availabilityPercent: null } : computeDowntime(db, equipmentId, { days: 180 });

  const factors = [
    factorFailureFrequency(counts.faults ?? 0, { windowDays }),
    factorSeverity({ maxSeverity: worst, recentCritical }),
    factorMaintenanceLag({
      lastMaintenanceOn: eq.last_maintenance_on,
      intervalDays: eq.maintenance_interval_days,
      nextMaintenanceOn: eq.next_maintenance_on,
      pmRecordCount: eq.pm_record_count,
    }),
    factorCurrentExposure(openFaults, eq.status),
    factorAge({ acquiredOn: eq.acquired_on, warrantyExpiresOn: eq.warranty_expires_on }, eq.total_faults),
    factorRepairRecency(lastRepairDays),
    factorDowntime(downtime.availabilityPercent),
  ];

  const raw = factors.reduce((sum, f) => sum + f.points, 0);
  let score = Math.round((raw / RISK_MODEL.maxRaw) * 100);
  let escalated = null;

  const pmOverdue = eq.next_maintenance_on && toDateOnly(eq.next_maintenance_on) < todayDateOnly(at);
  const hasOpenCritical = openFaults.some((f) => f.severity === 'critical');
  if (['life_support', 'high'].includes(eq.criticality) && (pmOverdue || hasOpenCritical)) {
    const band = bandFor(score);
    if (band.level !== 'high') {
      escalated = { from: band.level, to: 'high', rule: RISK_MODEL.escalation.rule, reason: RISK_MODEL.escalation.reason };
      score = Math.max(score, RISK_MODEL.bands[2].min);
    }
  }
  score = Math.max(0, Math.min(100, score));
  const band = bandFor(score);

  return shape({
    equipment_id: eq.id,
    asset_tag: eq.asset_tag,
    equipment_name: eq.name,
    equipment_status: eq.status,
    criticality: eq.criticality,
    model_version: RISK_MODEL.version,
    score,
    raw_score: raw,
    raw_max: RISK_MODEL.maxRaw,
    level: band.level,
    level_label: band.label,
    tone: band.tone,
    advice: band.advice,
    factors: factors.map((f, i) => ({
      ...f,
      label: RISK_MODEL.factors[i].label,
      basis: RISK_MODEL.factors[i].basis,
      weight_percent: Math.round((f.points / RISK_MODEL.maxRaw) * 1000) / 10,
    })),
    escalation: escalated,
    input_snapshot: {
      faultsIn12Months: counts.faults ?? 0,
      worstSeverityOnRecord: worst,
      criticalFaultsIn180Days: recentCritical,
      openFaults: openFaults.length,
      lastMaintenanceOn: eq.last_maintenance_on,
      nextMaintenanceOn: eq.next_maintenance_on,
      maintenanceIntervalDays: eq.maintenance_interval_days,
      acquiredOn: eq.acquired_on,
      warrantyExpiresOn: eq.warranty_expires_on,
      daysSinceLastRepair: lastRepairDays,
      lifetimeFaults: eq.total_faults,
    },
    disclaimer: RISK_MODEL.disclaimer,
    computed_at: at.toISOString().slice(0, 19) + 'Z',
  });
}

/** Ranked fleet view for the dashboard and the reports module. */
export function fleetRisk(db, { limit = 25, level = '', includeUnscheduled = true } = {}) {
  const rows = db.all(
    `SELECT e.id FROM equipment e
      WHERE e.is_active = 1 AND e.status <> 'decommissioned'
        ${includeUnscheduled ? '' : 'AND e.next_maintenance_on IS NOT NULL'}
      ORDER BY (SELECT COUNT(*) FROM fault_reports f WHERE f.equipment_id = e.id) DESC, e.asset_tag
      LIMIT 200`,
  );
  const scored = rows.map((r) => assessRisk(db, r.id, { lightweight: true })).filter(Boolean);
  const filtered = level ? scored.filter((s) => s.level === level) : scored;
  return {
    modelVersion: RISK_MODEL.version,
    disclaimer: RISK_MODEL.disclaimer,
    distribution: filtered.reduce((acc, s) => { acc[s.level] = (acc[s.level] ?? 0) + 1; return acc; }, {}),
    items: filtered.sort((a, b) => b.score - a.score).slice(0, limit),
  };
}

export const modelMetadata = () => shape({
  ...RISK_MODEL,
  band_count: RISK_MODEL.bands.length,
  published_at: nowIso(),
});
