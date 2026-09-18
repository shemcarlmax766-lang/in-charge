# Build Phases — how BEM-FRS was assembled

The brief demanded *design before bulk code, then 10 incremental phases, each run, tested and
fixed before continuing*. This file is the honest record: what shipped in each phase, how it was
verified, and what the verification actually caught. Test names are `describe`-level, runnable
via `npm run test:server` (87 tests, ~5 s) and `npm run test:client` (42 tests).

## Phase 0 (pre-code) — Design documents

**Delivered:** this folder — architecture, schema, API, auth model, UI screens, folder structure,
dependency list, failure points. Written *first*; the code obeys them (e.g. capability names in
`capabilities.js` match §Security here; table list matches §Database).
**Verified by:** review. Where implementation found a better shape, the doc was corrected alongside
the code rather than quietly diverging from it.

## Phase 1 — Workspace, config, environment hygiene

npm workspaces (`server`, `client`), zero-dependency `.env` loader with `assertConfig()`,
`data/` layout git-ignored, `scripts/lint.mjs` baseline (hard-coded-secret / SQL / header checks).
**Exit check:** `node scripts/lint.mjs` green; boot without any env vars works with safe defaults;
`npm ls` shows only express/multer/qrcode/react-router runtime deps.
**Caught:** config path depth (`ROOT` resolution) — fixed before anything mounted on it.

## Phase 2 — Database layer

`lib/db.js` (node:sqlite adapter: prepare/all/get/run/tx, `countPlaceholders` bind-count guard,
`nextSequence`), migration runner with **checksum verification**, `001_init.sql` (24 tables,
54 CHECKs, 56 indexes), `npm run migrate|reset|seed`.
**Exit check:** migrate is idempotent; second run prints “schema is up to date”; tampering with an
applied SQL file trips the guard loudly (this later saved the demo DB from a silent half-migration).
**Caught:** `stmt.all([array])` vs spread params — adapter normalises it once.

## Phase 3 — Authentication & sessions

scrypt hashing + policy, opaque token sessions (SHA-256 at rest), login lockout, change-password,
session list/revoke, cookie+Bearer dual mode, `/auth/policy`.
**Exit check (test file `01-auth.test.js`, 11 tests):** happy path, wrong password uniform 401,
lockout after N (and *before* verify), lock expiry unlocks, cookie flags, revoke-all really
revokes, change-password kills other sessions but not this one.
**Caught:** lockout was originally checked *after* hashing — reordered so failed logins can't DoS
the scrypt CPU.

## Phase 4 — RBAC & middleware pipeline

capabilities matrix, `requireRole/requireCap`, 403 hints, CSRF guard, rate limiters, security
headers/CSP, error handler (`asyncRoute`, typed `ApiError`s).
**Exit check (`02-rbac.test.js`, 8 tests):** every protected route × 3 roles matrix sample;
reporter→403s *and* the hint text; cookie write without CSRF → 403; bearer path exempt;
rate-limit 429 + Retry-After; headers present on API and SPA responses.
**Caught:** capability hints were keyed by role not capability — re-keyed so the *route* names the
permission it needed.

## Phase 5 — Equipment inventory CRUD + QR + photos

Full 30-column record, search/filter/sort (whitelisted), auto `assetTag`, duplicate guards,
status endpoint with history, deactivate/activate, delete-refuses-with-history, QR PNG/SVG
(`qrcode`), hero-image upload (magic-byte policy), label-sheet endpoint, `GET /public/equipment/:tag`.
**Exit check (`03-equipment.test.js`, 11 tests):** validation errors name fields; unique serial →
409; status change writes history row with actor+comment; QR decodes back to the `/e/<tag>` URL;
upload spoof (`.png` that is actually `.exe`) rejected; public tag returns no serial.
**Caught:** `needsAttention` filter originally compared maintenance dates as strings across
timezones — centralised to UTC-date strings in `lib/time.js`.

## Phase 6 — Fault workflow (state machine + audit trail)

