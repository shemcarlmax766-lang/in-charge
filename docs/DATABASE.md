# Database — BEM-FRS

Engine: **SQLite** via Node 22's built-in `node:sqlite` (`server/src/lib/db.js`).
WAL journal, `foreign_keys=ON`, `busy_timeout=5000`. One writer at a time — right-sized for a
departmental deployment; see §6 for the upgrade path.

Totals: **24 tables · 266 columns · 43 foreign keys · 56 indexes · 54 CHECK constraints**
(single migration: `server/src/db/migrations/001_init.sql`).

## 1. Design rules applied

1. **Normalised, relational — not text blobs.** Equipment ↔ category ↔ location, fault ↔
   equipment ↔ reporter ↔ assignee, repair ↔ fault ↔ parts (junction table with per-part
   quantities), PM ↔ schedule ↔ checklist results are all real rows with FKs. Long free text
   (descriptions, findings) is the *only* thing stored as prose, next to its structured fields.
2. **Enums are enforced in the DB**, not just in JS: `CHECK (status IN (...))` on faults and
   equipment, severities, criticalities, roles of a few. A bad write fails at the engine.
3. **Append-only history.** `fault_status_history`, `equipment_status_history`, `audit_logs`
   have no UPDATE/DELETE paths in the application.
4. **Money and time are typed columns**: `*_cost REAL` + `currency` from settings; every
   timestamp is ISO-8601 UTC text (`TEXT` affinity) produced by `lib/time.js` — the same
   string format everywhere keeps SQLite comparisons lexicographic and correct.
5. **Human references** (`FR-…`, `RR-…`, `PM-…`, asset tags) are generated from `id_sequences`
   inside the same transaction as the row they label — collision-free, monotonic, printable.
## 2. Domain map

```
roles ──┐
        ├─ users ──── sessions
        │     │         └ csrf per session
        │     ├─ owns notifications ─── notification_deliveries (per channel, incl. skipped)
        │     └─ actor of ── audit_logs
equipment_categories ─┐
locations ────────────┼─ equipment ─── equipment_status_history
                      │      │
fault_categories ── fault_reports ── fault_status_history
                      │      └─ assigned_to → users
                      ├─ attachments (owner_type=fault)
                      └─ repair_records ── repair_parts ── replacement_parts
                                              └─ attachment refs (photos)
maintenance_schedules ── maintenance_checklist_items
        └─ maintenance_records ── maintenance_record_checklist → checklist items
app_settings · id_sequences · schema_migrations
```

## 3. Table notes (grouped)

### Identity & access
| Table | Purpose / notable columns |
| --- | --- |
| `roles` | 3 rows (admin, technician, reporter). Role *content* lives in code (`auth/capabilities.js`); the table exists for referential integrity. |
| `users` | `employee_id`, `email` (UNIQUE, lower), `password_hash` = self-describing scrypt string `scrypt$N$r$p$salt$hash`, `role_id → roles`, `is_active`, `must_change_password`, `failed_attempts`/`locked_until` (login lockout state), `deactivated_at/_by` (soft delete). |
| `sessions` | `token_hash` = SHA-256 of the 256-bit random token (the raw token is never stored), `csrf_token`, `ip`, `user_agent`, `expires_at`, `revoked_at`. Indexed on user/expiry for cheap revocation sweeps. |

### Inventory
| Table | Purpose |
| --- | --- |
| `equipment` | 30 columns: identity (`asset_tag` UNIQUE like `BMU-ECG-0001`, name, serial UNIQUE-when-set, manufacturer, model), placement (`category_id`, `location_id`, `department`), people (`custodian_user_id`, `responsible_technician_id`), lifecycle (`acquired_on`, `warranty_provider`, `warranty_expires_on`, `status` CHECK, `criticality` CHECK incl. `life_support`), maintenance roll-up (`maintenance_interval_days`, `last_maintenance_on`, `next_maintenance_on`), media (`image_filename`), audit (`created/_by`, `updated/_by`), retirement (`decommissioned_at`, `decommission_reason`), `qr_updated_at` (bumping this re-prints labels deliberately, not accidentally). |
| `equipment_status_history` | Every official status change: `equipment_id`, `from_status`, `to_status`, `changed_by`, `reason`. Same shape as the fault history on purpose. |
| `equipment_categories` / `locations` | Picklists with soft `is_active`; `locations` carries building/floor/room + UNIQUE(code). In use? delete → 409. |

### Fault workflow
| Table | Purpose |
| --- | --- |
| `fault_reports` | 25 columns covering the whole lifecycle: who (`reported_by`, `on_behalf_of`), what (`category_id`, `severity` CHECK, `observed_at`, title/description), triage (`status` CHECK(9), `assigned_to`, `assigned_by`, `assigned_at`, `due_at` — the SLA deadline), outcome (`acknowledged_at`, `repaired_at`, `verified_by`, `verified_at`, `closed_at`, `diagnosis_confirmed`, `resolution_note`). All stage timestamps live on the row; transitions additionally get history rows (§5). |
| `fault_status_history` | Append-only audit row per status change: `fault_id`, `from_status`, `to_status`, `changed_by`, `comment`, `changed_at`. Indexed by fault + time. |
| `fault_categories` | 9 rows (ELEC/MECH/SW/DISP/SENS/CBL/BAT/CAL/OTH) each with a `default_severity` hint used only to prefill the form. |

