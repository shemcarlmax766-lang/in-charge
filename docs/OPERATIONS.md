# Operations — BEM-FRS

One Node process, one file DB, one uploads directory. Everything a department IT person needs,
including the parts that go wrong.

## 1. Requirements

* **Node ≥ 22.5** (`engines` enforced; `node:sqlite` is built in — no native builds, no DB daemon).
* Local-disk directory for `data/` (WAL + `fsync`. **Never an NFS/network share** — see
  FAILURE-POINTS 1.4).
* Nothing else. No Redis, no SMTP, no browser daemons. Ports: `4000` (API, and the SPA in prod);
  dev additionally uses `5173` (Vite).

## 2. First run (any machine)

```bash
npm install                 # 202 packages, lockfile-pinned
npm start                   # = vite build && node src/index.js
# http://host:4000  — first boot creates data/bmems.sqlite, applies 001_init.sql,
#                     and (empty DB + SEED_DEMO_DATA=1) installs the FICTIONAL demo fleet,
#                     printing the one-off password to the console only.
```

A real deployment starts the same way *with* `SEED_DEMO_DATA=0` and creates users via the API —
or accepts `SEED_DEMO_DATA=1` deliberately during pilot week and deletes the demo accounts
afterwards (`/users` → deactivate; the seeder itself refuses to run twice against a non-empty DB).

## 3. Configuration

Copy `.env.example` → `.env` (git-ignored) or inject real environment variables — the loader is
zero-dependency and process env always wins over the file. Every key with its default and reader:

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | config | `production` enables cookie `Secure`, `no-store` API cache headers, strict CSP (no inline scripts), `TRUST_PROXY` on |
| `HOST` / `PORT` | `0.0.0.0` / `4000` | server bind | |
| `PUBLIC_BASE_URL` | *empty* (dev: request origin) | QR encoder | **Required in prod** — the absolute URL inside printed labels; boot fails without it |
| `TRUST_PROXY` | prod only | express | behind nginx/Caddy so `req.ip` = client; leave 0 otherwise |
| `BODY_LIMIT` | `1mb` | express | |
| `DATA_DIR` / `DATABASE_PATH` / `UPLOAD_DIR` | `./data...` | db/files | absolute paths recommended in systemd unit |
| `SESSION_TTL_HOURS` / `SESSION_REMEMBER_TTL_HOURS` | `12` / `336` | sessions | remember-me = 14 d |
| `MAX_FAILED_LOGIN_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES` | `6` / `15` | login | per account |
| `ALLOW_SELF_REGISTRATION` | `1` | onboarding | self-sign-up creates **Reporter** accounts only; `0` = admin-provisioned only (UI hides the link, API 403s) |
| `RESET_CODE_TTL_MINUTES` / `RESET_MAX_ATTEMPTS` / `RESET_THROTTLE_SECONDS` | `15` / `5` / `60` | recovery | one-time code lifetime, burn limit, per-account spacing |
| `REVEAL_OTP_IN_RESPONSE` | `1` | recovery | demo convenience: code echoed in the API response — only ever honoured on non-production builds **without** `SMTP_HOST`; set `0` to close it anyway |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` / `SMTP_TIMEOUT_MS` | unset → outbox | mail | recovery codes send via nodemailer when `SMTP_HOST` is set; otherwise they land as files in `data/outbox/` |
| `MIN_PASSWORD_LENGTH` | `12` | policy | floor 8 enforced by `assertConfig` |
| `SCRYPT_N` | `16384` | hashing | raise when hardware allows; stored hashes stay valid (self-describing) |
| `MAX_UPLOAD_MB` / `MAX_UPLOAD_FILES` | `8` / `5` | multer+files | |
| `UPLOAD_ALLOWED_MIME` / `UPLOAD_ALLOWED_EXT` | see `.env.example` | sniffing | allow-list; both ext **and** magic bytes must pass |
| `RATE_MAX` / `LOGIN_RATE_MAX` / `WRITE_RATE_MAX` | `300` / `12` / `60` per min | limiters | per client IP |
| `LIST_PAGE_SIZE` / `MAX_PAGE_SIZE` | `25` / `100` | lists | |
| `SEED_DEMO_DATA` / `SEED_PASSWORD` | `1` / *(generated)* | seeder | never set a real password here in shared infra — it lives in the env, not the repo |
| `ENABLE_EMAIL_NOTIFY` / `ENABLE_SMS_NOTIFY` / `ENABLE_PUSH_NOTIFY` | `0` | notifier | see INTEGRATIONS.md before flipping on |
| `CLIENT_PORT` / `API_ORIGIN` | `5173` / `http://127.0.0.1:4000` | **dev only** (vite config) | dev-server port + proxy target |

Runtime settings (not env): institution name, currency, SLA hours, due-soon window live in
`app_settings`, editable at `/reference` by admins.

## 4. npm scripts

