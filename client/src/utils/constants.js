/**
 * UI vocabulary mirrored from the server (docs/API.md).  Display metadata only: the server is
 * authoritative for which transitions are legal and which role may perform them.
 */
export const EQUIPMENT_STATUS = {
  operational: { label: 'Operational', tone: 'ok', hint: 'Ready for use' },
  reported_fault: { label: 'Reported Fault', tone: 'warn', hint: 'A user has reported a problem' },
  under_inspection: { label: 'Under Inspection', tone: 'info', hint: 'Being assessed by a technician' },
  under_repair: { label: 'Under Repair', tone: 'warn', hint: 'Work in progress on the bench' },
  awaiting_parts: { label: 'Awaiting Parts', tone: 'warn', hint: 'Blocked on a spare part' },
  out_of_service: { label: 'Out of Service', tone: 'bad', hint: 'Deliberately unavailable' },
  decommissioned: { label: 'Decommissioned', tone: 'neutral', hint: 'Written off / no longer maintained' },
};

export const FAULT_STATUS = {
  reported: { label: 'Reported', tone: 'warn', step: 1 },
  assigned: { label: 'Assigned', tone: 'info', step: 2 },
  acknowledged: { label: 'Acknowledged', tone: 'info', step: 3 },
  under_inspection: { label: 'Under Inspection', tone: 'info', step: 4 },
  under_repair: { label: 'Under Repair', tone: 'warn', step: 5 },
  awaiting_parts: { label: 'Awaiting Parts', tone: 'warn', step: 6 },
  repaired: { label: 'Repaired', tone: 'ok', step: 7 },
  verified: { label: 'Verified', tone: 'ok', step: 8 },
  closed: { label: 'Closed', tone: 'neutral', step: 9 },
};

export const SEVERITY = {
  low: { label: 'Low', tone: 'neutral', hint: 'Usable with care; fix when convenient' },
  medium: { label: 'Medium', tone: 'info', hint: 'Affected teaching or use, not safety' },
  high: { label: 'High', tone: 'warn', hint: 'Cannot be used as intended; someone is affected today' },
  critical: { label: 'Critical', tone: 'bad', hint: 'Unsafe to use or a safety function is lost — stop using it and tell the desk now' },
};

export const CRITICALITY = {
  low: { label: 'Low', hint: 'Teaching aid, easily substituted' },
  medium: { label: 'Medium', hint: 'Shared teaching equipment' },
  high: { label: 'High', hint: 'Core to the department schedule' },
  life_support: { label: 'Life-support class', hint: 'Treated as safety-critical for scheduling; still requires human sign-off for use' },
};

export const MAINTENANCE_STATE = {
  up_to_date: { label: 'Maintenance up to date', light: '🟢', tone: 'ok' },
  due_soon: { label: 'Maintenance due soon', light: '🟡', tone: 'warn' },
  overdue: { label: 'Maintenance overdue', light: '🔴', tone: 'bad' },
  not_scheduled: { label: 'No schedule configured', light: '⚪', tone: 'neutral' },
};

export const RISK_LEVEL = {
  low: { label: 'Low Risk', tone: 'ok' },
  moderate: { label: 'Moderate Risk', tone: 'warn' },
  high: { label: 'High Risk', tone: 'bad' },
};

export const TONE_LABEL = { ok: 'Good', warn: 'Attention', bad: 'Critical', info: 'Information', neutral: 'Neutral' };

export const SAFETY_NOTICE =
  'This system records equipment status and maintenance history for the department. It does not assess patient safety, does not diagnose equipment faults, and does not replace inspection by a qualified biomedical engineer.';
