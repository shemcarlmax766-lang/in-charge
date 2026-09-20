# Testing — BEM-FRS

Two suites, zero extra infra: **Node's built-in test runner** (`node --test`) on the server, a
**jsdom render harness** on the client. No Jest, no Cypress, no Docker — deliberately: the whole
thing must run on the reviewer's laptop in seconds.

```bash
npm test              # server (103) then client (48) — the same command used after every phase
npm run test:server   # node --test server/test/*.test.js against an ephemeral DB
npm run test:client   # builds the SPA bundle, renders 20 screen-states × 2 viewports
npm run lint          # scripts/lint.mjs (secrets/SQL/XSS/env-docs structural checks)
```

## 1. Server suite (103 tests, ~5 s)

`server/test/helpers.js` boots the real Express app against a **fresh file-backed SQLite DB per
suite file** (migrations applied, not mocks), seeds a tiny deterministic fixture (3 users — one
per role — plus equipment/fault scaffolding), and exposes `api(method, path, {as, body, form})`
which handles cookie+CSRF and returns `{status, json, headers}`. `--test-force-exit` guards
against stray timers; `NODE_ENV=test` relaxes rate limits (`RATE_MAX=100k`) so lockout tests
drive the *account* limiter directly instead of the IP one.

| File | Tests | Covers (brief → test) |
| --- | --- | --- |
| `01-auth.test.js` | 11 | login issues revocable session + CSRF token; scrypt hash in DB, never the password; uniform 401 (wrong pw / unknown / malformed); lockout after N + expiry; deactivated account; logout revokes immediately; cookie writes need CSRF, Bearer exempt; policy-enforced password change signs out other devices; session list + individual revoke |
| `02-rbac.test.js` | 8 | endpoint × role matrix sample on every guarded surface; 403 carries capability hint; reporter sees only own faults *on list and detail*; technician cannot reach admin routes and vice-versa (least-privilege both directions); `requireCap` OR-semantics for self-assign |
| `03-equipment.test.js` | 11 | CRUD + validation (lengths, enums, dates, unknown fields rejected); serial/tag uniqueness → 409; auto asset tag per category; search+filter+sort equivalence; status change writes history w/ comment; operational blocked while fault open; deactivate/refuse-with-open-fault; delete blocked with history; QR PNG/SVG decode to `/e/<tag>`; labels endpoint; image upload + magic-byte spoof rejection |
| `04-faults.test.js` | 9 | multipart create with photos; every legal transition walks to next state + writes history (user, time, from, to, comment); illegal edges 400/409 w/ `allowedNext`; reporter blocked from technical stages w/ explanatory 403; assign (admin) vs self-assign (tech, unassigned only); edit window closes after triage; reopen path + audit; SLA `due_at` from severity table; verify-by-reporter allowed, close-after-verify required |
| `05-repairs.test.js` | 6 | only assigned tech (or admin) writes; readiness gate (incomplete → cannot mark Repaired→Verified→operational); cost totals recomputed server-side (client `totalCost` ignored); part rows validated against catalogue; before/after photo kinds; calibration fields persist |
| `06-maintenance.test.js` | 9 | schedule CRUD + checklist; due-board classification exactly at 🟢/🟡/🔴 boundaries incl. unscheduled; record completion advances schedule + equipment roll-up in one tx; fail-item requires note; `due_on`/`days_late` snapshot immutability; compliance % math; reminders sweep idempotent; reporter 403 on all of it |
| `07-risk.test.js` | 6 | score is pure & deterministic (same data → same points); factor contributions sum to raw; band boundaries 29/30, 59/60; life-support escalation rule; payload always has `disclaimer` + `contributing[]`; reporter variant omits arithmetic internals |
| `08-notifications.test.js` | 6 | lifecycle events fan out to the right recipients (critical → techs+admins); read/unread/prune; delivery rows `sent` vs `skipped` per channel config; notifications link to viewable entities; no cross-user reads |
| `09-reports.test.js` | 8 | all 8 reports × JSON/CSV/print; CSV = BOM + CRLF + formula-prefixed `'` + proper quoting; date-range params; audit report admin-only; row counts match seeded reality |
| `10-security.test.js` | 13 | traversal on attachment/ids paths; oversized upload 413; oversize body 413; SQLi/XSS probes in `q`/notes return normal data; MIME spoof; rate limit 429 + Retry-After; no stack/path leakage in 500-path errors; `X-Frame-Options`/CSP/`nosniff` present; CSRF header required; public endpoints leak nothing beyond profile; audit covers failed logins |
| `11-recovery.test.js` | 16 | self-registration: reporter-only hard-wire, 403s after, duplicate 409, policy 400 w/ field errors, audit row + admin fan-out, cookie-without-CSRF rejected on public POST; recovery: identical 202 known/unknown, hash-only storage, outbox artifact carries the revealed code, throttle, 5-attempt burn, policy-before-burn ordering, supersession, expiry, session revocation + lockout clear on success, disabled accounts, redemptions indistinguishable, reveal fields on `/auth/policy` |