### Repairs
| Table | Purpose |
| --- | --- |
| `repair_records` | 1:1 with a fault (`fault_id UNIQUE`): technical fields (`diagnosis`, `root_cause`, `troubleshooting`, `repair_actions`, `test_results`), calibration (`calibration_performed` + details), money (`parts_cost`, `labour_cost`, `other_cost`, `total_cost` — total is recomputed server-side, never trusted from the client), safety flags (`safety_check_confirmed`, `safe_to_return_to_service` — technician attestation, see SAFETY.md), `date_repaired`. |
| `replacement_parts` | Catalogue: code UNIQUE, unit cost, `in_stock` (informational — no stock ledger by design). |
| `repair_parts` | Junction `repair_id × part_id` with `quantity`, `unit_cost`, `line_total`, optional free-text when a part isn't in the catalogue (still a row — not a blob). |

### Preventive maintenance
| Table | Purpose |
| --- | --- |
| `maintenance_schedules` | Per equipment: `interval_days` CHECK ≥1, `responsible_technician_id`, `next_due_on`, `last_done_on`, `is_active`. |
| `maintenance_checklist_items` | Ordered items per schedule (text + `requires_note_on_fail`). |
| `maintenance_records` | A completed PM run: `performed_on`, `duration_minutes`, `findings`, `actions_taken`, `condition_found` CHECK(pass/pass_with_notes/needs_attention/needs_repair/replaced), **`due_on` + `days_late`** — the due date is snapshotted at completion time so compliance never mutates retroactively. |
| `maintenance_record_checklist` | Pass/fail/n_a + note per item per record. |

### Platform
| Table | Purpose |
| --- | --- |
| `attachments` | One row per file: `owner_type/owner_id` (fault, repair, equipment), `kind` (report_photo / before_photo / after_photo / document), `stored_name` (random, opaque), `checksum` sha256, `size_bytes`, `mime_type`, `is_deleted`. Bytes live in `data/uploads/YYYY-MM/` — the DB never stores blobs. |
| `notifications` | In-app inbox: `type`, `title`, `body`, `link`, `severity`, entity back-ref, read state. |
| `notification_deliveries` | One row per (notification, channel) with status `sent`/`failed`/`skipped` + reason. The trail stays honest even with no SMTP/SMS provider wired. |
| `audit_logs` | Actor (id + role snapshot), `action`, `entity_type/id/ref`, human `summary`, `before_json`/`after_json` diff, ip, UA. Query endpoint `/audit` is admin-only. |
| `app_settings` | Typed settings (`sla_hours` JSON, `due_soon_days`, `currency`, institution strings…). GET for authed users, PATCH admin-only. |
| `id_sequences` | `(key, last_value)`, bumped with `UPDATE` + `SELECT` inside the insert transaction (`nextSequence`), `INSERT … ON CONFLICT DO NOTHING` to create on first use. |
| `schema_migrations` | Filename, applied_at, **sha256 checksum** — boot verifies re-hashes applied files and refuses to start on drift, so “edited after applying” is loud, not silent. |

## 4. Indexing strategy

Indexes exist because a query needs them, e.g.: `fault_reports(status)`, `fault_reports(equipment_id)`,
`fault_reports(assigned_to, status)` (the work queue), `equipment(category_id)`,
`equipment(location_id)`, `equipment(status)`, `equipment(next_maintenance_on)` (the due board),
`fault_status_history(fault_id, changed_at)` (timelines), `audit_logs(created_at)`,
`sessions(user_id)`, `attachments(owner_type, owner_id)`, plus UNIQUEs (`asset_tag`,
`serial_number`, `email`, `code` columns, `repair_records.fault_id`). `EXPLAIN QUERY PLAN`
on every list endpoint shows index usage, no temp b-trees at demo scale (168 items, 52 faults).

## 5. Why history rows *and* timestamp columns

`fault_reports.repaired_at` (etc.) answers “when did the repair finish?” in one read for every
dashboard/chart; `fault_status_history` answers “what exactly happened, in order, by whom,
with what comment?”. The pair is denormalised on purpose: the timestamps are written in the same
transaction as the history row by the single `transitionFault()` service function, so they
cannot disagree — and no route is allowed to update either except through it.

## 6. Migrations & growth

* `npm run migrate` applies `NNN_name.sql` in order, records the checksum, is idempotent.
* `001_init.sql` is the whole baseline. New migrations append (`002_…sql`) — editing an applied
  file trips the checksum guard on boot (by design); locally use `npm run reset && npm run seed`.
* Scale ceiling is the single-writer model: WAL handles dozens of concurrent readers + a burst
  of writers comfortably. If the department grows to multiple sites, the adapter in
  `lib/db.js` (prepare/run/all/get/transaction, ~150 lines) is the only layer to swap for
  Postgres; SQL stays ANSI-ish on purpose (the SQLite-specific touches are `INSERT … ON
  CONFLICT DO NOTHING` and partial indexes, isolated in `lib/db.js` and two services).
