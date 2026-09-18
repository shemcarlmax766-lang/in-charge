# System Architecture — Biomedical Equipment Maintenance & Fault Reporting System (BEM-FRS)

> A departmental system for a Medical / Biomedical Engineering department.
> Scope: equipment inventory, fault reporting, technician repair workflow, preventive maintenance,
> analytics and rule-based maintenance-risk decision support.
> **Out of scope by design:** patient diagnosis, patient treatment advice, clinical safety clearance of
> equipment. See [SAFETY.md](SAFETY.md).

## 1. High-level topology

```
┌──────────────────────────── Browser (desktop / mobile / tablet) ────────────────────────────┐
│  React SPA (Vite)                                                                            │
│  ┌──────────┐ ┌───────────────┐ ┌──────────┐ ┌────────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Auth /   │ │ Equipment     │ │ Fault    │ │ WorkQueue  │ │ PM /     │ │ Dashboard /   │  │
│  │ Roles    │ │ inventory+QR  │ │ reporter │ │ + repair   │ │ Schedules│ │ Reports/Risk  │  │
│  └──────────┘ └───────────────┘ └──────────┘ └────────────┘ └──────────┘ └───────────────┘  │
│        Camera QR decode (BarcodeDetector → jsQR fallback) · PWA-style mobile-first forms    │
└───────────────────────────────────────┬────────────────────────────────────────────────────┘
                                        │  same-origin HTTPS in production:  /api/v1/**  (JSON + multipart)
                                        ▼
                        ┌───────────────────────────────────────┐
                        │  Node.js 22 API server (Express 5)    │
                        │                                        │
                        │  middleware: security → rateLimit →   │
                        │  authenticate → requireRole →         │
                        │  validate(body/query) → route         │
                        │                                        │
                        │  services (business logic):           │
                        │   equipment · fault (state machine) · │
                        │   repair · maintenance · risk ·       │
                        │   dashboard · notification · report ·│
                        │   user · meta                         │
                        │                                        │
                        │  lib: db adapter · tokens · password  │
                        │  (scrypt) · validate · audit · qr ·   │
                        │  csv · files                          │
                        └───────┬───────────────────────┬───────┘
                                │                       │
                    ┌───────────▼──────────┐  ┌─────────▼──────────────┐
                    │ SQLite (node:sqlite) │  │ Local object store      │
                    │ data/bmems.sqlite    │  │ data/uploads/YYYY-MM/*  │
                    │ WAL · FK on · txns   │  │ (photos, PDFs, docs)    │
                    └──────────────────────┘  └─────────────────────────┘
```

There is **no second runtime and no external service** required to run the department today.
Every integration point that would need one (email, SMS, push, SSO, shared object storage) is a
**port** with a no-op adapter — see §6.

## 2. Process model

| Process | Purpose | Port (dev) |
| --- | --- | --- |
| `server` | API + (in production) static SPA hosting + uploaded-file streaming | `4000` |
| `client` (dev) | Vite dev server with HMR, proxies `/api` → API | `5173` |
| `client` (prod) | `vite build` → `client/dist`, served by the API process from one origin | same as API |

Single-origin serving in production is deliberate: it removes CORS, keeps the session cookie
`SameSite=Lax`/`HttpOnly`, and lets the QR code contain a URL that works from any device on the LAN.

## 3. Layering rules (enforced by review, mirrored in tests)

1. **Routes** do: HTTP parsing, auth/role guards, input validation, calling **one** service, shaping the response.
   No SQL, no business rules.
2. **Services** own business rules, transactions, status machines, audit writes and notification fan-out.
   They are framework-free (no `req`/`res`), so they are directly unit-testable.