| Script | Does |
| --- | --- |
| `npm run dev` | concurrently: API with `--watch` (4000) + Vite (5173, proxies `/api`) |
| `npm run build` | production client bundle → `client/dist` |
| `npm start` | build + serve everything from the API process (single origin) |
| `npm run migrate` | apply pending `NNN_*.sql` (idempotent; verifies checksums of applied files) |
| `npm run seed` | demo fleet (refuses if `users` exists; writes `data/demo-credentials.txt` 0600) |
| `npm run reset` | delete DB + re-migrate — dev only (uploads untouched; nuke `data/uploads` yourself if needed) |
| `npm test` | 87 server + 42 client tests (~1 min) |
| `npm run lint` | static hygiene gate (secrets, SQL, XSS, env-docs sync) |
| `npm run smoke -- --base https://…` | read-only live-environment check (31 probes incl. PWA files, RBAC negatives, QR contract, exports); `--mutations` adds the idempotent reminder sweep. Credentials via `SMOKE_PASSWORD` (+ optional `SMOKE_ADMIN/TECH/REPORTER`) — never stored in the script |
| `npm run icons` | regenerate PWA icons (dependency-free renderer, `scripts/make-icons.mjs`) |

## 5. systemd (a real prod unit)

```ini
[Unit]
Description=BEM-FRS (Biomedical Equipment Maintenance & Fault Reporting)
After=network.target

[Service]
User=bemsrv
WorkingDirectory=/srv/bem-frs
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PUBLIC_BASE_URL=https://equipment.myschool.edu
Environment=PORT=4000
EnvironmentFile=-/etc/bem-frs/env      # the only secrets file; chmod 600, root:bemsrv
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/bem-frs/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Graceful shutdown is implemented (SIGTERM → stop accepting, drain, close DB) — `systemctl restart`
is safe; in-flight uploads either complete or 500-retry, never half-rows (tx discipline).

## 6. Reverse proxy (TLS + the QR deep link)

```nginx
server {
  listen 443 ssl http2;
  server_name equipment.myschool.edu;
  ssl_certificate     /etc/letsencrypt/live/…/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/…/privkey.pem;
  client_max_body_size 50m;                     # 5×8 MB uploads + multipart overhead
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host              $host;   # PUBLIC_BASE_URL must match this Host
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Set `TRUST_PROXY=1`. Smoke test after deploy:

```bash
SMOKE_PASSWORD='<deploy password>' npm run smoke -- --base https://equipment.myschool.edu   # 31 read-only checks
# then: open /e/<some-tag> from a phone on the LAN (the QR contract), print one label and scan
# it, install-to-home-screen once (the PWA), and eyeball the CSP/console for errors.
```

## 7. Backup & restore (the boring guarantee)

```bash
# nightly (cron/systemd timer) — consistent snapshot without stopping the app:
sqlite3 /srv/bem-frs/data/bmems.sqlite "VACUUM INTO '/backup/bem/$(date +%F).sqlite'"
tar czf /backup/bem/uploads-$(date +%F).tgz -C /srv/bem-frs/data uploads
```

Restore drill: stop unit → put `.sqlite` at `DATABASE_PATH` → untar `uploads` → start →
`/api/health` counts sane → sign in as each role. **Quarterly; an untested backup is a rumour.**
Retention suggestion: nightly × 14, monthly × 12 (audit history is the long tail people ask for).

## 8. Upgrades

1. Read the changelog for `00X_*.sql` migrations (all forward-only; no down-scripts by design —
   take a `VACUUM INTO` snapshot first anyway).
2. `git pull` → `npm ci` → `npm test` (the 87 + 42 suites are the regression gate) →
   `systemctl restart bem-frs`.
3. Schema changes apply at boot (`migrate` runs inside start-up, before listen). The checksum
   guard refuses to boot if an applied migration file was edited — that's the deploy-time
   integrity check, don't paper over it.

## 9. Monitoring that fits a one-node box

* `/api/health` — `{status, counts{equipment,faults,open_faults,users}}`: counts moving wildly
  (or 404) is the alert; add to any uptime checker.
* Disk: `data/` growth is audit rows + attachments — `POST /notifications/prune` (app-managed)
  and the quarterly uploads janitor (FAILURE-POINTS 1.5/1.6) keep it bounded.
* Log: the API logs one line per request (`method path status ms actor` — no PII, no bodies) to
  stdout; journald handles rotation. Non-2xx carry their reason (`errorHandler` logs stacks).

## 10. Demo reset (for the pilot/training week)

```bash
npm run reset && npm run seed   # fresh fictional fleet; console + data/demo-credentials.txt
```
The seeded accounts are listed in README.md; password comes from `SEED_PASSWORD` when set,
otherwise generated once. Uploads persist across reset — delete `data/uploads` first if the demo
photos must go too. So does `data/outbox/` (recovery mail artifacts) and the `password_resets`
rows ride the DB itself: a reset clears them.
