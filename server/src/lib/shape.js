/**
 * Response shaping.  SQL columns are snake_case; the public API is camelCase.  Rather than
 * hand-writing a transformer per endpoint (the classic place where a field silently goes
 * missing), one shape pass is applied at the boundary, and integer-as-flags are converted to
 * real booleans from a single explicit list.
 */

const camelKey = (k) => k.replace(/_+([a-z0-9])/g, (_m, c) => c.toUpperCase());

export const BOOLEAN_FIELDS = new Set([
  'is_active', 'is_read', 'must_change_password', 'auto_action', 'calibration_performed',
  'safety_check_confirmed', 'safe_to_return_to_service', 'requires_evidence', 'recovered',
  'diagnosis_confirmed', 'current', 'is_deleted', 'is_primary', 'has_open_faults',
  'maintenance_is_configured', 'can_act', 'equipment_is_operational',
]);

function convert(value, bools) {
  if (Array.isArray(value)) return value.map((v) => convert(v, bools));
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = camelKey(k);
      out[key] = bools.has(k) || bools.has(key) ? !!v : convert(v, bools);
    }
    return out;
  }
  return value;
}

/** Accepts a row, an array of rows, or a nested object graph. */
export function shape(data, { bools = BOOLEAN_FIELDS } = {}) {
  if (data === undefined || data === null) return null;
  return convert(data, bools);
}

/** camelCase → snake_case, used when a query parameter name doubles as a column name. */
export const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Whitelisted ORDER BY builder — column names must never be interpolated from user input. */
export function orderBy(input, allowed, fallback, { descending = [] } = {}) {
  const key = snake(String(input ?? '').trim());
  if (!allowed.includes(key)) return fallback;
  return `${key}${descending.includes(key) ? ' DESC' : ''}`;
}
