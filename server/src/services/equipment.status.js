/**
 * Equipment status vocabulary in its own module.
 *
 * equipment.service.js, the fault state machine, the risk model and the reporting layer
 * all need the status list and the "which statuses mean the device is unusable" rule.
 * Shared constants live here so those modules never import each other in a circle.
 */

export const EQUIPMENT_STATUSES = [
  'operational', 'reported_fault', 'under_inspection', 'under_repair',
  'awaiting_parts', 'out_of_service', 'decommissioned',
];

export const STATUS_META = {
  operational: { label: 'Operational', tone: 'ok', rank: 1, available: true },
  reported_fault: { label: 'Reported Fault', tone: 'warn', rank: 2, available: false },
  under_inspection: { label: 'Under Inspection', tone: 'info', rank: 3, available: false },
  under_repair: { label: 'Under Repair', tone: 'warn', rank: 4, available: false },
  awaiting_parts: { label: 'Awaiting Parts', tone: 'warn', rank: 5, available: false },
  out_of_service: { label: 'Out of Service', tone: 'bad', rank: 6, available: false },
  decommissioned: { label: 'Decommissioned', tone: 'neutral', rank: 7, available: false },
};

export const CRITICALITIES = ['low', 'medium', 'high', 'life_support'];

export const UNAVAILABLE_STATUSES = EQUIPMENT_STATUSES.filter((s) => STATUS_META[s].available === false);

/** Fault-report stages that still count as "unresolved". */
export const OPEN_FAULT_STATUSES = [
  'reported', 'assigned', 'acknowledged', 'under_inspection', 'under_repair', 'awaiting_parts',
];

export const FAULT_TO_EQUIPMENT_STATUS = {
  reported: 'reported_fault',
  assigned: 'under_inspection',
  acknowledged: 'under_inspection',
  under_inspection: 'under_inspection',
  under_repair: 'under_repair',
  awaiting_parts: 'awaiting_parts',
  repaired: 'operational',
  verified: 'operational',
  closed: 'operational',
};

export const statusLabel = (s) => STATUS_META[s]?.label ?? s;
export const PM_DUE_SOON_DAYS = 14;
