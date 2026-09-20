# Failure Points & Mitigations — BEM-FRS

Reviewed honestly: what can realistically break, what the code already does about it, and what
residual risk the department is accepting. Ordered roughly by likelihood × impact.

## 1. Data integrity

| # | Failure | What happens | Mitigation (in code) | Residual risk / ops action |
| --- | --- | --- | --- | --- |
| 1.1 | Migration drift — `001_init.sql` edited after being applied | Silent schema mismatch between machines | Migration runner stores a **SHA-256 per applied file** and refuses to boot on drift (`schema_migrations.checksum`). | Local dev only: `npm run reset && npm run seed`. Real changes go in `002_*.sql` — never edit history. |
| 1.2 | Half-applied migration on crash | DB left between schema versions | Each migration applies inside one `BEGIN/COMMIT`; SQLite rolls back the file atomically. | None realistic at this size. |
| 1.3 | Concurrent writes (two techs, same fault, same second) | Repair `PUT` is upsert → **last write wins**; status transitions are guarded by re-reading state inside the tx (stale transition → 409) | All multi-statement writes run in `db.tx`; state machine validates *current* DB state, not client-claimed state. | No optimistic locking on free-text fields: agree by convention that one fault has one working technician (the assignment UI already says so). |
| 1.4 | `data/` placed on NFS/network share | SQLite locking is unsafe on NFS → **corruption**, not just errors | DOCUMENTED HERE: keep `data/` on local disk (OPERATIONS §deploy). | Deploy checklist item. |
| 1.5 | Crash between attachment file write and DB insert | Orphan file on disk, no row | Bytes are written first, row committed second; failure returns 500 and the client re-uploads. Orphans are inert (unreachable — no row, no static mount). | Optional janitor: diff `data/uploads/**` against `attachments.stored_name` and delete leftovers (quarterly). |
| 1.6 | Deleted attachment row but file kept on disk (soft delete `is_deleted`) | Storage grows after deletions | Intentional: history items referenced in audit summaries must keep rendering; purge is a deliberate op step. | Same janitor can also purge `is_deleted=1` > 90 d after a backup. |

## 2. Availability

| # | Failure | Mitigation | Ops action |
| --- | --- | --- | --- |
| 2.1 | Disk fills (uploads + WAL + DB) | Upload caps (8 MB × 5), `POST /notifications/prune`, audit rows are the only unbounded table by design | Alert at 80 %; `VACUUM` after big prunes; quota on the data partition |
| 2.2 | Process dies | `systemd Restart=always` (sample in OPERATIONS); SQLite recovers WAL automatically at next open | Nothing clever; one restart policy is the whole story |
| 2.3 | Single-node outage | Accepted for a department tool: **fault reporting needs the LAN anyway**; paper forms + re-entry on return are the fallback. v2 option: read-only replica from nightly `VACUUM INTO` snapshot | Keep nightly backups restorable (drill quarterly — restore is the backup) |
| 2.4 | Login lockout storm (shared NAT IP, dev laptop with 12/min cap) | Rate limits are generous (300/60/12 per min) and `RATE_MAX`/`LOGIN_RATE_MAX` env-tunable; lockout is *per account* so one user can't freeze the room | For a big classroom demo: raise `LOGIN_RATE_MAX` via env, not by removing the limiter |
| 2.5 | Node upgrade changes `node:sqlite` API | Pinned `engines.node >= 22.5`; the 87-test suite exercises every SQL path in ~5 s; adapter is one file | CI runs the suite on the new Node before deploying |

## 3. Security-relevant failures