3. **Repositories/SQL** live inside services but only via `db` helpers with bound parameters.
   No string-concatenated SQL anywhere — see [SECURITY.md](SECURITY.md#sql-injection).
4. **libs** are pure, dependency-light, and side-effect free (tokens, password hashing, validation, CSV, QR).
5. **Client** never computes authority. It *reads* the capability map from `GET /api/v1/auth/me` to show/hide
   controls, and the server re-checks every capability. `client/src/auth` is UX, not security.

## 4. Data stores

* **SQLite** (WAL) for all relational state. Chosen because a school department runs this on one box
  (or a Raspberry-Pi-class server) with zero DBA cost, while still giving real ACID transactions,
  foreign keys, and indexes. `node:sqlite` is used so there is **no native module to compile** —
  install failures are the #1 way projects like this die at handover.
* **Filesystem object store** for uploads, keyed by a random name; DB stores metadata + SHA-256 only.
* No cache tier. The heaviest dashboard query is a few hundred rows; `EXPLAIN`-level work instead.

`db/driver.js` isolates the SQLite client behind ~6 functions (`all`, `get`, `run`, `tx`, `migrate`,
`raw`) so the driver can be swapped for Postgres/`better-sqlite3` without touching services.

## 5. Request lifecycle (example: reporter submits a fault)

```
POST /api/v1/faults  (multipart: fields + ≤5 photos)
 1. securityHeaders          → CSP / no-sniff / frame-deny / HSTS-if-TLS
 2. rateLimit                → 20/min/IP on write endpoints, 409 on excess
 3. authenticate             → session token (httpOnly cookie or Bearer) → req.user, req.session
 4. csrfGuard                → cookie-authenticated writes must echo X-BM-CSRF
 5. requireRole('reporter','technician','admin')   (any authenticated user may report)
 6. validateFaultCreate      → types, lengths, enum values, date sanity  → 422 with field map
 7. uploadFiles              → per-file MIME sniff vs extension, ≤8 MiB, image/pdf only
 8. faultService.create(req) → TRANSACTION:
        insert fault_reports (reference FLT-YYYY-NNNN)
        insert fault_status_history (NULL → reported)
        derive + update equipment.status (reported_fault) + equipment_status_history
        insert attachments rows (owner_type='fault_report')
        insert audit_logs (action=fault.create)
        notify: admins + technicians if severity=critical; assigned tech if any
 9. response 201 {fault, notificationsCreated}
```

Failure anywhere before step 8's commit rolls the whole unit back — a fault is never half-written
(e.g. photos saved but no audit row).

## 6. Ports & adapters (future integrations, already wired)

| Port | Default adapter | Swap-in |
| --- | --- | --- |
| `notify.DeliveryChannel` | `in_app` (writes `notification_deliveries` rows) | SMTP, Twilio SMS, FCM/web-push |
| `storage.ObjectStore` | local disk under `data/uploads` | S3-compatible bucket |
| `auth.IdentityProvider` | local users + scrypt passwords | LDAP/AD or OIDC for school SSO |
| `clock` | system clock | injectable in tests for date-dependent logic (PM due, risk) |
| `idgen` | per-year sequence from DB | — |

`notificationService` fans out to every channel registered in `config.notifyChannels`; unconfigured
channels are recorded as `skipped` with a reason, so the audit trail is complete even in phase 9.

## 7. Time, ids and references

* All timestamps **UTC ISO-8601 with seconds** (`2026-09-13T07:15:00Z`); the client renders local time.
* Date-only fields (acquisition, warranty, maintenance days) are `YYYY-MM-DD` to avoid timezone drift.
* Human references are minted server-side and immutable: `BMU-<CAT>-<NNNN>` (asset tag),
  `FLT-<year>-<NNNN>` (fault), `PM-<year>-<NNNN>` (maintenance), `RPR-<year>-<NNNN>` (repair).
* Numeric primary keys stay internal; the API exposes both `id` and `reference`/`assetTag`.

## 8. Non-goals (stated so they are not mistaken for omissions)

Real-time chat between technicians, spare-part purchasing/stock reordering, calibration lab
certificate workflow, multi-site replication, offline-first PWA sync, patient/equipment-usage
interfacing, and anything that would make the software a medical device. Each is a separate project
with its own regulatory surface.
