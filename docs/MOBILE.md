# Mobile — Android & iOS, and how to test everything locally

**What you have:** the web app is installable as a PWA, and the repo now contains real native
shells — `client/android` (Gradle project) and `client/ios` (Xcode project) — generated with
Capacitor 8, wrapping the same tested SPA. There is **one codebase**; the native layer adds the
app icon, a dedicated WebView, camera permission handling and store-readiness — it does not fork
the UI or the logic.

**Hard requirements for compiling:** APK needs **Android Studio (or SDK + JDK 21)** on any OS;
IPA needs **Xcode on macOS**. Neither toolchain exists in the dev sandbox, so the native projects
are committed ready-to-build, and the *build* happens on your machine — that is the only missing
step, and §4 walks through it.

---

## 1. The three access modes (pick per test session)

| Mode | What it is | Use for |
| --- | --- | --- |
| **A. Phone browser over LAN** | Phone Chrome → `http://<laptop-ip>:4000` | Fastest full functional test — zero installs |
| **B. Installed PWA** | Same server, "Install app" from the browser | Icon, standalone window, offline *shell* caching |
| **C. Native shell** | Capacitor APK / TestFlight-free IPA | Camera UX without flags, real-app feel, store path later |

All three hit the *same* API on your laptop. Nothing needs the cloud.

## 2. Start the local server (once, any mode)

```bash
cd in-charge
npm install
npm run build            # production-shaped bundle the server will serve
npm run start -w server  # :4000  (API + SPA, single origin)
# or: npm run dev        # :4000 API + :5173 Vite with hot reload
```

Find your laptop's LAN address:

- Windows: `ipconfig` → “Wireless LAN adapter Wi-Fi” → `192.168.x.x`
- macOS/Linux: `ip get route default` → `ifconfig en0` / `ip -4 addr`

