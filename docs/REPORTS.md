# Reports & Exports — BEM-FRS

Eight reports, one query path: the on-screen table, the CSV download and the printable view all
come from the **same** `runReport(db, key, filters, user)` — no separate “export logic” to drift.
All report routes are `requireAuth` + capability-gated per report (the audit report additionally
needs `audit.view`); rows are scoped by role where the underlying entity is role-scoped.

## 1. Catalogue

| Key | Title / what it answers | Default window | Notable columns |
| --- | --- | --- | --- |
| `inventory` | “What do we have, where, and in what state?” — every active item + PM position + fault counts | all time | asset tag, name, category, manufacturer/model, serial, location, status, criticality, responsible person, acquired, warranty, last/next PM + state, faults (all-time/open) |
| `faults` | “What broke, who handled it, how long each stage took, and what was found?” | all time (filter by dates/status/severity/…) | reference, reported-at, equipment, category, severity, status, reporter, technician, stage durations (`h to assign/repair/close`), **SLA breached**, title, diagnosis, resolution |
| `maintenance` | “PM work performed, findings, lateness” | date-range friendly | reference, performed, *was due*, days late, condition found, minutes, findings, actions, next due |
| `costs` | “Money spent per repair and what it bought” | date-range | parts/labour/other/**total**, currency, parts used (qty × unit cost lines), calibrated flag |
| `downtime` | “Unusable time computed from the status trail — not from guesses” | window param | downtime events, days down, availability %, longest event, currently down? |
| `failures` | “Which items keep failing — ranked, with cost and risk alongside” | all time | faults, critical/high counts, still-open, repairs, lifetime repair cost, last fault, risk score + level |
| `compliance` | “PM discipline per item and the department rate” | 180-day basis | interval, last PM, next due, state 🟢🟡🔴⚪, days ±, responsible tech, PM records (180 d), late records |
| `audit` | “Who did what, when” — the accountability trail | date-range | when, actor, role, action, entity + reference, summary, IP (admin-only) |

Filter params (validated `reportQuery`): `from`, `to`, `status`, `severity`, `categoryId`,
`locationId`, `technicianId`, `equipmentId`, `actorId`, `q`. Reversed date windows are a 400, not
a silent empty set.

## 2. Formats

* **JSON** — `GET /reports/:key` → `{ title, generatedAt, filters, columns[], rows[], totals, rowCount }`
  (the UI renders this directly; `totals` feed the KPI strip).
* **CSV** — `GET /reports/export/:key/csv`:
  UTF-8 **BOM** first (Excel on Windows opens dates/accents correctly), **CRLF** line endings,
  full quoting where needed, and every cell starting `= + - @` prefixed with `'` so
  spreadsheet formula injection is dead on arrival (tested in `09-reports.test.js`).
  Filename: `<title-slug>-YYYY-MM-DD.csv`.
* **Print-to-PDF** — `GET /reports/export/:key/print`: a self-contained HTML document (no
  external CSS/fonts/scripts) styled for letter/A4 with a `@media print` block (sticky table
  headers, `page-break-inside: avoid` on rows, chrome hidden). One script tag exists — the
  “Print / Save as PDF” button — authorised by a **per-response CSP nonce**; the document
  otherwise runs `default-src 'none'`. Footer repeats row count + the standing safety sentence:
  *“Maintenance-risk figures are decision support for qualified staff and do not certify
  equipment safety.”* (SAFETY.md).
* No server-side PDF renderer by design (one rendering path instead of two; the browser engine
  is the PDF generator — rejected during planning to avoid a heavyweight dependency with
  font/licensing traps).

## 3. Retention & performance

Reports query the live DB; there is no materialisation step at department scale (168 equipment /
52 faults is instant; the indexes listed in DATABASE.md §4 are chosen for these access paths).
If the fleet grows past ~50 k fault reports, the obvious step is monthly rollup tables refreshed
by a nightly command — the query layer already funnels through one SQL builder per report.
