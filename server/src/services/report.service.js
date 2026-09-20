import { shape } from '../lib/shape.js';
import { toCsv, csvFilename, col } from '../lib/csv.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { can } from '../auth/capabilities.js';
import { todayDateOnly } from '../lib/time.js';
import { statusLabel, OPEN_FAULT_STATUSES } from './equipment.status.js';
import { computeDowntime } from './downtime.service.js';
import { assessRisk } from './risk.service.js';
import { compliance } from './maintenance.service.js';
import { statusLabel as faultStatusLabel } from './fault.service.js';

/**
 * Reports (§12).  A report is a *declaration*: SQL, columns, and the capability required to
 * read it.  That keeps export, on-screen table and the CSV download on exactly the same
 * query, so the number in the file can never disagree with the number on the screen.
 *
 * Export formats: CSV (server-generated, Excel-safe) and print-to-PDF via the browser
 * (the printable HTML view carries the print stylesheet).  A server-side PDF renderer was
 * deliberately not added — see docs/REPORTS.md for the trade-off.
 */

const ph = (n) => Array(n).fill('?').join(',');

/** Adds the shared date/status/location predicates a report accepts. */
function where({ from, to, status, severity, categoryId, locationId, technicianId, equipmentId }, opts = {}) {
  const w = [];
  const p = [];
  const d = opts.dateColumn ?? 'f.created_at';
  const eq = opts.equipmentAlias ?? 'e';
  if (from) { w.push(`date(${d}) >= date(?)`); p.push(from); }
  if (to) { w.push(`date(${d}) <= date(?)`); p.push(to); }
  if (status && opts.statusColumn) { w.push(`${opts.statusColumn} IN (${ph(String(status).split(',').length)})`); p.push(...String(status).split(',')); }
  if (severity && opts.severityColumn) { w.push(`${opts.severityColumn} IN (${ph(String(severity).split(',').length)})`); p.push(...String(severity).split(',')); }
  if (categoryId && opts.categoryColumn) { w.push(`${opts.categoryColumn} = ?`); p.push(categoryId); }
  if (locationId) { w.push(`${eq}.location_id = ?`); p.push(locationId); }
  if (technicianId && opts.techColumn) { w.push(`${opts.techColumn} = ?`); p.push(technicianId); }
  if (equipmentId && opts.equipmentColumn) { w.push(`${opts.equipmentColumn} = ?`); p.push(equipmentId); }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

export const REPORTS = {
  inventory: {
    title: 'Equipment inventory',
    description: 'Every item with its location, status and preventive-maintenance position.',
    capability: 'report.generate',
    columns: [
      col('assetTag', 'Asset tag'), col('name', 'Equipment'), col('categoryName', 'Category'),
      col('manufacturer', 'Manufacturer'), col('model', 'Model'), col('serialNumber', 'Serial no.'),
      col('locationLabel', 'Location'), col('statusLabel', 'Status'), col('criticality', 'Criticality'),
      col('custodianName', 'Responsible person'), col('acquiredOn', 'Acquired'),
      col('warrantyExpiresOn', 'Warranty until'), col('lastMaintenanceOn', 'Last PM'),
      col('nextMaintenanceOn', 'Next PM'), col('maintenanceState', 'PM state'),
      col('totalFaults', 'Faults (all time)'), col('openFaultCount', 'Open faults'),
    ],
    run(db, f) {
      const w = where(f, { dateColumn: 'e.created_at', categoryColumn: 'e.category_id' });
      const rows = db.all(
        `SELECT e.asset_tag, e.name, cat.name AS category_name, e.manufacturer, e.model, e.serial_number,
                TRIM(IFNULL(l.name,'') || CASE WHEN l.room IS NOT NULL THEN ' · Rm ' || l.room ELSE '' END) AS location_label,
                e.status, e.criticality, cu.full_name AS custodian_name,
                e.acquired_on, e.warranty_expires_on, e.last_maintenance_on, e.next_maintenance_on,
                CASE WHEN e.next_maintenance_on IS NULL THEN 'not scheduled'
                     WHEN date(e.next_maintenance_on) < date('now') THEN 'overdue'
                     WHEN julianday(e.next_maintenance_on) - julianday('now') <= 14 THEN 'due soon'
                     ELSE 'up to date' END AS maintenance_state,
                (SELECT COUNT(*) FROM fault_reports fx WHERE fx.equipment_id = e.id) AS total_faults,
                (SELECT COUNT(*) FROM fault_reports fx WHERE fx.equipment_id = e.id AND fx.status IN (${ph(OPEN_FAULT_STATUSES.length)})) AS open_fault_count
           FROM equipment e
           LEFT JOIN equipment_categories cat ON cat.id = e.category_id
           LEFT JOIN locations l ON l.id = e.location_id
           LEFT JOIN users cu ON cu.id = e.custodian_user_id
          WHERE e.is_active = 1 ${w.sql ? 'AND ' + w.sql.slice(6) : ''}
          ORDER BY e.asset_tag`,
        [...OPEN_FAULT_STATUSES, ...w.params],
      );
      return { rows: rows.map((r) => ({ ...r, status_label: statusLabel(r.status) })), totals: {
        items: rows.length,
        operational: rows.filter((r) => r.status === 'operational').length,
        withOpenFaults: rows.filter((r) => r.open_fault_count > 0).length,
        pmOverdue: rows.filter((r) => r.maintenance_state === 'overdue').length,
      } };
    },
  },

  faults: {
    title: 'Fault history',
    description: 'Fault reports with who reported, who handled, how long each stage took and the outcome.',
    capability: 'report.generate',
    columns: [
      col('reference', 'Reference'), col('createdAt', 'Reported'), col('equipmentLabel', 'Equipment'),
      col('categoryName', 'Fault category'), col('severity', 'Severity'), col('statusLabel', 'Status'),
      col('reportedByName', 'Reported by'), col('assignedToName', 'Technician'),
      col('locationName', 'Location'), col('hoursToAssign', 'h to assign'), col('hoursToRepair', 'h to repair'),
      col('hoursToClose', 'h to close'), col('overdue', 'SLA breached'), col('title', 'Title'),
      col('diagnosis', 'Diagnosis'), col('resolutionNote', 'Resolution'),
    ],
    run(db, f) {
      const w = where(f, { statusColumn: 'f.status', severityColumn: 'f.severity', categoryColumn: 'f.category_id',
        techColumn: 'f.assigned_to', equipmentColumn: 'f.equipment_id' });
      const rows = db.all(
        `SELECT f.reference, f.created_at, f.title, f.severity, f.status, f.resolution_note,
                e.asset_tag || ' — ' || e.name AS equipment_label, fc.name AS category_name,
                rep.full_name AS reported_by_name, t.full_name AS assigned_to_name, l.name AS location_name,
                ROUND((julianday(f.assigned_at) - julianday(f.created_at)) * 24, 1) AS hours_to_assign,
                ROUND((julianday(f.repaired_at) - julianday(f.created_at)) * 24, 1) AS hours_to_repair,
                ROUND((julianday(f.closed_at) - julianday(f.created_at)) * 24, 1) AS hours_to_close,
                CASE WHEN f.status IN ('repaired','verified','closed') THEN 'no'
                     WHEN datetime(f.due_at) < datetime('now') THEN 'YES' ELSE 'no' END AS overdue,
                rr.diagnosis
           FROM fault_reports f
           JOIN equipment e ON e.id = f.equipment_id
           LEFT JOIN fault_categories fc ON fc.id = f.category_id
           LEFT JOIN locations l ON l.id = f.location_id
           LEFT JOIN users rep ON rep.id = f.reported_by
           LEFT JOIN users t ON t.id = f.assigned_to
           LEFT JOIN repair_records rr ON rr.fault_id = f.id
          ${w.sql}
          ORDER BY datetime(f.created_at) DESC`,
        w.params,
      );
      return { rows: rows.map((r) => ({ ...r, status_label: faultStatusLabel(r.status) })), totals: {
        reports: rows.length,
        critical: rows.filter((r) => r.severity === 'critical').length,
        open: rows.filter((r) => OPEN_FAULT_STATUSES.includes(r.status)).length,
        breached: rows.filter((r) => r.overdue === 'YES').length,
        medianRepairHours: median(rows.map((r) => r.hours_to_repair)),
      } };
    },
  },

  maintenance: {
    title: 'Maintenance history',
    description: 'Preventive maintenance performed, with checklist findings and lateness.',
    capability: 'report.generate',
    columns: [
      col('reference', 'Reference'), col('performedOn', 'Performed'), col('dueOn', 'Was due'),
      col('daysLate', 'Days late'), col('equipmentLabel', 'Equipment'), col('scheduleTitle', 'Schedule'),
      col('performedByName', 'Technician'), col('conditionFound', 'Condition found'),
      col('durationMinutes', 'Minutes'), col('findings', 'Findings'), col('actionsTaken', 'Actions taken'),
      col('nextDueOn', 'Next due'),
    ],
    run(db, f) {
      const w = where(f, { dateColumn: 'm.performed_on', techColumn: 'm.performed_by', equipmentColumn: 'm.equipment_id' });
      const rows = db.all(
        `SELECT m.reference, m.performed_on, m.due_on, m.days_late, m.condition_found, m.duration_minutes,
                m.findings, m.actions_taken, m.next_due_on,
                e.asset_tag || ' — ' || e.name AS equipment_label, s.title AS schedule_title,
                u.full_name AS performed_by_name
           FROM maintenance_records m
           JOIN equipment e ON e.id = m.equipment_id
           JOIN users u ON u.id = m.performed_by
           LEFT JOIN maintenance_schedules s ON s.id = m.schedule_id
          ${w.sql}
          ORDER BY m.performed_on DESC, m.id DESC`,
        w.params,
      );
      const failed = db.value(
        `SELECT COUNT(*) FROM maintenance_record_checklist c
           JOIN maintenance_records m ON m.id = c.record_id
          WHERE c.outcome = 'fail' ${w.sql ? 'AND ' + w.sql.slice(6) : ''}`,
        w.params,
      ) ?? 0;
      return { rows, totals: {
        records: rows.length,
        onTime: rows.filter((r) => (r.days_late ?? 0) <= 0).length,
        late: rows.filter((r) => (r.days_late ?? 0) > 0).length,
        needsAttention: rows.filter((r) => r.condition_found && r.condition_found !== 'pass').length,
        totalMinutes: rows.reduce((n, r) => n + (r.duration_minutes ?? 0), 0),
        failedChecklistItems: failed,
      } };
    },
  },

  costs: {
    title: 'Repair costs',
    description: 'Parts, labour and total cost per repair, with the parts consumed.',
    capability: 'report.generate',
    columns: [
      col('reference', 'Reference'), col('dateRepaired', 'Date'), col('equipmentLabel', 'Equipment'),
      col('technicianName', 'Technician'), col('faultReference', 'Fault'), col('diagnosis', 'Diagnosis'),
      col('partsCost', 'Parts'), col('labourCost', 'Labour'), col('otherCost', 'Other'),
      col('totalCost', 'Total'), col('currency', 'Cur.'), col('partsSummary', 'Parts used'),
      col('calibrationPerformed', 'Calibrated'),
    ],
    run(db, f) {
      const w = where(f, { dateColumn: 'r.date_repaired', techColumn: 'r.technician_id', equipmentColumn: 'r.equipment_id' });
      const rows = db.all(
        `SELECT r.reference, r.date_repaired, r.diagnosis, r.parts_cost, r.labour_cost, r.other_cost,
                r.total_cost, r.currency, r.parts_replaced_summary AS parts_summary,
                CASE WHEN r.calibration_performed = 1 THEN 'yes' ELSE 'no' END AS calibration_performed,
                e.asset_tag || ' — ' || e.name AS equipment_label, u.full_name AS technician_name,
                fr.reference AS fault_reference
           FROM repair_records r
           JOIN equipment e ON e.id = r.equipment_id
           JOIN users u ON u.id = r.technician_id
           LEFT JOIN fault_reports fr ON fr.id = r.fault_id
          ${w.sql}
          ORDER BY r.date_repaired DESC, r.id DESC`,
        w.params,
      );
      const perEquipment = new Map();
      for (const r of rows) perEquipment.set(r.equipment_label, (perEquipment.get(r.equipment_label) ?? 0) + Number(r.total_cost || 0));
      const sum = (k) => Math.round(rows.reduce((n, r) => n + Number(r[k] || 0), 0) * 100) / 100;
      return { rows, totals: {
        repairs: rows.length,
        partsCost: sum('parts_cost'), labourCost: sum('labour_cost'), otherCost: sum('other_cost'), total: sum('total_cost'),
        averagePerRepair: rows.length ? Math.round((sum('total_cost') / rows.length) * 100) / 100 : 0,
        costliestEquipment: [...perEquipment.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([name, cost]) => `${name}: ${cost.toFixed(2)}`).join(' | ') || '—',
      } };
    },
  },

  downtime: {
    title: 'Equipment downtime',
    description: 'Unusable time per item, computed from the status trail inside the window.',
    capability: 'report.generate',
    columns: [
      col('assetTag', 'Asset tag'), col('name', 'Equipment'), col('categoryName', 'Category'),
      col('locationLabel', 'Location'), col('statusLabel', 'Status'), col('incidents', 'Downtime events'),
      col('days', 'Days down'), col('availabilityPercent', 'Availability %'),
      col('longestHours', 'Longest event (h)'), col('currentlyDown', 'Down now'),
      col('openFaults', 'Open faults'),
    ],
    run(db, f) {
      const days = f.from && f.to ? Math.max(1, Math.round((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000)) : 180;
      const items = db.all(
        `SELECT e.id, e.asset_tag, e.name, e.status, cat.name AS category_name,
                TRIM(IFNULL(l.name,'') || CASE WHEN l.room IS NOT NULL THEN ' · Rm ' || l.room ELSE '' END) AS location_label,
                (SELECT COUNT(*) FROM fault_reports fx WHERE fx.equipment_id = e.id AND fx.status IN (${ph(OPEN_FAULT_STATUSES.length)})) AS open_faults
           FROM equipment e
           LEFT JOIN equipment_categories cat ON cat.id = e.category_id
           LEFT JOIN locations l ON l.id = e.location_id
          WHERE e.is_active = 1 ORDER BY e.asset_tag`,
        OPEN_FAULT_STATUSES,
      );
      const rows = items.map((it) => {
        const d = computeDowntime(db, it.id, { days });
        return {
          asset_tag: it.asset_tag, name: it.name, category_name: it.category_name, location_label: it.location_label,
          status_label: statusLabel(it.status), incidents: d.incidents, days: d.days,
          availability_percent: d.availabilityPercent, longest_hours: Math.round((d.longestIncidentMinutes / 60) * 10) / 10,
          currently_down: d.currentlyDown ? 'YES' : 'no', open_faults: it.open_faults,
        };
      });
      const down = rows.filter((r) => r.incidents > 0);
      return { rows, totals: {
        items: rows.length,
        withDowntime: down.length,
        totalDaysDown: Math.round(down.reduce((n, r) => n + r.days, 0) * 10) / 10,
        worstAvailability: rows.length ? Math.min(...rows.map((r) => r.availability_percent ?? 100)) : 100,
        windowDays: days,
      } };
    },
  },

  failures: {
    title: 'Frequently failing equipment',
    description: 'Ranked by fault count, with severity mix and lifetime repair cost.',
    capability: 'report.generate',
    columns: [
      col('assetTag', 'Asset tag'), col('name', 'Equipment'), col('categoryName', 'Category'),
      col('faults', 'Faults'), col('criticalFaults', 'Critical'), col('highFaults', 'High'),
      col('openFaults', 'Still open'), col('repairs', 'Repairs'), col('totalCost', 'Repair cost'),
      col('lastFaultOn', 'Last fault'), col('riskScore', 'Risk score'), col('riskLevel', 'Risk level'),
    ],
    run(db, f) {
      const w = where(f, { dateColumn: 'f.created_at' });
      const rows = db.all(
        `SELECT e.asset_tag, e.name, cat.name AS category_name,
                COUNT(f.id) AS faults,
                SUM(CASE WHEN f.severity = 'critical' THEN 1 ELSE 0 END) AS critical_faults,
                SUM(CASE WHEN f.severity = 'high' THEN 1 ELSE 0 END) AS high_faults,
                SUM(CASE WHEN f.status IN (${ph(OPEN_FAULT_STATUSES.length)}) THEN 1 ELSE 0 END) AS open_faults,
                (SELECT COUNT(*) FROM repair_records r WHERE r.equipment_id = e.id) AS repairs,
                (SELECT COALESCE(SUM(r.total_cost),0) FROM repair_records r WHERE r.equipment_id = e.id) AS total_cost,
                date(MAX(f.created_at)) AS last_fault_on,
                e.id AS equipment_id
           FROM fault_reports f
           JOIN equipment e ON e.id = f.equipment_id
           LEFT JOIN equipment_categories cat ON cat.id = e.category_id
          ${w.sql}
          GROUP BY e.id
          ORDER BY faults DESC, critical_faults DESC, last_fault_on DESC`,
        [...OPEN_FAULT_STATUSES, ...w.params],
      );
      for (const r of rows) {
        const a = assessRisk(db, r.equipment_id, { lightweight: true });
        r.risk_score = a?.score ?? null;
        r.risk_level = a?.levelLabel ?? null;
        delete r.equipment_id;
      }
      return { rows, totals: { itemsWithFaults: rows.length, totalFaults: rows.reduce((n, r) => n + r.faults, 0) } };
    },
  },

  compliance: {
    title: 'Maintenance compliance',
    description: 'Per-item PM position and the department-level on-time rate.',
    capability: 'report.generate',
    columns: [
      col('assetTag', 'Asset tag'), col('name', 'Equipment'), col('intervalDays', 'Interval (days)'),
      col('lastMaintenanceOn', 'Last PM'), col('nextMaintenanceOn', 'Next due'),
      col('state', 'State'), col('daysRelative', 'Days +/-'), col('technician', 'Responsible technician'),
      col('records180d', 'PM records (180 d)'), col('lateRecords180d', 'Late records'),
    ],
    run(db, f) {
      const rows = db.all(
        `SELECT e.asset_tag, e.name, e.maintenance_interval_days AS interval_days, e.last_maintenance_on,
                e.next_maintenance_on,
                CASE WHEN e.next_maintenance_on IS NULL THEN 'no schedule'
                     WHEN date(e.next_maintenance_on) < date('now') THEN 'OVERDUE'
                     WHEN julianday(e.next_maintenance_on) - julianday('now') <= 14 THEN 'due soon'
                     ELSE 'up to date' END AS state,
                CAST(julianday('now') - julianday(e.next_maintenance_on) AS INTEGER) AS days_relative,
                u.full_name AS technician,
                (SELECT COUNT(*) FROM maintenance_records m WHERE m.equipment_id = e.id AND date(m.performed_on) >= date('now','-180 days')) AS records_180d,
                (SELECT COUNT(*) FROM maintenance_records m WHERE m.equipment_id = e.id AND date(m.performed_on) >= date('now','-180 days') AND m.days_late > 0) AS late_records_180d
           FROM equipment e LEFT JOIN users u ON u.id = e.responsible_technician_id
          WHERE e.is_active = 1 AND e.status <> 'decommissioned'
          ORDER BY CASE WHEN e.next_maintenance_on IS NULL THEN 1 ELSE 0 END DESC, julianday(e.next_maintenance_on)`,
      );
      return { rows, totals: compliance(db, { days: f.days ?? 180 }) };
    },
  },

  audit: {
    title: 'Audit log',
    description: 'Who did what, when — the accountability trail for the whole system.',
    capability: 'audit.view',
    columns: [col('createdAt', 'When'), col('actorName', 'Actor'), col('actorRole', 'Role'),
      col('action', 'Action'), col('entityType', 'Entity'), col('entityRef', 'Reference'),
      col('summary', 'Summary'), col('ip', 'IP')],
    run(db, f) {
      const w = [];
      const p = [];
      if (f.from) { w.push('date(a.created_at) >= date(?)'); p.push(f.from); }
      if (f.to) { w.push('date(a.created_at) <= date(?)'); p.push(f.to); }
      if (f.actorId) { w.push('a.actor_id = ?'); p.push(f.actorId); }
      if (f.q) { w.push('(a.action LIKE ? OR a.summary LIKE ? OR a.entity_ref LIKE ?)'); p.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
      return { rows: db.all(
        `SELECT a.created_at, a.action, a.entity_type, a.entity_ref, a.summary, a.ip,
                u.full_name AS actor_name, a.actor_role
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
          ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
          ORDER BY datetime(a.created_at) DESC, a.id DESC LIMIT 5000`, p,
      ), totals: { entries: db.value('SELECT COUNT(*) FROM audit_logs') } };
    },
  },
};

const median = (values) => {
  const nums = values.filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? Math.round(nums[mid] * 10) / 10 : Math.round(((nums[mid - 1] + nums[mid]) / 2) * 10) / 10;
};

export const reportList = (user) => Object.entries(REPORTS)
  .filter(([, r]) => can(user, r.capability))
  .map(([key, r]) => shape({ key, title: r.title, description: r.description }));

export function runReport(db, key, filters, user) {
  const report = REPORTS[key];
  if (!report) throw badRequest(`Unknown report “${key}”`);
  if (!can(user, report.capability)) throw forbidden(`Report “${report.title}” requires the ${report.capability} permission`);
  const safe = {
    from: filters.from ?? null, to: filters.to ?? null, status: filters.status ?? null,
    severity: filters.severity ?? null, categoryId: filters.categoryId ?? null,
    locationId: filters.locationId ?? null, technicianId: filters.technicianId ?? null,
    equipmentId: filters.equipmentId ?? null, actorId: filters.actorId ?? null, q: filters.q ?? null,
  };
  if (safe.from && safe.to && safe.from > safe.to) throw badRequest('The “from” date must be on or before the “to” date', { fields: { from: ['After “to”'] } });
  const { rows, totals } = report.run(db, safe);
  return {
    key,
    title: report.title,
    description: report.description,
    filters: safe,
    generatedAt: new Date().toISOString(),
    columns: report.columns.map((c) => ({ key: c.key, label: c.label })),
    rows: shape(rows),
    totals: shape(totals ?? {}),
    rowCount: rows.length,
  };
}

export function reportCsv(db, key, filters, user) {
  const report = REPORTS[key];
  const result = runReport(db, key, filters, user);
  const csv = toCsv(result.rows, report.columns);
  return { csv, filename: csvFilename(result.title, new Date()), rows: result.rowCount };
}

/**
 * Printable view: the same rows, in a document the department can PDF-print on letter/A4.
 * The document runs under `default-src 'none'` — the “Print” button therefore needs a
 * per-response script nonce (generated by the route) instead of an inline `onclick`, which
 * the CSP would silently block.  Without a nonce the button is not rendered; the browser's
 * own print dialog still works.
 */
export function reportHtml(db, key, filters, user, { department = '', institution = '', nonce = '' } = {}) {
  const result = runReport(db, key, filters, user);
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const filterLine = Object.entries(result.filters).filter(([, v]) => v).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' · ') || 'no filters';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(result.title)} — ${esc(institution || 'BEM-FRS')}</title>
<style>
 body{font:12px/1.45 "Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;margin:24px}
 h1{font-size:18px;margin:0 0 2px} .sub{color:#475569;font-size:11px;margin-bottom:14px}
 table{border-collapse:collapse;width:100%;font-size:10.5px}
 th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left;vertical-align:top}
 th{background:#f1f5f9;position:sticky;top:0}
 tfoot td{font-weight:600;background:#f8fafc}
 .totals{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
 .totals div{border:1px solid #cbd5e1;border-radius:6px;padding:6px 10px}
 .totals b{display:block;font-size:15px}
 footer{margin-top:14px;color:#475569;font-size:10px;border-top:1px solid #e2e8f0;padding-top:8px}
 @media print{ body{margin:8mm} .noprint{display:none} table{page-break-inside:auto} tr{page-break-inside:avoid} }
</style></head><body>
<h1>${esc(result.title)}</h1>
<div class="sub">${esc(institution ? institution + ' — ' : '')}${esc(department || 'Biomedical Engineering')} · generated ${esc(result.generatedAt.slice(0, 16).replace('T', ' '))} UTC · ${esc(filterLine)}</div>
<div class="totals">${Object.entries(result.totals).map(([k, v]) => `<div><b>${esc(typeof v === 'number' ? v.toLocaleString() : v)}</b>${esc(k.replace(/_/g, ' '))}</div>`).join('')}</div>
<table><thead><tr>${result.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
<tbody>${result.rows.map((r) => `<tr>${result.columns.map((c) => `<td>${esc(r[c.key])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${result.columns.length}">No rows match these filters.</td></tr>`}</tbody></table>
<footer>${result.rows.length} row(s). Generated by the Biomedical Equipment Maintenance &amp; Fault Reporting System. Maintenance-risk figures are decision support for qualified staff and do not certify equipment safety.</footer>
${nonce ? `<div class="noprint" style="margin-top:14px"><button id="bems-print">Print / Save as PDF</button></div>
<script nonce="${esc(nonce)}">document.getElementById('bems-print').addEventListener('click', () => window.print())</script>` : ''}
</body></html>`;
}
