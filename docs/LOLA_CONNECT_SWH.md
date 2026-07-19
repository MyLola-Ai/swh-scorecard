# SWH → Lola Connect (P4) — integration + go-live runbook

**STATUS: LIVE IN PRODUCTION 2026-07-13.** Function deployed, service token set,
system/ rule released, hosting deployed, beta flag on for Austen
(uid QIz4TLQGV9PgF8VTZsnzOCsdbi33). Verified end-to-end: connected
austennaustin@gmail.com through SWH proxy → gateway → Unipile, emails.list
returned real mail, Settings card shows Connected. To onboard another beta user,
add their uid to system/lolaConnect.betaUids (or set { enabled: true }).

Built 2026-07-13. Wires SWH to the shared **Lola Connect** comms layer (Unipile
behind a provider-agnostic API) on the loaniq-75a20 project. **Additive and
flag-gated** — the legacy Nylas stack (`functions/nylas.js`) is untouched and
stays primary until R2 retires it after real users migrate.

## What's in the repo

- **`functions/lola-connect.js`** — one function, `lolaConnect` (onRequest).
  Authenticates the SWH user (Firebase ID token, same `requireAuth` as
  nylas.js), then proxies to the Lola Connect cross-project **gateway** on
  loaniq-75a20, injecting `subject {pool:'swh-scoreboard', uid}` and
  `product:'swh'` SERVER-SIDE (a client can never spoof either). Op-allowlisted
  (connections.*, emails.list/send, calendars.list/freeBusy, events.*).
  Redirects forced onto approved SWH origins. The service token is only ever
  sent server→server, never to a frontend.
  Wired via `Object.assign(exports, require('./lola-connect'))` in index.js.
- **`public-crm/index.html`** — a flag-gated "Email & Calendar (Lola Connect ·
  beta)" card in Settings (hidden unless the proxy reports the user is
  beta-enabled). Connect → hosted-auth redirect; shows connected email;
  Disconnect. `window.refreshLolaConnectStatus()` runs on login.

## Go-live steps (all require Austen — Firebase CLI + secret writes)

1. **Reauth the CLI:** `firebase login --reauth`
2. **Pipe the service token** (SAME value as on loaniq-75a20) into this project:
   ```bash
   # from ~/loaniq: read it once, then set it here. Never printed to screen.
   firebase --project loaniq-75a20 functions:secrets:access LOLA_CONNECT_SERVICE_TOKEN \
     | tr -d '[:space:]' \
     | firebase --project swh-scoreboard functions:secrets:set LOLA_CONNECT_SERVICE_TOKEN --data-file=-
   ```
3. **Deploy the function:** `cd ~/swh-scoreboard && firebase deploy --only functions:lolaConnect`
4. **Deploy the CRM frontend:** `firebase deploy --only hosting:crm`
5. **Enable yourself in the beta flag** (Firestore, swh-scoreboard project):
   `system/lolaConnect` → `{ betaUids: ['<your-SWH-uid>'] }`
   (or `{ enabled: true }` to open it to everyone). Card stays hidden until this.

## Verify

- Backend, no browser: `curl -X POST -H "Authorization: Bearer <SWH idToken>"
  -H 'content-type: application/json' -d '{"op":"connections.list"}'
  https://us-central1-swh-scoreboard.cloudfunctions.net/lolaConnect`
  → 403 until you're in `betaUids`; then `{ok:true, result:{connections:[]}}`.
- Browser: CRM → Settings → the beta card appears → Connect → Google consent →
  back to Settings showing "Connected: <email>".

## Boundaries / next

- Nylas stays live; do NOT unexport it. R2 (retire nylas.js + legacy
  Gmail/Outlook sync) is a LATER step, only after real users are migrated.
- iOS parity: the CRM WebView serves from the same https origin, so the connect
  redirect returns into the app with no scheme work — but verify on device.
- Scorecard surface + reads-into-Emails-tab / Lola-Draft-send-via-Lola-Connect
  are follow-ups on the same proxy (ops already supported).