## 2. Client render harness (48 tests)

The sandbox has no Playwright/CDP browser (CDN unreachable — recorded in the build log), so the
client is verified with a **record-and-replay** approach that still exercises the real code path:

1. `client/test/record-fixtures.mjs` runs against the live API (admin bearer) and records the
   JSON responses of every screen's endpoints into `client/test/fixtures.json`. The recording is
   **committed** (~2.4 MB of deterministic demo data) so a fresh clone can run the client suite
   with no server up; re-record it after any response-shape change while `npm run dev` is up.
2. `client/test/build.mjs` bundles the app for tests via Vite (same plugin chain) into a single
   classic script.
3. `client/test/render.test.mjs` boots **jsdom** (`runScripts: 'dangerously'`), monkey-patches
   `fetch` to serve the recorded fixtures, mounts the full router, and per screen-state asserts:
   key text renders, no console errors, no unhandled rejections — once at **1440 px** and once at
   **390 px** (23 states × 2 + boot/identity tests = 48 — including the three anonymous screens:
   sign-in, self-registration, recovery). Empty, error and forced-password-change
   variants are included.

This is what caught the crash-class bugs the desktop-only manual pass could not (null date
formatting, undefined list in the empty work queue, FAB overlapping the mobile tab bar).
Honest limits: no real layout engine, no camera, no CSS cascade assertions — layout is reviewed
visually in the preview; the harness guarantees *no runtime errors and correct data wiring*.

## 3. Manual test script per role (also the acceptance walk-through)

* **Reporter:** scan QR → `/e/TAG` → report with photo → see it in My reports → comment → get
  notified on assignment → confirm fix at verification.
* **Technician:** work queue → self-assign → acknowledge → inspect → repair record (diagnosis,
  parts, costs, tests, calibration, before/after photos) → mark repaired → verify → close; run a
  PM (checklist incl. a forced note on fail); see own due-board.
* **Admin:** create equipment (validation + duplicate serial), edit reference data, reassign,
  reopen, print QR label sheet, all 8 reports (CSV + print-to-PDF), audit trail for the fault
  including its failed-login neighbours, settings changes, notifications prune + reminders.
* **Mobile pass:** phone-size viewport (390 px): every screen reachable, scanner flow (with
  manual fallback when the camera is denied), tab bar + FAB clearance, print stylesheet preview.

## 4. Fresh-clone rehearsal (release gate)

```bash
git clone <repo> && cd in-charge && npm install
npm run migrate && npm run seed      # prints the fictional-data banner + one-off password
npm test                             # 87 + 42 green
node scripts/lint.mjs                # 0 findings
```

DB is disposable (`npm run reset`); `.env` is not needed for this path (safe defaults).
