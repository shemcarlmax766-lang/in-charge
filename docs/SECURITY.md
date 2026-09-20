# Security — BEM-FRS

Threat model in one line: *a LAN-hosted departmental system whose most valuable property is the
integrity of maintenance records; its worst realistic outcomes are unauthorised edits, leaked
student/staff data, and equipment being believed safe when it is not.* Everything below is
scoped to that — this is not a bank.

## 1. Authentication

* **Passwords** — scrypt (memory-hard, Node stdlib, no native deps). Stored as the self-describing
  string `scrypt$N$r$p$salt$hash` (`lib/password.js`), so cost parameters can be raised via
  `SCRYPT_N` and old hashes keep verifying; per-user random salt; timing-safe compare.
  Policy (`passwordProblems`): min length 12 (`MIN_PASSWORD_LENGTH`), max 200, at least **3 of the
  4** character families (lower/upper/digit/symbol), not on a common-password list, must not
  contain the user's name or username, and no run of 4+ identical characters. The UI meter uses
  `GET /auth/policy` + the same local rules — never a network call.
* **Sessions** — opaque 256-bit random tokens (`crypto.randomBytes(32)`), **never JWTs**: they
  must be revocable (logout-everywhere, admin sign-out, deactivate user). Only the SHA-256 of
  the token is stored (`sessions.token_hash`), so a DB dump cannot replay sessions.
* **Transport to client** — cookie `bmems_session`: `HttpOnly`, `SameSite=Lax`, `Secure` in
  production, Path `/`, TTL `SESSION_TTL_HOURS` (12h) or `SESSION_REMEMBER_TTL_HOURS` (14d).
  Mobile/scripts may instead use `Authorization: Bearer <token>` returned at login — same
  session row, so revocation applies to both. The **native app shells** (Capacitor) are the one
  client that must persist its bearer token in local storage across restarts (`isNativeShell`
  branch in `AuthContext`; the web build never writes it anywhere). Standard trade for wrapped
  apps — revocation (`/auth/logout`, admin sign-out, expiry) still binds; a device with physical
  access is the assumed adversary there, same as the locked phone holding a browser session.
* **Login hardening** — per-account counter: `failed_attempts` + `locked_until` (default 6 /
  15 min, `MAX_FAILED_LOGIN_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`), checked **before** hashing the
  candidate password (lockout also caps scrypt DoS). Uniform 401 `Invalid email or password`
  for wrong user, wrong password, deactivated account — no user enumeration. Plus IP rate limit
  (12/min). Session id fixation: a fresh session row is created at login; the pre-login state has
  nothing to promote.
* **Concurrent-session hygiene** — `GET /auth/sessions` lets any user see and revoke their own;
  changing password revokes all other sessions; admin `POST /users/:id/sign-out` revokes everything
  for that user; deactivating a user revokes their sessions in the same transaction.

### 1.1 Self-service onboarding & password recovery (OTP)

* **Self-registration** (`POST /auth/register`) can create **Reporter accounts only** — the role
  is hard-wired server-side, because a self-declared *technician* is exactly the boundary this
  project exists to hold (who may diagnose, repair, move equipment out of service stays with
  department provisioning). Same password policy as everywhere; every registration writes an
  audit row and notifies every active admin, so an unwanted sign-up is one click from
  deactivation. Turn the whole path off with `ALLOW_SELF_REGISTRATION=0`; the UI then hides the
  link and the API answers 403. Duplicate email → 409 *with* a pointer to “Forgot password?”:
  deliberate small disclosure (weighed against lookalike-account spam in SECURITY trade-off §),
  because people mid-experiment must not be sent into a silent dead end.
* **Recovery request** (`POST /auth/forgot-password`) answers `202` with byte-identical prose
  whether or not the address exists, is disabled, or is mid-throttle; a 6-digit code exists only
  for real active accounts. Codes are stored as **SHA-256 only** (same discipline as session
  tokens), expire after `RESET_CODE_TTL_MINUTES` (15), allow `RESET_MAX_ATTEMPTS` (5) wrong
  tries before burning, are throttled per account to one per `RESET_THROTTLE_SECONDS` (60), and
  are superseded — a fresh request kills the previous code.
