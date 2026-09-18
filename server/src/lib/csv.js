/**
 * CSV generation for report export.  RFC 4180 quoting plus spreadsheet formula-injection
 * neutralisation: a stored field that starts with `=`, `+`, `-`, `@`, TAB or CR is
 * prefixed with a apostrophe so Excel/Sheets treats it as text instead of executing it.
 * (Equipment names and serial numbers are user-supplied, so this is a real risk, not
 * a theoretical one.)
 */

const NEEDS_QUOTE = /[",\r\n]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return NEEDS_QUOTE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {Array<object>} rows
 * @param {Array<{key:string,label:string,map?:Function}>} columns
 */
export function toCsv(rows, columns) {
  const header = columns.map((c) => cell(c.label ?? c.key)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => cell(c.map ? c.map(row) : row[c.key])).join(','),
  );
  // CRLF + UTF-8 BOM: Excel on Windows otherwise mangles degrees/µ and mis-parses rows.
  return '\uFEFF' + [header, ...lines].join('\r\n') + '\r\n';
}

/** Column spec helper for the report definitions. */
export const col = (key, label, map) => (map ? { key, label, map } : { key, label });

export const csvFilename = (base, date = new Date()) =>
  `${base.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${date.toISOString().slice(0, 10)}.csv`;