9 states, `TRANSITIONS` map, per-transition history row (user/time/from/to/comment), technical-stage
gate, assignment rules, SLA `due_at`, reopen path, notes, reporter pre-triage edit window,
equipment-status mirroring including the operational↔fault coupling.
**Exit check (`04-faults.test.js`, 9 tests):** every legal edge from the table exercised; every
illegal edge → 403/400 with reason; reporter cannot enter `under_inspection`; closing a worked
fault without Repaired/Verified blocked; history rows count == transition count.
**Caught:** mirroring once wrote equipment history *outside* the fault transaction — wrapped in
`db.tx` so a crash can't leave the fleet lying.

## Phase 7 — Repair records & parts

1:1 repair record, parts junction with server-side cost totals, readiness gate (diagnosis+root
cause+repair+test results+parts summary complete), before/after photo endpoints, calibration
fields, technician attestation flags.
**Exit check (`05-repairs.test.js`, 6 tests):** only assigned tech writes (admin can, per brief's
accountability rule — verified), incomplete repair cannot move to Verified/operational,
`totalCost` from client ignored and recomputed, unknown part code → 400, photos tagged
before/after and visible per role.

## Phase 8 — Preventive maintenance + reminders

Schedules with interval + owner + checklist items, due-board with 🟢/🟡/🔴/⚪, record completion
(pass/fail per item, fail-needs-note), `due_on`/`days_late` snapshot, compliance %, reminder sweep
service (`runMaintenanceReminders`, manual-trigger endpoint).
**Exit check (`06-maintenance.test.js`, 9 tests):** due board classification at exact boundaries
(0/1 days), completing PM flips 🟡→🟢 and updates equipment next-due in one tx, checklist required
notes enforced, compliance math on a hand-built fixture, reminders idempotent (run twice, no
duplicates).
**Caught:** unscheduled equipment initially fell out of the board — added the fourth ⚪ state the
brief implies (“everything listed”, not just scheduled items).

## Phase 9 — Risk, dashboard, notifications

Transparent factor-based scoring (7 factors, raw 0–135 → 0–100, bands, escalations, per-factor
contributions, disclaimer on every payload), role-aware dashboard aggregation, in-app notification
fan-out on the 8 lifecycle events + delivery rows (`sent/skipped`) per channel.
**Exit check (`07-risk.test.js` 6, `08-notifications.test.js` 6):** score recomputes identically
for the same data (pure function; property test over seeds), band boundaries, life-support +
overdue-PM escalation, `risk/model` matches code weights (anti-drift test), reporter payload has
no factor arithmetic; notification recipients = capability-holders (critical → all techs+admins),
read-state per user, prune keeps read > 90d only.

## Phase 10 — Reports/exports, client SPA, mobile pass, hardening sweep

8 reports + CSV (BOM/CRLF/formula-safe) + print view; the full 19-screen client; audit query UI;
final security tests.
**Exit check (`09-reports.test.js` 8, `10-security.test.js` 13):** every report renders JSON+CSV+
print 200 as admin and 403 as reporter; CSV re-imports to a spreadsheet with a leading `'` on the
formula cell; traversal (`/attachments/../../etc/passwd` shapes) → 404; oversized upload 413;
1000-char field 400; SQLi probes in `q` return data, not errors; audit covers login failures.
Client: `client/test/render.test.mjs` boots a jsdom app against **recorded fixtures** and renders
all 20 screen-states at 1440 px **and** 390 px (42 assertions incl. empty/error/forced-change).
**Caught:** two crash-class bugs (undefined-array map in WorkQueue empty state; `toLocaleDate` on
null acquisition date) and one responsive bug (bottom tab bar overlapping the FAB at ≤ 400 px) —
all found by the mobile pass only.

## Regression discipline

After every phase: `npm test` (server then client), `node scripts/lint.mjs`, `npx vite build`,
plus the manual pass the brief asked for — click the flow as each of the three roles, one mobile
viewport, one seeded-DB reset. Final: fresh-clone rehearsal (`npm install && npm run migrate &&
npm run seed && npm test` from an empty DB) — see TESTING.md.