* **Redeem** (`POST /auth/reset-password`) is one atomic step: password policy is checked
  *before* the code so a typo in the new-password box costs no attempts; success sets the new
  hash, clears the login lockout, revokes **every** session (the theft alarm the owner sees),
  consumes the row, writes audit `user.self_password_reset` and an in-app security notification.
  Unknown address, wrong code, expired code and burned code all return the same 400 sentence.
* **Mail delivery** goes through `services/mail.service.js` — real SMTP via nodemailer when
  `SMTP_HOST` is set, otherwise a readable artifact in `data/outbox/` (see INTEGRATIONS.md);
  delivery failure never fails the request, and the row records which happened.
* **Demo reveal — loud, bounded, default-off in prod.** On a build that is *not* production
  *and* has no SMTP host, the API response additionally carries `devOtp` (and the UI shows it
  in a labelled “Demo mode” callout) so evaluators can complete the flow with no mail server.
  Setting `NODE_ENV=production` or any `SMTP_HOST` — or `REVEAL_OTP_IN_RESPONSE=0` — removes the
  field at the server, not the client. It also reveals account existence, which is precisely
  why production cannot have it.

## 2. Authorisation (RBAC)

* Single source of truth: `server/src/auth/capabilities.js` (admin / technician / reporter → capability
  list). Routes guard with `requireRole(...)` (coarse) and `requireCap(capA, capB?)` (fine).
  The client receives the same list via `/auth/me` and only *hides* UI — every call is re-checked
  server-side; there is no endpoint where capability is inferred from the token's role alone.
* **Row-level rules live with the record** (see API.md §5): reporters can edit their own fault only
  before triage; only the assigned technician may write its repair record; technical workflow stages
  require the technician role; `equipment.*`, `maintenance.*`, `audit.*` do not exist for reporters.
* 403 responses carry a human `hint` (`CAPABILITY_HINTS`) — who to ask, not why the stack broke.
* Capability tests run on the request's `req.user` (loaded from the session row *each request*),
  so a mid-session role change or deactivation takes effect immediately — no stale claims in
  tokens.
* Admin cannot be locked out of the system: the last active admin account cannot be deactivated
  or role-demoted via the API.

## 3. CSRF & browser glue

Cookie auth + ambient trust = CSRF risk, so every cookie-authenticated **write** must repeat the
per-session `csrfToken` (returned by `/auth/me`, held in memory by the SPA) in the `X-BM-CSRF`
header; mismatch → 403 with reload hint. Bearer requests are exempt (no ambient credential).
No cross-origin exposure: production is same-origin (SPA served by the API); dev uses Vite's proxy,
so the browser still sees one origin.

## 4. Input validation & injection defence

* All request bodies/queries pass through `lib/validate.js` (typed schema per route: strings with
  length bounds, enums, ints with ranges, ISO dates, bools) before touching services. Unknown
  fields are rejected, not ignored; `400` with per-field messages.
* **SQL**: 100 % parameterised (`?` bind). The one interpolation point — dynamic `ORDER BY` —
  resolves through per-endpoint whitelist maps (`SORTABLE`), never from raw input. A dependency-light
  lint (`npm run lint`, `scripts/lint.mjs`) fails CI on SQL statement literals that interpolate
  request data, on hard-coded secret-looking assignments, and on `innerHTML`/`eval` in app code.
* **XSS**: React escapes by default; no `dangerouslySetInnerHTML` anywhere except the *report
  print view*, which is server-rendered from escaped values only (`lib/csv.js`-style escaping is
  shared). CSV export neutralises spreadsheet formula injection (prefix `'` on `= + - @` starts,
  quoted fields, CRLF).
