/** Presentation helpers. No authority is computed here — see docs/ARCHITECTURE.md §3. */

export const cx = (...parts) => parts.filter(Boolean).join(' ');

export function formatDateTime(value, { withSeconds = false } = {}) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const opts = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  if (withSeconds) opts.second = '2-digit';
  return new Intl.DateTimeFormat(undefined, opts).format(d);
}

export function formatDate(value) {
  if (!value) return '—';
  const s = String(value).slice(0, 10);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
}

/** "3 h ago" for timelines; falls back to a date beyond a week. */
export function relativeTime(value) {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return String(value);
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return formatDate(value);
}

/** Minutes → "2 h 15 m"; the unit is part of the label so the number stays readable. */
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return '—';
  const m = Math.round(Number(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 48) return rem ? `${h} h ${rem} m` : `${h} h`;
  const d = Math.floor(h / 24);
  const hrs = h % 24;
  return hrs ? `${d} d ${hrs} h` : `${d} d`;
}

export function formatHours(hours) {
  if (hours === null || hours === undefined || Number.isNaN(Number(hours))) return '—';
  return formatDuration(Number(hours) * 60);
}

export function formatMoney(amount, currency = 'USD') {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(Number(amount) || 0);
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = Number(bytes);
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export const titleCase = (s) => String(s ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const sentenceCase = (s) => {
  const t = titleCase(s);
  return t ? t[0] + t.slice(1) : '';
};

/** Month axis labels: "2026-09" → "Sep". Keeps charts readable without a date library. */
export function monthLabel(key) {
  if (!key) return '';
  const [y, m] = String(key).split('-');
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  if (Number.isNaN(d.getTime())) return key;
  return new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(d);
}

/** For <input type="date"> which needs a plain YYYY-MM-DD. */
export const toDateInput = (value) => (value ? String(value).slice(0, 10) : '');
export const toDateTimeLocal = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const pluralise = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
