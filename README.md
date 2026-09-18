# BEM-FRS — Biomedical Equipment Maintenance & Fault Reporting System

A complete, role-based departmental system for a Medical / Biomedical Engineering department:
equipment inventory with scannable QR codes, a 9-state fault workflow with a full audit trail,
technician repair records, preventive maintenance with a 🟢/🟡/🔴 due-board, dashboards,
rule-based maintenance-risk decision support, admin reports with CSV / print-to-PDF export, and
an in-app notification centre with an honest per-channel delivery ledger.

> **Safety boundary (by design):** this system manages *equipment maintenance workflow*. It never
> diagnoses patients, never diagnoses equipment faults on your behalf, and never certifies that
> equipment is safe to use. The risk score is transparent, rule-based decision support for
> qualified staff — [docs/SAFETY.md](docs/SAFETY.md) states the boundary and where it is enforced.

All demo data is **fictional** (invented staff, students, equipment and faults) and labelled as
such by the seeder.

## Quick start

```bash
npm install          # Node ≥ 22.5 (uses the built-in node:sqlite — no native builds, no DB server)
npm run dev          # API :4000  +  Vite SPA :5173 (proxies /api)
```

First boot on an empty `data/` directory runs migrations and installs the fictional demo fleet.
Full gate: `npm test` (87 server + 42 client tests) and `npm run lint`. Against a deployed
instance, `SMOKE_PASSWORD=… npm run smoke -- --base https://your-host` runs 31 read-only checks
(auth, RBAC negatives, the public QR contract, exports, the PWA surface).

### Demo accounts

All demo users share the password `Demo-Access-2026` (set `SEED_PASSWORD` before `npm run seed`
to choose another; unset, the seeder generates one and prints it once — it is never committed).

| Role | Sign in with |
| --- | --- |
| Administrator | `a.okonkwo@sthospital-training.edu` |
| Technician / Biomedical Engineer | `g.mbeki@sthospital-training.edu` |
| Student / Staff Reporter | `p.nair@student.sthospital-training.edu` |

Sign in as each to see the same system with genuinely different powers — capability-based RBAC
is enforced server-side, not just in the UI.

## What you can do in 5 minutes

1. **Scan like a student:** open `/e/BMU-ECG-0001` (what every printed label points at) — a
   minimal public equipment card with a “Report a fault” flow. Attach a photo, pick severity, submit.
2. **Triage like an engineer:** `/work` → claim the fault → inspect → record the repair
   (diagnosis, root cause, parts with costs, test results, calibration, before/after photos) →
   mark repaired. Try to skip the repair record and “return to service” — the state machine
   refuses, with the reason.
3. **Close the loop:** verify, close, then open the equipment page: fault history, status
   timeline (who/when/from/to/comment for every move), PM state and the transparent risk panel
   side by side.
4. **Report like an admin:** `/reports` → any of 8 reports → CSV download or the print-to-PDF
   view; `/audit` shows every mutation including your own, and a `maintenance_due` sweep is one
   click.

## Architecture in four lines

* **Server** — Node 22 + Express 5, layered `routes → services → lib`, business rules in
  services (state machine, risk model, downtime math), zero ORM: parameterised SQL against
  `node:sqlite` through a ~200-line adapter. 24 normalised tables, 43 FKs, 56 indexes.
* **Client** — React 18 + Vite, no component/chart libraries: a token-based CSS design system,
  hand-rolled accessible SVG charts, camera QR scanning with a manual fallback, mobile-first for
  the at-the-bedside reporting flow.
* **Auth** — scrypt password hashing, opaque revocable sessions (cookie **or** bearer), CSRF
  header for cookie writes, capability-matrix RBAC, audit-everything.
* **Storage** — SQLite file + local-disk uploads; relational data lives in columns and FKs, never
  in text blobs.

Docs: [ARCHITECTURE](docs/ARCHITECTURE.md) ·
[API](docs/API.md) · [DATABASE](docs/DATABASE.md) · [SECURITY](docs/SECURITY.md) ·
[UI](docs/UI.md) · [SAFETY](docs/SAFETY.md) · [REPORTS](docs/REPORTS.md) ·
[INTEGRATIONS](docs/INTEGRATIONS.md) · [TESTING](docs/TESTING.md) ·
[OPERATIONS](docs/OPERATIONS.md) · [MOBILE](docs/MOBILE.md) ·
[PHASES](docs/PHASES.md) · [FAILURE-POINTS](docs/FAILURE-POINTS.md)

## Layout

```
server/src/
  config/            .env loader + assertConfig (no hard-coded secrets, ever)
  auth/              capability matrix (single source of truth for RBAC)
  middleware/        auth/CSRF, security headers + rate limiters, error handler
  routes/            thin HTTP layer: parse → validate → call service
  services/          business logic: equipment, fault state machine, repairs,
                     maintenance, risk, dashboard, reports, notifications, users, meta
  lib/               sqlite adapter + migrations, validate DSL, scrypt, tokens,
                     files (magic-byte sniffing), csv, qr, audit
  db/                001_init.sql (24 tables) · seed.js (deterministic FICTIONAL fleet)
client/src/
  api/ auth/         fetch client (CSRF, errors, abort) · AuthContext
  components/        ui (primitives) · display (DataTable, Timeline…) · charts (SVG) ·
                     AppShell · QrScanner · FileInput · Toast
  pages/             19 screens — see docs/UI.md for the map
  styles/app.css     tokens, breakpoints, print styles
scripts/lint.mjs     dependency-light security/hygiene gate (npm run lint)
docs/                the design documents this project was built from
```

## Running without the SPA dev server

```bash
npm run build && npm run start    # one process serves API + built SPA on :4000 (prod shape)
npm run reset                     # drop + re-migrate + re-seed (dev convenience)
npm run test                      # full suite: server 87, client 42 (~1 min, no infra)
npm run smoke -- --base URL       # live-environment check (SMOKE_PASSWORD env, nothing stored)
```

Phones can **install** the app (PWA manifest + icons; a production-only service worker caches
the shell but is forbidden from touching `/api/**` — an offline queue that silently swallows a
fault report would be worse than a visible error, so there isn't one). For real app stores there
are **Capacitor shells** committed under `client/android` and `client/ios` — build the APK with
`npm run android:apk` (Android Studio toolchain) and test everything locally, phone + laptop on
one Wi-Fi, with the playbook in [docs/MOBILE.md](docs/MOBILE.md).

Deployment notes (systemd, TLS, backups, upgrade ladder) — [docs/OPERATIONS.md](docs/OPERATIONS.md).