* **Path traversal**: uploads are stored under `data/uploads/YYYY-MM/` with random generated names;
  reads go through `resolveStored()` which rejects anything escaping the uploads root;
  the filename in the DB row is regenerated server-side, never taken from the client. Files are
  only reachable via the permission-checked `/attachments/:id` route — no static mount.

## 5. Upload policy (`lib/files.js`)

Extension allow-list **and** magic-byte sniffing must agree (jpg/png/webp/gif/pdf + txt/csv/docx
docs only for attachments; equipment photos must be images). Per-kind byte caps ≤ `MAX_UPLOAD_MB`
(8 MB default), ≤ `MAX_UPLOAD_FILES` (5) per request. Files are deliberately *not* re-encoded
(no native image deps): instead the response uses the `Content-Type` from the DB row (never the
client-supplied one), `X-Content-Type-Options: nosniff`, and a server-generated
`Content-Disposition: inline; filename="attach-<id>.<ext>"` — the client's original filename is
metadata only, never reflected into a header, so no download-of-a-nasty-name path exists.
SHA-256 checksum stored for integrity evidence.

## 6. HTTP headers (all responses; CSP relaxed only for the SPA document)

```
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; script-src 'self'
  [dev only: 'unsafe-inline']; style-src 'self' 'unsafe-inline'; connect-src 'self'
  [dev only: ws: wss:]; font-src 'self' data:; object-src 'none'; base-uri 'self';
  form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff · X-Frame-Options: DENY · Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin · Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=()
Cache-Control: no-store                  (production API responses)
```

`data:` for images is the QR/label sheets (data-URL PNGs); `blob:` is the camera canvas during
QR decoding; dev-only relaxations (`'unsafe-inline'` scripts, `ws:` for HMR) disappear in
production builds.

`camera=(self)` is what the in-browser QR scanner's `getUserMedia` needs; everything else is off.
`GET /api/health` and the public equipment-profile route remain unauthenticated but return minimal,
non-sensitive payloads and are rate-limited.

## 7. Auditability (the record-integrity threat, addressed head-on)

Every mutation writes an `audit_logs` row (actor id **and role snapshot**, action, entity, summary,
before/after JSON diff, ip, user-agent) inside the same transaction as the change; fault/equipment
status changes additionally write their dedicated history tables — “who moved this off ‘operational’
and why” is two indexed reads, not log archaeology. Audit rows are append-only by API design (no
endpoint updates or deletes them; admin can only query).

## 8. Data exposure hygiene

* Errors: `errorHandler` logs the stack server-side; the client sees a code + safe message.
  500 never leaks SQL, paths, or config.
* No PII in URLs; emails in audit/notification text are the only user data leaving the DB into
  logs.
* `demo-credentials.txt` is written `0600`, lives in the git-ignored `data/` dir, and the seeder
  refuses to run against a database that already has users — demo and real data never mix.
* Public QR endpoints intentionally exclude serials, custodian contacts, and history.

## 9. Configuration & secrets

All tunables are environment variables (see `.env.example` + OPERATIONS.md §env table); **zero**
credentials in the repo or in images; `assertConfig()` fails boot on nonsense (limits ≤ 0, prod
without `PUBLIC_BASE_URL`, password policy < 8). The one-time demo password is either injected via
`SEED_PASSWORD` (CI/preview) or generated and printed once by the seeder.

## 10. Known limits / next hardening (honest list)

| Accepted for v1 | If deployed wider |
| --- | --- |
| No 2FA — departmental LAN system; scrypt+lockout+rate limit sized for that. | TOTP behind `auth/` module. |
| No SSO — `ROLES` map is the adapter point; add `POST /auth/sso/callback`. | OIDC/LDAP. |
| Session cookie is SameSite=Lax (POSTs from other sites are unauthenticated anyway due to CSRF header). | `Lax` → `Strict` if UX allows. |
| In-memory rate limiters (single process). | Redis store behind the same `limiter()` factory. |
| TLS terminates at the reverse proxy (OPERATIONS.md sample config). | HSTS preload; auto-renew. |
| Attachment AV scanning — none. | ClamAV hook after `files.saveStored`. |
