# UI Design — BEM-FRS client

React 18 + Vite SPA, no component library and no chart library — 7 small modules own the whole
surface so design review means reading ~1 file per concern.

## 1. Principles (what the screens are judged against)

1. **Mobile-first, one thumb.** The primary field workflow is: stand at a broken machine, scan
   its QR, type a sentence, add a photo, submit. Every screen the reporter touches works at 360 px;
   bottom tab bar on phones, sidebar from ≥ 900 px.
2. **Every state is a design state.** Loading = skeletons (never spinners that shift layout);
   empty = illustration-free text + the action that fills it; error = what happened *and* Retry;
   destructive = type-to-confirm where history is at stake (equipment delete confirms the asset
   tag).
3. **Role-visible.** Capabilities from `/auth/me` drive nav and actions — a reporter literally has
   no "Assign" affordance, so the accountability boundary of the system is visible, not hidden.
4. **Print = document.** Reports use an `@media print` stylesheet that strips chrome, forces
   status colours to text labels (badges carry their word, not just a hue), and appends the
   safety footnote — see SAFETY.md.
5. **Honest data density.** Tables paginate and every column is searchable/filterable server-side
   (no client-side-only filtering pretending to cover the dataset).

## 2. Information architecture (19 screens)

| Route | Screen | Roles | Notes |
| --- | --- | --- | --- |
| `/login` | Login | public | policy hints, lockout message verbatim, links to self-registration and recovery |
| `/register` | Create a Reporter account | public | plain-language role limits, per-field server errors, honest “registration closed” state |
| `/forgot-password` | Password recovery | public | two steps on one page (request → redeem), labelled demo-code callout, “start again” |
| `/e/:tag` | **QR landing** | public | opened by every physical label; equipment card + “Report a fault” CTA → `/report/:tag`; sign-in offered, not required to view |
| `/` | Dashboard | all | KPI tiles + charts, `scope` varies by role (reporter sees own-report panel) |
| `/equipment` | Inventory list | all | search + 7 filters + status chips; “Print labels” for selected rows (`equipment.qr`) |
| `/equipment/new`, `/equipment/:id/edit` | Equipment form | admin/tech | grouped sections, inline validation, duplicate-serial 409 surfaced on the field |
| `/equipment/:id` | Equipment detail | all* | profile card, QR (PNG/SVG), status stepper *read-only* for reporters, fault/PM/repair history tabs, per-equipment risk panel |
| `/faults` · `/my-reports` | Fault list (shared page, `mine` variant) | role-scoped data | same filters; reporter sees only own rows server-side |
| `/faults/new` · `/report/:tag` | Report a fault | all | severity chips with plain-language definitions; photo attach (camera capture first); SLA response expectation shown after submit |
| `/faults/:id` | Fault detail | participants | timeline (status history with who/when/comment), notes thread, transition stepper, repair-record form (assigned tech), readiness checklist before Repair→Verify→Close |
| `/work` | Technician work queue | admin/tech | my-today / unassigned / awaiting-parts / overdue-SLA columns |
| `/maintenance` | Preventive maintenance | admin/tech | due-board (🟢🟡🔴⚪ per brief), schedule CRUD, run-PM dialog with checklist (fail forces a note when `requiresNoteOnFail`) |
| `/risk` | Maintenance-risk board | all | sorted list of bands; row opens transparent factor breakdown + advice; disclaimer banner pinned top |
| `/reports` | Reports | admin | 8 report cards → JSON preview table, CSV download, print view |
| `/users` | Users | admin | create/edit/reset-password/sign-out actions per row |
| `/reference` | Reference data | admin/tech | categories, locations, fault categories, parts catalogue, settings (admin-only fields disabled otherwise) |
| `/audit` | Audit log | admin | filterable table; before/after diff viewer |
| `/notifications` | Notification centre | all | unread filter, mark-read, delivery-status peek for admins |
| `/profile` | Profile + sessions + password | all | forced password-change target |
| `*` | 404 | all | returns to nav |

`RequireRole` guards admin/tech routes; capability-based *actions* are hidden inside pages.
Server enforces all of it again.

## 3. Component inventory (`client/src/components`)