| # | Failure | Mitigation | Residual |
| --- | --- | --- | --- |
| 3.1 | DB dump leaks sessions | Only SHA-256(token) stored; tokens 256-bit random | Dump still leaks user PII + hashes — scrypt cost parameters are in the string, so raising `SCRYPT_N` forces work for attackers, and old hashes keep verifying. |
| 3.2 | Password list reuse | COMMON list + name/username rejection + 3-of-4 families + lockout | No breached-password corpus offline — if internet egress is allowed, wire a k-anonymity range check in `passwordProblems` (10-line change). |
| 3.3 | Upload with crafted polyglot (valid PNG header + PDF payload) | Magic-byte sniff picks the *declared* container; served with DB-derived MIME + `nosniff`; `inline` disposition only for image/pdf types; never executed (no scripting in stored files) | Malicious-but-valid files are just files; the real protection is that nothing on this server opens them beyond the browser. |
| 3.4 | `PUBLIC_BASE_URL` left at localhost when printing labels | Boot guard in production; dev falls back to request origin so LAN previews work | Label print sheet shows the URL being encoded — verify one scan before printing 400 labels. |
| 3.5 | Reverse proxy without `TRUST_PROXY=1` | `req.ip` becomes the proxy → shared rate bucket; CSRF cookie `Secure` still correct at app level | Deploy checklist: set `TRUST_PROXY=1`, validate 429 hits per-client not per-proxy. |

## 4. Correctness / trust failures (the domain-specific ones)

| # | Failure | Mitigation |
| --- | --- | --- |
| 4.1 | **A fault is “closed” but the machine was never fixed** | State machine structure, not configuration: a worked fault *cannot* reach `closed` except via `repaired → verified` (`repaired` has no `closed` edge); the `repaired` step is blocked until the repair record passes the readiness gate. Only unworked reports may be closed at triage, and that path is admin-only. The reporter who filed it can verify (“confirm the fix”) or a tech/admin can — but *someone must*. |
| 4.2 | **Reporter’s claim silently becomes an official diagnosis** | Technical-stage transitions 403 for reporters; repair form is `repair.write`-guarded; free text never auto-fills any “diagnosis” field. |
| 4.3 | **Risk score treated as an AI verdict** | Every payload and screen carries the rule list: factors, points, band advice, and the standing disclaimer (SAFETY.md); the model is *displayed*, not secret — `GET /dashboard/risk/model` powers it. |
| 4.4 | Equipment marked `operational` while an open fault exists | Hard 409 in `setEquipmentStatus` (fault-mirror writes are the only exemption, and they move *away* from operational). |
| 4.5 | PM “compliance” gamed by retro-dating | Records store `due_on` snapshot at completion; admin-only `deactivated` paths are audited; compliance report includes late-but-completed as **not** on-time. |
| 4.6 | Clock skew mis-dating “overdue” | Single source of time (`lib/time.js`, server clock), UTC ISO strings end to end. | NTP on the host (deploy checklist). |
| 4.7 | QR code sticker fades / tag typo | Manual asset-tag entry everywhere the scanner is offered; `/e/:tag` is exact + case-insensitive; unknown tag page links to “browse inventory”. |

## 5. Integration failures

| # | Failure | Mitigation |
| --- | --- | --- |
| 5.1 | SMTP/SMS provider down or unconfigured | Channel rows land as `skipped`/`failed` with reason (`notification_deliveries`) — in-app still delivers, and admins can *see* why nothing arrived, which is the whole point of the table. For recovery mail the mirror is `password_resets.delivery_status` (+ `data/outbox/` when no SMTP host is configured at all): a failed send never fails the request, and the user-facing text tells the truth instead of promising mail |
| 5.3 | Recovery code never received (bad relay, full disk, junk email folder) | Codes are useless-by-design after `RESET_CODE_TTL_MINUTES`, so the retry path is the remedy: “start again” issues a superseding code (old one dies). Administrator reset remains the fallback rail for exactly this failure; both routes are audited |
| 5.2 | Notification fan-out amplification (one critical fault → N techs) | One insert per recipient in the same tx as the transition (no queue to lose), recipients = capability holders (bounded by staff count); `POST /prune` keeps the table tidy |

## 6. Deliberate non-failures (scoping decisions, listed so they aren't rediscovered as “bugs”)

* No stock decrement on parts (`in_stock` is informational) — inventory ledger is a warehouse system's job.
* **Offline PWA** — the *app shell* is installable and offline-cached (UI.md §5) so a phone at a
  dead-corner still opens instantly; but there is deliberately **no offline write queue** — a
  background sync of fault drafts risks silently "losing" a critical report, and pretending
  otherwise is worse than a visible error. Drafts stay in the form state until submit.
* No `WebSocket` push — the bell polls `unread-count` while visible; at department scale the trade favours boring.
* No server-side PDF rendering — print view + browser PDF keeps one rendering path (see REPORTS.md).
