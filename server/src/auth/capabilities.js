/**
 * Role-Based Access Control — single source of truth.
 *
 * Design notes (see docs/SECURITY.md):
 *  - Capabilities are declared here, in code, and reviewed in one diff.  A permission
 *    table in the database sounds flexible but silently lets a UI-only bug become an
 *    authorisation bug; code review is the control we actually trust.
 *  - `roles` exists as a table so `users.role_id` has referential integrity; the
 *    *content* of a role is this map.
 *  - Every capability is enforced on the server.  The client reads this same map from
 *    `GET /api/v1/auth/me` purely to decide what to render.
 *  - Two rules encode the department's accountability requirements:
 *      1. only a technician/administrator may assert a technical diagnosis
 *         (`repair.write`, `fault.transition.diagnose`) — reporters physically cannot;
 *      2. reporters have no capability touching official records
 *         (`equipment.*`, `maintenance.*`, `audit.*`).
 */

export const ROLES = {
  admin: {
    id: 1,
    code: 'admin',
    label: 'Administrator',
    capabilities: [
      'equipment.view', 'equipment.view.all', 'equipment.create', 'equipment.update',
      'equipment.deactivate', 'equipment.delete', 'equipment.status.set', 'equipment.qr',
      'equipment.image', 'equipment.maintenance.configure',
      'meta.manage', 'settings.manage', 'user.manage', 'user.view',
      'fault.view.any', 'fault.create', 'fault.assign', 'fault.transition.manage',
      'fault.reopen', 'fault.verify',
      'repair.view.any', 'repair.view.own',
      'maintenance.view', 'maintenance.record.view.any',
      'maintenance.schedule.manage',
      'risk.view', 'dashboard.view', 'report.generate', 'export.data',
      'audit.view',
      'notification.view.own', 'attachment.view.any', 'attachment.create.any',
    ],
  },

  technician: {
    id: 2,
    code: 'technician',
    label: 'Technician / Biomedical Engineer',
    capabilities: [
      'equipment.view', 'equipment.view.all', 'equipment.create', 'equipment.update',
      'equipment.status.set', 'equipment.qr', 'equipment.image',
      'equipment.maintenance.configure',
      'meta.read', 'user.view',
      'fault.view.assigned', 'fault.view.any', 'fault.create', 'fault.selfAssign',
      'fault.transition.technical', 'fault.diagnose', 'fault.verify',
      'repair.write', 'repair.view.own', 'repair.view.any', 'repair.parts',
      'maintenance.view', 'maintenance.record.write', 'maintenance.record.view.own',
      'risk.view', 'dashboard.view',
      'notification.view.own', 'attachment.view.any', 'attachment.create.work',
    ],
  },

  reporter: {
    id: 3,
    code: 'reporter',
    label: 'Student / Staff Reporter',
    capabilities: [
      'equipment.view',
      'meta.read',
      'fault.create', 'fault.view.own', 'fault.comment',
      'risk.view.summary',
      'notification.view.own',
      'attachment.create.own',
    ],
  },
};

const CAP_SETS = new Map(
  Object.values(ROLES).map((r) => [r.code, new Set(r.capabilities)]),
);

/**
 * Plain-language explanation attached to every 403, because "permission denied" tells a
 * laboratory supervisor nothing about what to do next. Keyed by the capability the route
 * asked for; the first matching hint wins.
 */
export const CAPABILITY_HINTS = {
  'equipment.create': 'Adding or editing equipment records is done by the department administrator or a biomedical engineer.',
  'equipment.delete': 'Deletion is administrator-only, and only for records with no history. Deactivate or decommission instead.',
  'equipment.update': 'Only an administrator or technician may change an equipment record.',
  'equipment.deactivate': 'Only an administrator can deactivate or reactivate an equipment record.',
  'equipment.status.set': 'Only an administrator or technician can change official equipment status.',
  'equipment.image': 'Only staff accounts (administrator or technician) can change equipment photographs.',
  'equipment.maintenance.configure': 'Maintenance intervals and checklists are set by the administrator or the responsible engineer.',
  'meta.manage': 'Categories, locations, fault types, the parts catalogue and settings are administrator-only.',
  'settings.manage': 'Department settings are administrator-only.',
  'user.manage': 'User accounts are managed by the department administrator.',
  'fault.assign': 'Faults are assigned by the department administrator; a technician may pick up an unassigned fault.',
  'fault.selfAssign': 'Only technicians may take ownership of a fault.',
  'fault.reopen': 'Reopening a closed fault is an administrator action so the change is deliberate and recorded.',
  'fault.verify': 'Verification is done by a technician, an administrator, or the person who reported the fault.',
  'repair.write': 'Only a technician or biomedical engineer may record a diagnosis or repair — a diagnosis is a professional judgement, not a note.',
  'repair.parts': 'Replacement parts are recorded by the technician who fitted them.',
  'maintenance.schedule.manage': 'Maintenance schedules are configured by an administrator or technician.',
  'maintenance.record.write': 'Preventive maintenance can only be signed off by a technician or administrator.',
  'audit.view': 'The audit log is administrator-only.',
  'report.generate': 'Departmental reports are prepared by the administrator.',
  'export.data': 'Data export is administrator-only.',
  'dashboard.view': 'This view is for staff accounts.',
};

export const hintFor = (capability) => CAPABILITY_HINTS[capability] ?? null;

export const ALL_CAPABILITIES = [
  ...new Set(Object.values(ROLES).flatMap((r) => r.capabilities)),
].sort();

export const roleLabel = (code) => ROLES[code]?.label ?? code;

export function can(user, capability) {
  if (!user?.roleCode) return false;
  const set = CAP_SETS.get(user.roleCode);
  return !!set && set.has(capability);
}

export function capabilitiesFor(user) {
  return [...(CAP_SETS.get(user?.roleCode) ?? [])].sort();
}

/** True when the user may see/modify *this particular* record, not just the collection. */
export function canSeeFault(user, fault) {
  if (can(user, 'fault.view.any')) return true;
  if (user.id === fault.reported_by) return true;
  if (user.id === fault.assigned_to) return true;
  return false;
}
