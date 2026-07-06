# Mobile Apps Thread — Charter & Knowledge Base

> Charter for the dedicated iOS/Android Claude Code thread. Author: LoanIQ CTO thread, 2026-07-03.
> Point this thread's working directory at `~/swh-scoreboard` (all mobile apps live here today).
> This file is the single source of truth for what the mobile estate is, how it works, what has
> been decided, and what is in flight. Update it as facts change.

## 1. Mission & ownership

This thread owns the **native app shells and mobile-specific UX** for all products:
- The three Capacitor iOS projects (`ios-crm`, `ios-scorecard`, `ios-combined`) and the one Android
  platform (`ios-scorecard/android`).
- Mobile-only concerns: Liquid Glass nav, safe areas, home indicator, splash/status bar, push,
  IAP/paywall, native auth bridge, App Store/TestFlight releases.

**Shared-file etiquette (critical):** the app UI IS the web bundle (`public-crm/`, `public-scorecard/`).
Those files are shared with the SWH web thread and get deployed to the web too. Mobile-specific CSS
(safe-area offsets, native-only blocks gated on `isNative`) is this thread's turf; product features in
the same files belong to the SWH thread. Coordinate, never clobber. Multi-thread model per
`~/loaniq/docs/LOLA_CTO.md`: CTO coordinates cross-product; briefs are paste-ready docs (cross-thread
messaging is blocked in Auto mode).

**Approvals:** every build/deploy/App Store submission runs on Austen's Mac with his explicit go.
Secrets are set by Austen via CLI/console only, never pasted in chat.

## 2. App inventory (verified 2026-07-03)