| Module | Contents |
| --- | --- |
| `ui.jsx` | Button (tones/sizes, `async` mode = busy spinner + double-submit lock), Input/Textarea/Select with label+error+hint slots, Badge, Card, Modal (focus-trapped, Esc/backdrop close), Tabs, EmptyState, ErrorState, Skeleton, Pagination, ConfirmDialog (destructive tone). |
| `display.jsx` | DataTable (columns config incl. sticky first column on mobile → card layout < 680 px), KeyValue, Timeline (status history), StatusChip (7 equipment statuses, 9 fault stages, 4 severities), RiskDial, DueBadge (🟢🟡🔴), PhotoThumb (via attachment URL with auth). |
| `charts.jsx` | Hand-rolled responsive SVG — BarChart, StackedBar (status mix), LineChart (faults/month), Donut (compliance). Zero deps, axis labels always text, colours from tokens; every chart ships a visually-hidden data list plus an `aria-label` summary so the dashboard reads the same with CSS off, on a screen reader, or printed in grey. |
| `AppShell.jsx` | top bar (search → equipment), sidebar + mobile bottom tabs (role-filtered), notification bell (unread-count polling while the tab is visible), Toast host. |
| `QrScanner.jsx` | camera viewfinder → `BarcodeDetector` where available, jsQR fallback on canvas; manual “type asset tag” escape hatch (camera denied/insecure context). |
| `FileInput.jsx` | camera/gallery capture, client size/extension pre-check (server re-checks), multi-file queue with per-file errors. |
| `Toast.jsx` | queue + auto-dismiss, `role=status`. |

State/data: tiny `useApi` hook (fetch wrapper with csrf header, abort on unmount, JSON error →
toast/inline) + per-page `useReducer` for forms; no global store — AuthContext is the only shared
state, deliberately.

## 4. Design system (`client/src/styles/app.css`, single 819-line file)

* Tokens: navy brand ramp (`--navy-900…700`), slate neutrals, semantic pairs
  (`--ok/-bg`, `--warn`, `--bad`, `--info`, `--neutral`), primary blue + teal/violet accents.
  Radii/shadows/spacing are also tokens; components never hard-code a colour.
* Breakpoints: `680` (cards→table), `900` (tabs→sidebar), `1280` (dashboard 3-col KPIs);
  `max-719` tweaks for touch, `max-400` compacts table rows further.
* `prefers-reduced-motion: reduce` kills transitions; `prefers-contrast: more` darkens borders
  and text — accessibility flags respected without a component rewrite.
* Focus is never removed; every interactive element keeps a visible `:focus-visible` ring.
* Fonts: system stack (no webfont payload); tabular numerals on metrics.

## 5. Installable app shell (PWA)

* `manifest.webmanifest` + generated icons (`npm run icons` → `scripts/make-icons.mjs`, a
  dependency-free PNG rasterizer — the favicon's ECG motif on navy, `any` + `maskable` +
  apple-touch sizes): install to home screen, standalone display, "Report a fault" shortcut.
* A **production-only** service worker (`client/public/sw.js`, registered in `main.jsx` behind
  `import.meta.env.PROD`) caches the *shell*: navigations network-first with cached fallback,
  hashed assets stale-while-revalidate, **`/api/**` never intercepted**. A phone that loses the
  LAN still opens the app and shows the normal error states — it cannot pretend a report was
  accepted. Dev (Vite/HMR) is never touched by the SW, by design.
* Server-side cache policy matches: `/assets/*` (content-hashed) `1y immutable`; `index.html`,
  manifest, icons and `sw.js` revalidate (`max-age=0` + ETag) so a deploy is picked up on next
  load — the classic "immutable everything" stale-shell trap is explicitly avoided
  (`server/src/app.js`).

## 6. Cross-cutting behaviours

* **Offline/latency honesty** — mutations optimistically *no*: button busy state, then server
  truth re-renders the row (records must not show unconfirmed state).
* **Session expiry** mid-form → modal offers re-login and the draft survives in the form state.
* **Mobile camera QR flow**: `/e/:tag` deep link works unauthenticated, so a borrowed phone can
  still file a fault; photos are uploaded *with* the report in one multipart POST (no orphan files).
* **Labels**: the equipment list's “Print labels” hits `POST /equipment/labels` and prints a
  sheet of tag+name+QR sized for label stock; `qr_updated_at` makes reprints a deliberate act.
