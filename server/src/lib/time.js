/**
 * All persisted timestamps are UTC ISO-8601 with second precision; all persisted
 * "date" values are `YYYY-MM-DD`.  Keeping the two forms distinct stops the classic
 * "maintenance is due yesterday" off-by-one caused by local-time serialisation.
 *
 * `now()` reads the injectable clock so date-dependent logic (due-soon windows,
 * risk scoring, SLA arithmetic) can be tested at fixed points in time.
 */

let clock = () => new Date();
export const setClock = (fn) => { const prev = clock; clock = fn; return prev; };
export const now = () => clock();

export const nowIso = () => toIsoSeconds(clock());

export function toIsoSeconds(d = clock()) {
  return new Date(d).toISOString().slice(0, 19) + 'Z';
}

export function toDateOnly(d = clock()) {
  if (typeof d === 'string') return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

export const todayDateOnly = (d) => toDateOnly(d ?? clock());

/** Tolerant parser: accepts Date | 'YYYY-MM-DD' | full ISO. Returns null on garbage. */
export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function requireDate(value, field = 'date') {
  const d = parseDate(value);
  if (!d) {
    const err = new Error(`Invalid ${field}`);
    err.status = 400;
    throw err;
  }
  return d;
}

export function addDays(value, days) {
  const d = parseDate(value) ?? new Date();
  return new Date(d.getTime() + days * 86_400_000);
}

export function addHours(value, hours) {
  const d = parseDate(value) ?? new Date();
  return new Date(d.getTime() + hours * 3_600_000);
}

/** Whole calendar days between two dates (b - a), ignoring the time of day. */
export function diffDays(a, b = clock()) {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return null;
  const ya = Date.UTC(da.getUTCFullYear(), da.getUTCMonth(), da.getUTCDate());
  const yb = Date.UTC(db.getUTCFullYear(), db.getUTCMonth(), db.getUTCDate());
  return Math.round((yb - ya) / 86_400_000);
}

/** Fractional days, used for ageing metrics where part-days matter. */
export function diffExactDays(a, b = clock()) {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return null;
  return (db.getTime() - da.getTime()) / 86_400_000;
}

export const isPast = (value) => {
  const d = parseDate(value);
  return !!d && d.getTime() < clock().getTime();
};

export const monthKey = (value) => toDateOnly(parseDate(value) ?? clock()).slice(0, 7);

/** Array of the last `n` month keys, oldest first — the x-axis of trend charts. */
export function lastMonths(n, from = clock()) {
  const d = new Date(from);
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export function minutesBetween(a, b) {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return null;
  return Math.max(0, Math.round((db.getTime() - da.getTime()) / 60_000));
}

/** 95 → "1 h 35 m" — the format used on every duration column in the UI. */
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h} h ${rem} m` : `${h} h`;
  const days = Math.floor(h / 24);
  const hrs = h % 24;
  return hrs ? `${days} d ${hrs} h` : `${days} d`;
}