| App | Dir | Bundle ID | Version | Web bundle | Status |
|---|---|---|---|---|---|
| SWH CRM | `ios-crm/` | `com.impactleadershipgroup.swh.crm` | pbxproj v1.0 b1 (TestFlight builds ahead; branch "build-21-subscription-debug" era) | `../public-crm` | **Active beta** (live on Austen's device 2026-07-03) |
| SWH Scorecard | `ios-scorecard/` | `com.impactleadershipgroup.swh.scorecard` | **v1.43 b30**, CFBundleDisplayName "The Scorecard" | `../public-scorecard` | **Archive-ready** pending Austen's beta week; has the only **Android** platform (`@capacitor/android ^8.4.0`) |
| SWH Combined | `ios-combined/` | `com.impactleadershipgroup.swh.combined` | v1.0 b1 | `../public-scorecard` | Shell/experiment; fate undecided |

All three: Capacitor **8.3.x**, same plugin set: `@capacitor-firebase/authentication ^8.2`,
`@revenuecat/purchases-capacitor ^13.1`, app, preferences, push-notifications, splash-screen,
status-bar. Config highlights (`capacitor.config.json` per app): `iosScheme: https`, hostname
`crm.stopwastinghandshakes.com` / `app.stopwastinghandshakes.com`, **no `server.url`** (see §3),
StatusBar `overlaysWebView: true, style: DARK`, FirebaseAuthentication providers google.com + apple.com.

**Entity note:** bundle IDs (and Apple registrations) are still under the old Impact Leadership Group /
Mortgage Dude naming. Platform owner is MyQueso Holdings, Inc.; re-filing is a known pending item.
Do not create NEW identifiers under the old names without flagging it.

**Repo state (2026-07-03 EOD):** branch `build-21-subscription-debug`, everything committed and pushed
through `1e05297` (design pass: Liquid Glass on both apps + manifesto tier copy + Xcode release prep).
Toolchain: Xcode 26.6 (17F113); both installed apps built on it.

## 3. The bundled-assets model (the #1 operational gotcha)

`webDir` points at the web folder and there is **no `server.url`**: the app bundles its web assets at
build time. Consequences:
- **A Firebase Hosting deploy NEVER updates the installed app.** Web users get it on refresh; the app
  needs `npx cap sync ios` + Xcode rebuild + TestFlight/App Store.
- Release pipeline: edit `public-crm/` → `firebase deploy --only hosting:crm --project swh-scoreboard`
  (web) → `cd ios-crm && npx cap sync ios && npx cap open ios` → device run or Product→Archive →
  TestFlight. Signing identity lives on Austen's Mac.
- The synced copy lives at `ios-crm/ios/App/App/public/`; check its mtime vs `public-crm/` to detect
  a stale bundle.
- Hosting targets in `firebase.json`: scorecard→`public-scorecard`, crm→`public-crm`,
  landing→`public-landing`, admin→`public-admin`. Scoreboard live source is `public-scorecard/`
  (a stale legacy copy at `public/` was deleted 2026-07-03 — it was never a hosting target).

## 4. WKWebView + Firebase: the NativeAPI pattern

Firebase Web Auth/Firestore SDK **hangs on the capacitor:// (custom-scheme) origin**. The apps
therefore never use the Web SDK on native. The pattern (implemented in `public-crm/index.html`,
`NativeAPI` object ~line 3478):
- **Auth:** `@capacitor-firebase/authentication` plugin for Google/Apple sign-in (`signInWithGoogle`,
  `getIdToken({forceRefresh})`); email/password via identitytoolkit REST with the web API key.
  Session persisted in Capacitor Preferences (`nativeAuth` key); `_refreshIfNeeded()` refreshes
  tokens (plugin for federated, securetoken REST for password users).
- **Backend calls:** `NativeAPI.call(fnName, body)` → POST
  `https://us-central1-swh-scoreboard.cloudfunctions.net/{fn}` with Bearer idToken (onRequest
  functions, not callables). 401 → signOut. 15s timeout.
- **Firestore:** REST wrapper (`_FS_BASE` + structured-query helpers), never the Web SDK.
- **Bootstrap call must be at END of module** (classic init-order bug source).
- Native detection: `isNativeEarly` / `window.Capacitor.isNativePlatform()`. Deep link:
  `?screen=tasks` captured to `window._initialScreen`, honored in `showApp()`.

## 5. Payments

- **IAP (RevenueCat `^13.1`):** products `com.impactleadershipgroup.swh.scorecard.monthly` →
  scorecard ($10/mo) and `com.impactleadershipgroup.swh.crm.monthly` → pro ($25/mo).
  `setupRevenueCat(uid)` runs at sign-in on native; if `userPlan !== 'pro'` → `openPaywall('upgrade')`
  (demo-mode-first paywall is the SWH pattern). Backend: `revenueCatWebhook`
  (`functions/index.js:2329`, `REVENUECAT_WEBHOOK_AUTH` secret) mirrors entitlements onto
  `users/{uid}.plan` using the same schema as Stripe.
- **Web (Stripe):** live price map at `functions/index.js:63-90`: scorecard $10, scorecard_crm $25,
  team tiers; `STRIPE_TRIAL_DAYS=60`, `TEAM_MIN_SEATS=3`. Stripe and RevenueCat converge on the same
  `users/{uid}.plan`, so entitlement logic downstream is source-agnostic.
- Apple takes 15-30% on IAP; RevenueCat free under ~$2.5k/mo tracked revenue.

## 6. Push notifications

- **APNs:** direct HTTP/2 to api.push.apple.com with a .p8 token (JWT), NOT via FCM, in the loaniq
  repo: `functions/lola-sms/src/apns.ts` (+ push-queue-consumer, reminders, morning-brief) and
  `functions/myappointment-public/.../onBookingCreatedPush.ts`. Secrets `APNS_AUTH_KEY`,
  `APNS_KEY_ID`, `APNS_TEAM_ID`.
- **FCM:** SWH daily activity reminder uses `admin.messaging().send` (`functions/index.js:1334`);
  tokens saved via `saveFcmToken`.
- Cost: push is free; the fixed cost is the $99/yr Apple Developer Program.

## 7. iOS 26 / Liquid Glass playbook (hard-won, do not relearn)

Memory entries: `tech_ios26_home_indicator_capacitor`, `tech_swh_capacitor_firebase`.

1. **ViewController keep-state** (`ios-crm/ios/App/App/ViewController.swift`):
   `overrideUserInterfaceStyle = .dark` BEFORE `super.viewDidLoad()`; webView `isOpaque=false` +
   black backgrounds; a **UIColor.clear** safe-zone view pinned to the safe-area bottom. Never put
   window styling in AppDelegate (window is nil at storyboard launch; calls silently no-op).
2. **Home indicator:** `prefersHomeIndicatorAutoHidden` is sealed (`override dynamic public`, not
   open) in the Capacitor XCFramework; control it from JS via
   `SystemBars.hide({ bar: 'NavigationBar' })` at every boot (idempotent; omitting `bar` also hides
   the status bar, don't). **ACCEPTED STATE (Austen, 2026-07-03): do NOT chase permanent removal.**
   Success = indicator may appear at launch/touch, must fade after a few seconds, never permanently
   visible; no overlays, no colored safeZone strip, don't break the glass nav.
3. **The phantom-indicator lesson:** the real home indicator is system-composited and NEVER appears
   in screenshots. A bottom-center pill in a screenshot is app-rendered DOM. The CRM's was an empty
   `.toast` parked ~2px above the bottom (bottom:82px vs translateY(80px) hide). Fix pattern (commit
   `95b3f74`): `visibility:hidden` at rest, `visibility:visible` on `.show`, visibility added to the
   transition list. Never fix by increasing slide distance. A cross-product audit for this exact
   pattern ran 2026-07-03 (CTO thread, workflow `phantom-toast-audit`).
4. Test device reference: iPhone 17 Pro Max, iOS 26.5.1.

## 8. Design standards (mobile) — iOS 26 Liquid Glass, APPROVED DO-NOT-REGRESS

A large design pass landed 2026-07-03 (through commit `1e05297`). Liquid Glass is now the standard
on BOTH apps; the CRM (`public-crm/index.html`) is the reference implementation and the Scorecard
(`public-scorecard/index.html`) was brought up to match. Austen approved this as the accepted state:

- **Bottom nav = detached floating glass capsule, NOT a footer.** Radius 34px all corners,
  `blur(30px) saturate(190%)`, 0.5px hairline border, large soft shadow (`0 24px 60px` dark /
  `0 20px 50px` light), tint `rgba(28,28,30,.44)` dark / `rgba(255,255,255,.48)` light. A
  `.scrolling` class (JS at end of body) bumps opacity while scrolling.
- **Nav bottom offset — KNOWN divergence, decision pending:** Scorecard uses
  `:root --nav-bottom-offset = max(calc(env(safe-area-inset-bottom) - 12px), 8px)` so the capsule
  dips INTO the safe area (Gmail/Music style); CRM still sits at `calc(safe-area + 4px)`. Do NOT
  "fix" either without Austen's word — unifying them is his open call (§10).
- **Scorecard save-bar:** floating glass capsule 8px above the nav (4px in the calc + geometry),
  springs in only with unsaved changes, shows "N activities • X pts", morphs to a green "✓ Saved"
  pill for 1.4s after save (`flashSaved()`). This REPLACED the old success toast.
- **Ask Lola pill (CRM)** rides the nav layer: `right:16px` flush with the capsule, 14px above it,
  same glass recipe in indigo `rgba(20,20,42,.55)`, stays dark in light mode (label contrast —
  approved deviation). Universal launcher spec: `~/loaniq/docs/LOLA_LAUNCHER_STANDARD.md`;
  orb-only fabs are retired.
- **Desktop web (>=1024px)** keeps the dark left sidebar; capsule styling is explicitly reset
  there. Don't leak mobile glass into the sidebar.
- **AAA visual bar:** user-facing UI must hit Stripe/Linear-caliber polish.

**Copy — SWH Manifesto (July 2026) is the canonical voice.** First-person commitment language;
no em-dashes; no leads/targets/transactions framing. Tier identity messages exist in TWO synced
client copies that must never drift: `public-scorecard/index.html` (TIERS array + tiers modal — KEEP
IN SYNC comment is there) and `public-crm/index.html` (tiers array); `functions/index.js` getTier
carries the same five for emails. (`public-scorecard/crm.html` — a stale Scorecard v18 snapshot
that was never the CRM — was deleted 2026-07-06; its URL 301s to crm.stopwastinghandshakes.com.)
The five:
🟢 "The first step is taken. Trust is built in small kept commitments." · 🔵 "You're showing up.
Now notice, remember, and respond." · 🥉 "Bronze earned. Relationships are built, not harvested.
Keep building." · 🥈 "Silver earned. You follow through when others fade away." · 🥇 "Gold earned.
Every handshake honored. You are the network."
Example week (Scorecard + desktop CRM tiers modals; math verified against DEFAULT_ACTIVITIES):
4 networking meetings (20) · 12 new contacts added (24) · 12 Good to Meet You follow throughs (60) ·
8 FORMing conversations (40) · 2 one-on-ones (20) · 2 introductions (20) · 1 referral given (10)
= 194 pts. "Add New Contact" (Networking, 2pts, lead) is now in the Scorecard's DEFAULT_ACTIVITIES,
matching the CRM's system activity.

## 9. Cross-thread couplings this thread must know

- **MyAppointment de-embed (Phase 0):** the CRM's Appointments screen + "My Booking Link" today read
  loaniq-75a20 via `getApptData`/`mintApptCustomToken` (cross-project bridge). The ratified plan
  (briefs in `~/loaniq/apps/myappointment/docs/`) replaces this with a connector record + provider
  picker + `swhApptWebhook` receiver. Expect that surface to change under the SWH thread's ownership;
  mobile just re-bundles.
- **Settings booking-link fix (shipped 2026-07-03):** `loadApptData()` now calls
  `updateSettingsApptSub()` so Settings labels populate after the async load. Smoke: fresh sign-in →
  straight to Settings → link + meeting count show.
- **SSO topology:** SWH surfaces must stay OFF `*.myloaniq.ai` (the `loaniq_sso` parent-domain cookie
  + sso-receiver auto-relogin bounce; triage doc `SSO_BOUNCE_TRIAGE.md`).
- **Unified Lola Auth via Nylas (decided, in flight):** one Lola-branded auth across products; Nylas
  for Google/Outlook/IMAP. Native OAuth flows may change when it lands; don't build new direct-Google
  OAuth on mobile.
- **Onboarding drip:** native sign-in calls `enrollOnboardingDrip` for pro users (weekday 14-email
  SWH series; `_DRIP_FROM` Austen with SWH).

## 10. Roadmap / open items

**Release state (2026-07-03):** Scorecard 1.43 b30 is archive-ready pending Austen's beta week;
What's New copy is written and with Austen. App Store Connect still pending: the LISTING name change
to "The Scorecard" (may need a uniqueness qualifier) + the 1.43 version record + What's New paste.
CRM App Store prep has NOT started (no version bump, no ASC record work). Old TestFlight/App Store
users (e.g. Danny) are on very old builds; their visual bugs are already fixed at HEAD — ship 1.43
rather than chase reports against stale binaries.

**Austen's decisions pending — do not preempt:**
- Unify the CRM nav offset with the Scorecard's safe-area dip (§8 divergence).
- "Show how many people added to the CRM" beyond the example week (stat tile or auto-logging on
  contact capture was discussed; no decision).

1. ~~Active task #1: nav positioning~~ — SUPERSEDED: the 2026-07-03 design pass landed the nav +
   Ask Lola layering on both apps (§8). Remaining nav work = the offset-unification decision above.
2. Device smoke of the 2026-07-03 build: Settings booking link + Ask Lola pill (app is live; confirm).
3. **Android:** only `ios-scorecard` has the platform today. Decide: revive/ship Scorecard Android,
   then add Android to ios-crm (Capacitor makes this mostly config + store setup; the WKWebView
   REST patterns carry over, but re-verify FirebaseAuthentication + RevenueCat on Android).
4. `ios-combined` fate: ship, fold into CRM, or delete.
5. Apply the §7 ViewController/SystemBars pattern to ios-scorecard + ios-combined (currently only
   ios-crm has it).
6. Bundle-ID / App Store entity re-filing under MyQueso Holdings (coordinate with Austen; legal item).
7. App Check on the public callables the apps hit (recommended follow-up, esp. propertyConciergeChat
   pattern; low urgency).
8. Future product apps (MyLola mobile etc.): nothing committed. If one starts, it inherits this
   charter's patterns (Capacitor 8, NativeAPI REST bridge, RevenueCat, pill launcher, §7 playbook).

## 11. Runbook (copy-paste)

```bash
# Web-only change (browser users)
cd ~/swh-scoreboard && firebase deploy --only hosting:crm --project swh-scoreboard

# App update (after ANY public-crm change you want in the app)
cd ~/swh-scoreboard/ios-crm
npx cap sync ios
npx cap open ios     # then: device Run, or Product → Archive → Distribute → TestFlight

# Detect stale app bundle
diff -q ~/swh-scoreboard/public-crm/index.html ~/swh-scoreboard/ios-crm/ios/App/App/public/index.html

# Device install (Austen's iPhone 17 Pro Max, iOS 26.5.1)
xcrun devicectl device install app --device 00008150-0006108A36D0C01C "<path-to-.app>"
# DerivedData: CRM = App-dahsdbpbiwqgntecywdjinbgiedk/SWH CRM.app
#              Scorecard = App-fcrthidrgkfihoffrghrjjacxwew/Stop Wasting Handshakes.app
# ALWAYS verify CFBundleIdentifier in the .app's Info.plist before installing —
# the two apps have been cross-installed by mistake before.
```

Rules of the road:
- Never edit `ios/App/App/public/` directly (gitignored, regenerated by `cap sync`).
- Order of operations: edit web source → `npx cap sync ios` (in the right `ios-*` dir) → build →
  install. Hosting deploys: `firebase deploy --only hosting:scorecard` / `hosting:crm`
  (project swh-scoreboard is the default).
- Commit style: deploy/build FIRST, then `git add <specific files>` + push to
  `MyLola-Ai/swh-scorecard` on the current branch (`build-21-subscription-debug`).
- Simulator caveat: Google/Apple sign-in needs a real device.

## 12. Memory entries to load/consult (in ~/.claude .../memory/)

`tech_swh_capacitor_firebase` · `tech_ios26_home_indicator_capacitor` · `project_swh_crm_ios` ·
`project_swh` · `project_swh_scoreboard_source_truth` · `style_ask_lola_launcher` ·
`project_swh_personal_crm` · `project_myappointment_phase2_independence` (+ Phase 0 brief) ·
`reference_swh_form_acronym`. This thread should write its OWN memory entries for new mobile
lessons and keep this charter current.
