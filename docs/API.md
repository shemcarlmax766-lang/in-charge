# API Reference — BEM-FRS

Base path: **`/api/v1`** (JSON; file uploads are `multipart/form-data`).
In production the API also serves the built SPA from the same origin; in development the Vite
server proxies `/api` to port 4000.

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Auth | Opaque session token. `POST /auth/login` sets an `httpOnly` `SameSite=Lax` cookie **and** returns a `token` for `Authorization: Bearer <token>`. Either works; cookie clients must also send the CSRF header (below). |
| CSRF | Any *cookie-authenticated* write (`POST`/`PATCH`/`PUT`/`DELETE`) must send `X-BM-CSRF: <csrfToken>` (the value from `GET /auth/me`). Missing/wrong → `403`. Bearer requests are exempt (no ambient credential). |
| Errors | `{ "error": { "code", "message", ...details } }`. Codes: `validation` (400/422), `unauthorized` (401), `forbidden` (403, always carries a plain-language `hint`), `not_found` (404), `conflict` (409), `rate_limited` (429), `too_large` (413), `server` (500, message never leaks internals). |
| Pagination | `?page=1&pageSize=25` (max `MAX_PAGE_SIZE`, default 25, 100). List responses: `{ items, page, pageSize, total, totalPages }`. |
| Sorting | `?sort=<field>&dir=asc|desc`; fields are whitelisted per endpoint (`SORTABLE` maps) — unknown fields fall back to the default rather than reaching SQL. |
| Dates | ISO-8601 UTC strings (`2026-09-14T09:00:00Z`). Client renders in local time. |
| Naming | DB columns are `snake_case`; the API layer serialises to `camelCase` (`lib/shape.js`) and accepts `camelCase` on input. |
| Rate limits | 300 req/min general, 60 writes/min, 12 login attempts/min per client (all configurable). 429 + `Retry-After`. |

## 2. Auth — `/auth`

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| POST | `/login` | public | `{email, password, rememberMe?}`. 401 on bad credentials (generic message); lockout after `MAX_FAILED_LOGIN_ATTEMPTS` for `LOGIN_LOCKOUT_MINUTES`. Sets session cookie + returns `{user, token, csrfToken}`. |
| POST | `/logout` | auth | Clears server-side session and cookie. |
| GET | `/me` | auth | Current user + `capabilities[]` (client renders from this) + `csrfToken`. |
| POST | `/change-password` | auth | `{currentPassword, newPassword}`; enforces policy from `/auth/policy`; revokes all *other* sessions. |
| GET | `/sessions` | auth | Active sessions (device/UA, IP, last-seen) for the current user. |
| DELETE | `/sessions/:id` | auth | Revoke one of your own sessions. |
| POST | `/sessions/revoke-all` | auth | Sign out everywhere (keeps the calling session). |
| GET | `/policy` | public | Password policy for form hints (min length, scrypt strength label). |

## 3. Users — `/users` (admin; `user.view` for technicians)

`GET /` (list, filter by role/search) · `GET /lookup` (assignee picklist — technician/admin only, minimal fields) · `GET /password-strength` (admin helper) · `GET /:id` (`user.view`) · `POST /` (create; `mustChangePassword` defaults true) · `PATCH /:id` (role, active flag, profile) · `POST /:id/reset-password` (admin sets temporary password; forces change on next login) · `POST /:id/sign-out` · `DELETE /:id` (soft-deactivate; hard delete only if the user has no history).

## 4. Equipment — `/equipment`

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| GET | `/` | auth (`equipment.view.all` for cross-department) | Search `q` (tag, name, serial, manufacturer, model) + filters: `status`, `categoryId`, `locationId`, `assignedTo`, `criticality`, `needsMaintenance`, `underWarranty`. |
| GET | `/vocabulary` | auth | Status list with labels/tones/ranks and allowed transitions. |
| GET | `/needs-attention` | auth | Compact list powering dashboard/alert badges. |
| POST | `/labels` | `equipment.qr` | `{ids:[...]}` → print sheet (asset tag, name, QR as data-URI PNG). |
| GET | `/:id` | `equipment.view` | Full record: category, location, assignee, warranty, open fault count, current risk band, latest PM. |
| GET | `/:id/qr.png` · `/:id/qr.svg` | `equipment.view` | QR encoding `{PUBLIC_BASE_URL|origin}/e/<assetTag>`. PNG for printing, SVG for previews. |
| GET | `/:id/history` | `equipment.view` | Fused timeline: fault lifecycle + status changes + PM + repairs, newest first. |
| POST | `/` | `equipment.create` | All fields validated (`lib/validate.js`); `assetTag` auto-generated from `id_sequences` per category prefix when omitted; unique serial/tag enforced → 409. |
| PATCH | `/:id` | `equipment.update` | Partial update; every change audited. Status **cannot** be changed here (see next row). |
| POST | `/:id/status` | `equipment.status.set` | Only `equipment.*` vocabulary; comment optional; writes `equipment_status_history`. Cannot set `operational` while an open fault exists (409). |
| POST | `/:id/image` | `equipment.image` | Multipart `file`; image policy only; replaces previous hero image. |
| DELETE | `/:id/image` | `equipment.image` | |
| POST | `/:id/deactivate` · `/:id/activate` | `equipment.deactivate` | Soft retirement (admin only); open faults block deactivation. |
| DELETE | `/:id` | `equipment.delete` | Hard delete only when there is zero history (auditability). Otherwise 409 → deactivate. |

