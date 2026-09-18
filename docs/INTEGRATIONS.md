# Integrations — the ports that already exist

Principle (ARCHITECTURE.md §6): *integrate by implementing an adapter, never by editing call
sites.* Everything that could need an external service today is a named seam with a working
no-op — so “turn email on later” is not a refactor.

## 1. Notifications (in-app live · email/SMS/push ready)

`server/src/services/notification.service.js` fans every lifecycle event out to people, and
**each channel of each notification gets a ledger row** (`notification_deliveries`):

| Channel | Status today | Delivery rows you will see |
| --- | --- | --- |
| `in_app` | **live** — the bell + `/notifications` centre | `sent · “Delivered to the in-app centre”` |
| `email` | registered, `ENABLE_EMAIL_NOTIFY=0` | `skipped · “Channel not enabled on this deployment”` |
| `sms` | registered, `ENABLE_SMS_NOTIFY=0` | `skipped` (same reason) |
| `push` | registered, `ENABLE_PUSH_NOTIFY=0`; `target: () => null` — no token store yet | `skipped`, then `skipped · “Recipient has no address on file”` once enabled |
| any enabled channel without transport | — | `pending · “Queued — transport not configured”` (deliberate: the ledger never claims a send that didn’t happen) |

Admins can see all of it: `GET /notifications/:id/deliveries` — “was Dr. Okonkwo told?” is a
query, not a guess.

**Events emitted** (all inside the same DB transaction as the change they describe — no lost
notifications if the process dies mid-request):

* `fault_critical` — every active technician **and** administrator (except the actor) on creation
  of a critical report.
* `fault_assigned` — the assignee on admin assignment; also re-used, with `severity: warning`,
  for **reopened** faults so the assignee sees work returned to them.
* `fault_status_changed` / `repair_completed` (the `repaired` step gets its own type + a
  “please confirm it works” prompt for the reporter) — reporter + assignee on every transition;
  `verified`/`closed` additionally notify all other admins. Bodies carry the equipment line, the
  actor’s `Note:` text when a comment was given, and a who/when footer; links deep into the SPA.
* `maintenance_due` — responsible technicians via `runMaintenanceReminders` (due-soon/overdue
  sweep, idempotent — no re-ping inside the window; `POST /maintenance/reminders` triggers it
  manually).

### Adding a transport (worked example: email)

1. Create `server/src/notify/email.js` exporting `async function deliver({ to, subject, body })`
   (nodemailer SMTP, or the campus relay — config goes in `.env`: host/port/user/pass vars).
2. In `notifyUser`’s channel loop, the branch `else { recordDelivery(… 'pending' …) }` becomes
   `await queueOrSend(channel, cfg, target, payload)` that calls the adapter and records
   `sent`/`failed` + provider error text. Nothing else changes: no schema migration, no call-site
   edits, the ledger becomes the SMTP audit trail for free.
3. Set `ENABLE_EMAIL_NOTIFY=1`. Delivery failures must **not** fail the business request — the
   send already runs post-commit by design; adapters catch and record `failed`.

SMS follows the same 3 steps (users already carry `phone`); push wants a small addition first:
a `device_tokens` table + Web Push VAPID keys — deliberately not invented here because the
department asked for “ready structure”, not push itself.

## 2. Email *inbound* (report by email)

Not built; the seam is `fault.create` + the reference generator: an IMAP/Grapes-like poller would
insert via the same service the mobile form uses (subject line → equipment tag lookup via
`id_sequences`-managed `asset_tag`). Listed here so the next person doesn’t build it on a raw
INSERT path that skips history rows.

## 3. Authentication

Opaque DB sessions are the only method today (the right call for a LAN service, SECURITY.md §1).
SSO seam: `auth/` directory + `ROLES` map means an OIDC callback route issues the *same* session
rows after verifying an id_token — role mapping happens at `users.role_id` write time, never in
the token. No SSO is claimed or half-implemented.

## 4. Cameras / QR hardware

QR = **printed PNG/SVG from `qrcode`**, decoded in the browser via `BarcodeDetector` (native on
modern Android Chrome) with the jsQR canvas fallback — zero server coupling, so USB QR-gun
readers also work by acting as keyboards into the manual-entry field (deliberately supported,
QrScanner.jsx).

## 5. Shared object storage

Uploads live on local disk behind `resolveStored()` (files.js). The read path is one
permission-checked route (`/attachments/:id`) and the write path is one function — swapping in
S3/MinIO means two adapters; the DB schema already stores only `(stored_name, checksum, size,
mime)` and never a URL.

## 6. Things intentionally *not* integrated

* **CMMS/asset-management import** — one-off migration is `npm run seed`-style SQL scripts against
  the same tables (each table has a service; writing directly is safe for a one-time load if
  audit rows are appended too — see the seeder as the worked example).
* **Billing/finance export** for repair costs — the `costs` report CSV is the exchange format;
  inventing a second accounting truth in-system would fight the paper process, not replace it.
* **Real-time channels (websockets)** — unread-count polling is enough at this scale
  (FAILURE-POINTS §6).
