import { unprocessable } from './errors.js';

/**
 * Declarative input validation.  Every write endpoint names a schema, so:
 *   - types, lengths, enum values and cross-field rules are enforced server-side;
 *   - unknown fields are stripped (mass-assignment cannot happen by accident);
 *   - the response contains a per-field error map the form can render inline.
 *
 * Values arrive as strings from both `application/x-www-form-data` (the mobile
 * camera upload path) and JSON, so coercion is explicit and total.
 */

const ID_RE = /^\d+$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** `spec` shapes: {type, required, min, max, values, pattern, default, trim, lowercase, of, minLen, maxLen} */
function checkField(key, spec, raw, out, err) {
  const type = spec.type || 'string';

  if (isBlank(raw)) {
    if (spec.required) return err(key, 'This field is required');
    if (spec.default !== undefined) out[key] = typeof spec.default === 'function' ? spec.default() : spec.default;
    else if (type !== 'array') out[key] = null;
    return undefined;
  }

  switch (type) {
    case 'string': {
      let v = typeof raw === 'string' ? raw : String(raw);
      if (spec.trim !== false) v = v.trim();
      if (spec.lowercase) v = v.toLowerCase();
      if (spec.collapseNewlines) v = v.replace(/\r\n/g, '\n');
      if (v.length === 0) return spec.required ? err(key, 'This field is required') : (out[key] = null);
      if (spec.min && v.length < spec.min) return err(key, `Must be at least ${spec.min} characters`);
      if (spec.max && v.length > spec.max) return err(key, `Must be at most ${spec.max} characters`);
      if (spec.pattern && !spec.pattern.test(v)) return err(key, spec.message || 'Invalid format');
      out[key] = v;
      return undefined;
    }
    case 'int': {
      const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
      if (!Number.isFinite(n) || Number.isNaN(n)) return err(key, 'Must be a whole number');
      if (spec.min !== undefined && n < spec.min) return err(key, `Must be ${spec.min} or more`);
      if (spec.max !== undefined && n > spec.max) return err(key, `Must be ${spec.max} or less`);
      out[key] = n;
      return undefined;
    }
    case 'float': {
      const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim());
      if (!Number.isFinite(n)) return err(key, 'Must be a number');
      if (spec.min !== undefined && n < spec.min) return err(key, `Must be ${spec.min} or more`);
      if (spec.max !== undefined && n > spec.max) return err(key, `Must be ${spec.max} or less`);
      out[key] = Math.round(n * 100) / 100; // money, 2dp
      return undefined;
    }
    case 'bool': {
      if (typeof raw === 'boolean') return (out[key] = raw);
      const s = String(raw).trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return (out[key] = true);
      if (['0', 'false', 'no', 'off'].includes(s)) return (out[key] = false);
      return err(key, 'Must be true or false');
    }
    case 'enum': {
      const v = String(raw).trim().toLowerCase();
      if (!spec.values.includes(v)) {
        return err(key, `Must be one of: ${spec.values.join(', ')}`);
      }
      out[key] = v;
      return undefined;
    }
    case 'date': {
      const v = String(raw).trim().slice(0, 10);
      if (!DATE_ONLY_RE.test(v)) return err(key, 'Use the date format YYYY-MM-DD');
      const d = new Date(`${v}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
        return err(key, 'Not a real calendar date');
      }
      if (spec.noFuture && v > todayDateOnly()) return err(key, 'Cannot be in the future');
      if (spec.noPast && v < todayDateOnly()) return err(key, 'Must be today or later');
      out[key] = v;
      return undefined;
    }
    case 'datetime': {
      const v = String(raw).trim();
      if (!DATETIME_RE.test(v)) return err(key, 'Use ISO format YYYY-MM-DDTHH:MM');
      const d = new Date(v.endsWith('Z') || /\+|-/.test(v.slice(10)) ? v : `${v}Z`);
      if (Number.isNaN(d.getTime())) return err(key, 'Not a real date and time');
      if (spec.noFuture && d.getTime() > Date.now() + 60_000) return err(key, 'Cannot be in the future');
      out[key] = d.toISOString().slice(0, 19) + 'Z';
      return undefined;
    }
    case 'array': {
      let v = raw;
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          v = v.split(',').map((s) => s.trim()).filter(Boolean);
        }
      }
      if (!Array.isArray(v)) return err(key, 'Must be a list');
      if (spec.minLen && v.length < spec.minLen) return err(key, `At least ${spec.minLen} entries`);
      if (spec.maxLen && v.length > spec.maxLen) return err(key, `At most ${spec.maxLen} entries`);
      const items = [];
      for (let i = 0; i < v.length; i += 1) {
        const inner = {};
        checkField(`${key}[${i}]`, spec.of ?? { type: 'raw' }, v[i], inner, err);
        items.push(inner[`${key}[${i}]`] ?? inner['0']);
      }
      out[key] = items;
      return undefined;
    }
    case 'idList': {
      let v = raw;
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { v = v.split(',').map((s) => s.trim()).filter(Boolean); }
      }
      if (!Array.isArray(v)) v = [v];
      const ids = [];
      for (const item of v) {
        const s = String(item).trim();
        if (!ID_RE.test(s)) return err(key, 'Each entry must be a numeric id');
        ids.push(Number(s));
      }
      out[key] = [...new Set(ids)];
      return undefined;
    }
    case 'raw':
      out[key] = raw;
      return undefined;
    default:
      throw new Error(`Unknown validator type: ${type}`);
  }
}

export function todayDateOnly(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * @returns {{value: object, provided: string[]}} validated, coerced, unknown-stripped input
 * @throws {AppError} 422 with `details.fields`
 */
export function validate(input, schema, { partial = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const value = {};
  const errors = [];
  const err = (field, message) => {
    errors.push({ field, message });
    return false;
  };
  const provided = [];

  for (const [key, specRaw] of Object.entries(schema)) {
    if (!specRaw) continue;
    const spec = specRaw;
    const present = key in src && src[key] !== undefined;
    if (!present) {
      // Defaults apply to *absent* fields (that is what they are for), but an absent field
      // never lands in `provided`, so a PATCH does not silently overwrite it.
      if (spec.default !== undefined) {
        value[key] = typeof spec.default === 'function' ? spec.default() : spec.default;
      }
      if (partial || !spec.required) continue;
      err(key, 'This field is required');
      continue;
    }
    const before = errors.length;
    checkField(key, { ...spec, required: partial ? false : spec.required }, src[key], value, err);
    if (errors.length === before) provided.push(key);
  }

  // cross-field rules
  if (typeof schema.$ === 'object' && schema.$ && typeof schema.$.check === 'function') {
    schema.$.check(value, (field, message) => errors.push({ field, message }));
  }

  if (errors.length) {
    const fields = {};
    for (const e of errors) (fields[e.field] ||= []).push(e.message);
    throw unprocessable('The submitted data was rejected', fields);
  }
  return { value, provided };
}

/** Middleware factory: validates `req.body` into `req.data`. */
export const bodyParser = (schema, opts) => (req, _res, next) => {
  try {
    const { value, provided } = validate(req.body ?? {}, schema, opts);
    req.data = value;
    req.provided = provided;
    next();
  } catch (e) {
    next(e);
  }
};

/** Middleware factory: validates `req.query` into `req.filters` (unknown keys ignored). */
export const queryParser = (schema) => (req, _res, next) => {
  try {
    const q = typeof req.query === 'object' && req.query !== null ? req.query : {};
    const flat = {};
    for (const [k, v] of Object.entries(q)) flat[k] = Array.isArray(v) ? v.join(',') : v;
    const { value } = validate(flat, schema);
    req.filters = value;
    next();
  } catch (e) {
    next(e);
  }
};