Status vocabulary (7): `operational`, `reported_fault`, `under_inspection`, `under_repair`,
`awaiting_parts`, `out_of_service`, `decommissioned`.

## 5. Fault reports — `/faults`

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| GET | `/` | role-scoped list | Reporters see own (`fault.view.own`); technicians/admins any. Filters: `status`, `severity`, `categoryId`, `equipmentId`, `assignedTo`, `from`, `to`, `q`. |
| GET | `/vocabulary` | auth | Statuses, severities, transition matrix, per-role allowed actions. |
| POST | `/` | `fault.create` | Multipart: `equipmentId`, `categoryCode`, `severity`, `title`, `description`, optional `files[]` photos. Severity `critical` notifies all technicians immediately. |
| GET | `/:id` | viewer or reporter-of | Includes status history, notes, attachments, repair record (if any), readiness report. |
| PATCH | `/:id` | reporter (own, only while `reported`/`assigned`) or `fault.transition.manage` | Reporters may correct their description *before triage only*. Never the workflow state, severity or assignment. |
| POST | `/:id/assign` | `fault.assign` (admin) or `fault.selfAssign` (tech, unassigned only) | `{userId?, note?}`; sets status `assigned`; techs can unassign their own (`{userId: null}`). |
| POST | `/:id/transition` | per-state rules | `{to, comment?}`. Server-side state machine (see below); every move writes `fault_status_history` (user, time, from, to, comment). Equipment status mirrors the fault stage; `repaired`+complete-repair is required before the equipment can return to `operational`. |
| POST | `/:id/notes` | participants | Follow-up notes from anyone allowed to view (reporters can add observations, not triage decisions). |
| POST | `/:id/reopen` | `fault.reopen` (admin) / reporter-of can request via note | Only from `closed`; audited with reason. |
| POST | `/:id/attachments` | participants | Multipart `files[]`, up to `MAX_UPLOAD_FILES`. |
| GET | `/:id/repair` | viewer of fault | Full repair record incl. parts and before/after photos. |
| PUT | `/:id/repair` | `repair.write` + assigned tech | Upsert diagnosis/root cause/troubleshooting/repair action/test results/calibration/parts list/costs. Validation of part rows against `replacement_parts`. |
| GET | `/:id/repair/readiness` | participants | Why close/reopen is allowed or blocked — `{allowed, missing:[...]}`. |
| POST | `/:id/repair/photos` | `repair.write` | Before/after evidence photos with `kind` tag. |

**Workflow** (9 states; skipping forward is allowed, arbitrary entry is not):

```
reported ─┬→ assigned ─┬→ acknowledged ─┐
          │            ├→ under_inspection ──┐
          │            └→ under_repair ──┐   │
          ├→ acknowledged                 ▼   ▼
          ├→ under_inspection → under_repair ⇄ awaiting_parts
          └→ closed (only as admin triage: duplicate / not a fault)
under_inspection → repaired → verified → closed
under_repair     → repaired ┘          ↘ under_repair (verification failed)
awaiting_parts   → repaired / under_repair;  repaired → under_repair (found more)
repaired → verified only after repair record complete (readiness gate)
closed: no outgoing transitions except audited /reopen
```

Stage guard: `under_inspection`, `under_repair`, `awaiting_parts`, `repaired` are
**technician stages** — a reporter request to move there is a 403 with an explanatory hint
(“report what you observe and an administrator will assign someone”). `assigned → …` stages
require an assignee (`STAGES_REQUIRING_ASSIGNMENT`). Closing a fault that saw work requires
`repaired → verified → closed`; closing an unworked report as a duplicate is admin-only.

## 6. Maintenance — `/maintenance`