Phone and laptop must be on the **same Wi-Fi** (watch out for “AP client isolation” on
corporate/campus Wi-Fi — if the phone can't reach the laptop, tether phone → laptop hotspot
instead and use the hotspot adapter's IP).

Firewall: allow inbound TCP 4000 on the laptop (Windows prompts on first listen; macOS:
System Settings → Network → Firewall → allow node).

## 3. Mode A/B — browser & PWA: test script (≈15 min)

On the phone, open `http://192.168.x.x:4000` and run the three-role walk:

1. **Reporter** `p.nair@student.sthospital-training.edu` / `Demo-Access-2026`
   - Login lands on the mobile dashboard (bottom tab bar, not a squished desktop page).
   - Tap **Report a fault** → the device camera viewfinder opens → scan any label — or
     `BMU-ECG-0001` typed into the manual field.
     *Plain-HTTP caveat:* browsers only allow the camera on secure origins. Two options:
     (a) Chrome flag `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → add
     `http://192.168.x.x:4000` → restart Chrome (test-only, well-established workflow);
     (b) skip live scanning — everything else (photo attachment via gallery/camera *app*,
     the app itself) works without it. Safari/iOS: use (b) locally, or Mode C.
   - Submit with a photo; check it appears under **My reports** with the SLA message.
   - Try to edit it after assignment → the UI offers only what you're allowed to do.
2. **Technician** `g.mbeki@…` — claim from **Work**, move *Assigned → … → Repaired*: note the
   refusal until the repair record is complete; record diagnosis/parts/costs + before/after
   photos; verify → close; open the equipment page → history + risk panel + “mark operational”.
3. **Admin** `a.okonkwo@…` — **Reports** → CSV opens in the spreadsheet app; **print view** →
   share-sheet → Save as PDF; **Users / Reference / Audit** reachable; from a reporter's device
   they are *gone* (not greyed) — that's the RBAC visible in the UI.
4. **Offline shell (Mode B):** Chrome ⋮ → **Add to Home screen** → launch from the icon; turn on
   airplane mode → app still opens to its cached shell and every data screen shows the friendly
   error state (by design: no fake offline queuing).

Then prove the server side from the laptop itself:

```bash
SMOKE_PASSWORD='Demo-Access-2026' npm run smoke -- --base http://192.168.x.x:4000
# 30 read-only checks → all ✓; add --mutations for the idempotent reminder sweep (31/31)
```

## 4. Mode C — the native shells

### Android (APK to your phone, no Play Store)

One-time: install **Android Studio** (bundles JDK + SDK + emulator). Then either:

```bash
cd in-charge/client
npm run android:apk      # build web → cap sync → ./gradlew assembleDebug
# artifact: client/android/app/build/outputs/apk/debug/app-debug.apk
adb install -r client/android/app/build/outputs/apk/debug/app-debug.apk
```

…or `npm run android:open` → Run ▶ on a connected phone/emulator (easier first time).

The shell as committed loads the app **bundled inside the APK** and calls the API via
`VITE_API_BASE` — for LAN testing build it against your laptop once:

```bash
cd in-charge/client
VITE_API_BASE=http://192.168.x.x:4000 npm run android:apk
```

and start the server with the shell's origin allowed:

```bash
NATIVE_ORIGINS=https://localhost npm run start -w server
```

(`https://localhost` is the virtual origin Capacitor serves the bundled app from on Android —
the server-side CORS shim in `app.js` only answers *that* origin, and nothing else, which the
live test in this repo's history verified both ways.)

Alternative during development — **shell mode**: put `"server": { "url": "http://192.168.x.x:4000" }`
in `capacitor.config.json` + `npx cap sync android`: the APK then *displays your live dev server*
(hot-reloading pages inside a native window, no rebuilds per change). Remove the `url` for
bundled builds. `allowMixedContent` + `usesCleartextTraffic` are already set for http LAN use;
delete both when you move to TLS.

What you should see: app icon (placeholder Capacitor art — swap via `@capacitor/assets`
later), splash → login, camera permission **prompt** on first scan attempt (declared in
`AndroidManifest.xml`; the WebView bridge turns it into `getUserMedia`), back-button behaves,
photo capture works via the system camera app.

### iOS (needs a Mac; no App Store account required for device testing)

Clone the repo on the Mac → `cd client && npm install && VITE_API_BASE=http://192.168.x.x:4000 npm run build && npx cap sync ios && npx cap open ios`.
In Xcode: *Signing & Capabilities* → your personal Apple ID team → run on the plugged-in iPhone.
Free Apple IDs allow 7-day device provisioning — plenty for testing. `NSCameraUsageDescription`
is already in `Info.plist` (the system prompt text). Server-side on the laptop: same
`NATIVE_ORIGINS=https://localhost` (iOS shell origin) — actually `capacitor://localhost`; list
both when testing iOS: `NATIVE_ORIGINS=https://localhost,capacitor://localhost`.

### Native-mode session storage (one design note)

Web mode = httpOnly cookie (nothing token-like in storage, by security design). Native shells have
no persistent cookie jar across restarts, so the **bearer token is kept in the shell's local
storage** (`AuthContext` — `isNativeShell` only). That is the same trade every Capacitor app
makes; it's fenced off from the web build by a single flag and documented in SECURITY.md §1.

## 5. Known limits to accept (not fix) during local testing

| Thing | Reality |
| --- | --- |
| Camera on plain `http://IP` | Secure-context rule, not our bug: use the Chrome flag (§3) or the native shell — live scanning is *always* available inside the APK/IPA (https virtual origin) |
| Push notifications | Out of scope for the shells today (server structure exists; see INTEGRATIONS.md §1) |
| APK from source vs store signing | `app-debug.apk` sideloads fine; Play Store needs a release keystore — a release-day task |
| Icons/splash | Capacitor defaults; regenerate with `@capacitor/assets` once branding exists |
| `appId edu.hospitaltraining.bemfrs` | Rename to your institution's reverse-domain before shipping anywhere |
| Campus Wi-Fi isolation | Phone can't see laptop → use a hotspot, same steps |

## 6. Pass criteria (the checklist to tick)

- [ ] Mode A walk complete for all three roles on a real phone
- [ ] `npm run smoke` green against `http://<laptop-ip>:4000`
- [ ] Reporter cannot reach any admin/tech surface *in the native shell* too (proves it's the server, not the browser)
- [ ] Camera: prompt → scan a printed label (or hand-drawn QR of `http://…/e/BMU-ECG-0001`) → lands on that equipment
- [ ] One full fault lifecycle on mobile: report → assign → repair → verify → close, then CSV opened on the phone shows the closed row
- [ ] Offline shell behaviour (Mode B §3.4) or airplane-mode relaunch in the APK shows friendly errors, no crash
- [ ] iOS build runs on a device (if a Mac is available this week — otherwise defer; the project is committed)