`GET /vocabulary` · `GET /schedules` (paged, filter by category/owner/enabled) · `GET /schedules/:id`
(checklist items) · `POST /schedules` / `PATCH /schedules/:id` (`maintenance.schedule.manage`) ·
`DELETE /schedules/:id` (`meta.manage`, soft) · `GET /due-board` (per equipment: status
🟢 up-to-date / 🟡 due-soon (≤`due_soon_days`) / 🔴 overdue / ⚪ unscheduled; filter + search) ·
`GET /records` (history; `maintenance.record.view.any` or own) · `GET /records/:id` (with checklist results) ·
`POST /records` / `POST /schedules/:id/complete` (`maintenance.record.write`) — records `performedAt`,
`durationMinutes`, `condition`, `findings`, `nextDueOn`, checklist item results (pass/fail/n_a + note);
completing a record updates equipment `last_maintenance_at`, clears overdue state, notifies owner.
`GET /compliance?from&to` (% completed on time per schedule, trend) · `POST /reminders` (`meta.manage` —
manual run of the due-soon/overdue notification sweep; also idempotent).

## 7. Notifications — `/notifications`

`GET /` (own, filter `unread`) · `GET /unread-count` (badge) · `POST /read` `{ids?|all}` ·
`DELETE /:id` (dismiss) · `GET /:id/deliveries` (delivery audit incl. `skipped` channels) ·
`POST /prune` (admin). In-app is always live; email/SMS/push record a delivery row per
config — see [INTEGRATIONS.md](INTEGRATIONS.md).

## 8. Dashboard & risk — `/dashboard`

* `GET /` — role-aware KPIs (fleet counts, open/critical faults, MTTR, downtime, compliance,
  due-board mix, top failures, faults-by-month/category), `scope: department|personal`.
* `GET /risk` — fleet risk table (sorted, filterable) for `risk.view`; reporters get a
  `risk.view.summary`-level list (band only, no factor maths for non-participants).
* `GET /risk/model` — the transparent model: factor list, weights, bands, escalation rules.
* `GET /risk/:equipmentId` — score, band, `contributing[]` per factor, `advice[]`, `rawScore`,
  and the always-present `disclaimer`. Rule-based decision support — see [SAFETY.md](SAFETY.md).

## 9. Reports — `/reports` (data + exports: `report.generate` / `export.data`)

`GET /` (catalogue — titles/descriptions, authed staff; informational, intentionally ungated) ·
`GET /:key?from&to&format=json` · `GET /export/:key/csv` (UTF-8 BOM,
CRLF, formula-injection neutralised) · `GET /export/:key/print` (self-contained HTML with
`window.print()` — print-to-PDF from the browser). Keys: `inventory`, `faults`, `maintenance`,
`costs`, `downtime`, `failures`, `compliance`, `audit`. Columns and parameters:
[REPORTS.md](REPORTS.md).

## 10. Reference data, parts, audit — `/reference`, `/parts`, `/audit`

* `/reference/picklists` — everything forms need in one call (categories, locations, fault
  categories, technicians, settings).
* `/reference/{categories|locations|fault-categories}` — CRUD (`meta.manage` for writes);
  `POST/PATCH/DELETE` with referential guards (deleting a category in use → 409).
* `/reference/settings` — GET for authed users (public-safe subset), PATCH for `settings.manage`
  (SLA hours, due-soon window, currency, institution strings).
* `/parts` — replacement-parts catalogue (GET authed; POST `meta.manage`) incl. `in_stock` and
  `unit_cost`; price history intentionally out of scope.
* `/audit` — admin-only audit log query: `actorId`, `action`, `entity`, `from`, `to`, `q`;
  JSON snapshot per row; retained indefinitely (prune via DB maintenance, see OPERATIONS).

## 11. Attachments — `/attachments`

`GET /:id` — bytes with `Content-Disposition`, only after a permission check that links the
attachment to something you may see (fault participant / equipment `equipment.view`).
`GET /:id/meta` — name/size/type/sha256. `DELETE /:id` — uploader or admin, while allowed by
the parent record's state. Files are never served by URL; there is no public path.

## 12. Public — `/public` (rate-limited, no auth)

* `GET /config` — institution name, logo text, whether SSO/QR-reporting are on. Used by the
  QR landing screen before login.
* `GET /equipment/:tag` — minimal safe profile (tag, name, category, room, status, open-fault
  flag) for scanning a label; 404 for unknown tags; **no serials, no history, no contacts**.
* `GET /equipment/:tag/photo` — the hero image for the landing card (same visibility rule).

## 13. Health

`GET /api/health` (outside `/api/v1`) — unauthenticated: `{status, environment, counts}`.
Used by the boot banner and uptime checks; counts let an operator see seeding happened.
