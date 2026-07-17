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
| **Lola (personal chat)** | `~/loaniq/apps/lola/` | `com.mortgagedude.lola` | v0.1 (pre-TestFlight) | `../../tools/lola-chat` | **Austen-only internal tool** (assigned to this thread 2026-07-15); TestFlight target, no App Store listing, no purchase surface |

**Lola app exceptions to the house patterns (important):** Capacitor **6** (not 8); auth is a pasted
`LOLA_ADMIN_TOKEN` bearer (single-user, no accounts at all — Scorecard login-only concerns don't
arise); and it runs in **`server.url` mode** (`lola-chat-loaniq.web.app`), so unlike every other
app the §3 bundled-assets gotcha is INVERTED: every `hosting:lola-chat` web deploy is live in the
installed app on next launch, and the local bundle is only a fallback that engages if `server.url`
is ever commented out (e.g. for App Store submission). CTO Channel spec: `~/loaniq/docs/CTO_CHANNEL.md`
(VA thread implementing; the app inherits it via the shared `lolaPersonalChat` backend — this
thread's verification bar is the `CTO:` ack + numbered morning-brief section rendering on device).
RESOLVED 2026-07-15/16: bundle ID is **ai.mylola.app** (Austen's decision, superseding the
com.myqueso.lola recommendation) — locked in `capacitor.config.ts` + the Xcode project in one
commit (loaniq `501141e6`); never reuse MortgageDude-era IDs. CocoaPods is FIXED on Austen's Mac
and verified: `pod install` completes cleanly (9/9 pods). NOTE for non-interactive shells: pod
requires a UTF-8 locale — run as `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install` or it dies in
Unicode normalization; that failure mode is the shell, not the toolchain. TestFlight upload still
holds for Austen's go (his CocoaPods + Unipile deferrals lifted only the build blocker).

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

## 5. Payments — STRIPE ONLY (decided by Austen 2026-07-15; IAP retired)

- **Stripe is the single billing rail — and the iOS app is a 3.1.3(f) FREE STAND-ALONE
  COMPANION APP (adopted 2026-07-15, superseding the brief Safari-checkout design from earlier
  the same day).** The native app has NO purchasing, NO pricing, and NO purchase
  calls-to-action anywhere: the paywall is a neutral "Subscription required" status screen
  (sign in / refresh status / Not now / Terms+Privacy), `startUpgrade` and `openBillingPortal`
  are gated off on native with neutral toasts, the Settings billing row shows status only, and
  the entry helper is Netflix-style ("Accounts can't be created in the app", no URL). All
  purchasing/management happens on the web. Return path when a user subscribes on the web:
  `recheckPlanFromServer()` (paywall "Refresh status" button + an `appStateChange` listener
  that re-checks silently on foreground). Plan truth = Firestore `users/{uid}.plan`, written
  by the Stripe webhook. **Do not reintroduce prices, purchase links, or signup URLs on native
  without a deliberate posture decision — 3.1.3(f) eligibility requires their absence.**
- Price map at `functions/index.js:63-90`: scorecard $10, scorecard_crm $25, team tiers;
  `STRIPE_TRIAL_DAYS=60` (no charge for 60 days; sub pauses if no card added),
  `TEAM_MIN_SEATS=3`.
- **Legacy IAP (RevenueCat):** all client-side RC calls removed from public-scorecard 2026-07-15;
  the function definitions remain behind a LEGACY banner. **Do NOT delete them (CTO directive
  2026-07-15)** — see the legal caveat below. The `revenueCatWebhook` (`functions/index.js:2329`)
  stays live so any legacy IAP subscriber keeps their entitlement. ASC follow-ups (Austen): remove
  the IAP products from the App Store listing, don't attach them to the 1.43 version, and provide
  reviewer demo credentials. **Metadata rider (CTO, 2026-07-15): the 3.1.3(f) discipline applies to
  REVIEW METADATA too — screenshots, description, and What's New must not mention pricing, trials,
  or signup (that's where 3.1.3(f) rejections actually come from). The existing 1.43 What's New
  draft predates this posture and must be re-checked before submission.**
- **LEGAL CAVEAT (CTO, 2026-07-15) — the US external-purchase-link regime is IN FLUX.** The
  Apr 2025 contempt ruling forced fee-free external links; the Ninth Circuit (Dec 2025) restored
  Apple's right to charge a commission on external-link purchases, and SCOTUS took the case for
  the 2026 term. Stripe-only on iOS is correct TODAY; do not assume the fee-free window survives.
  If Apple prevails, the options are paying Apple's external-link commission or re-adding IAP —
  hence the parked RC wiring. Margin planning on mobile subscriptions must not bake in zero
  Apple take.
  **IAP-fallback blueprint (per Apple's "Offering a Subscription Across Multiple Apps," reviewed
  2026-07-15):** there is no automatic cross-app subscription — you create EQUIVALENT products in
  EACH app and propagate entitlement server-side, which is exactly what `users/{uid}.plan` +
  webhooks already do. So the fallback = recreate both tiers as products in BOTH apps + un-park
  the RC wiring; zero new architecture. Hard constraint: cross-app IAP requires all SWH apps
  under ONE Apple developer account — the MyQueso entity re-filing must keep them together.
- **Pre-release check (every iOS release):** verify a legacy IAP subscriber still resolves to the
  correct `users/{uid}.plan` via `revenueCatWebhook` — the single plan-truth invariant must hold
  for both billing populations.

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

**RULED 2026-07-17 — IAP RETURNS, DUAL BILLING (CTO; build authorized, SUBMIT gated on
Austen's veto window):** Apple IAP comes back as an ADDITIVE in-app subscribe path; Stripe
stays on web. Rationale: conversion at the moment of intent (one-tap Face ID) beats ~12pts of
margin; Small Business Program = 15%. Composition with in-app registration (below) unchanged:
everyone starts on our 60-day no-card trial; IAP is the conversion moment at/after expiry.
BINDING RULINGS: (1) entitlement model = source-scoped fields (apple.*/stripe.*/trial.*) with
access COMPUTED server-side in getMe as the union of active entitlements — last-writer-wins on
plan rejected; client NEVER computes entitlement; SWH thread owns and lands FIRST. (2)
doubleBilling flag when both rails active; support policy: user cancels Apple themselves or we
refund/cancel Stripe — never eat a double charge silently. (3) NO Apple intro offer — our trial
is the only free period (double-trial seam deleted by design). (4) Revival = RevenueCat un-park,
not StoreKit rebuild; LEGACY banners come off only as each piece verifies live. (5) Price parity
IAP vs web. (6) Sequence: SWH getMe reconciliation → native revival + subscribe UI + restore →
ASC products verified → 1.44 submission (metadata rider updates: in-app pricing legal again;
3.1.3(f) scrub converts to standard IAP metadata hygiene). CRM triple: no-purchase leg
superseded; login-only + Stripe-web legs stand. (7) HARD GATE on Austen: confirm/enroll App
Store Small Business Program in ASC before pricing screens or margin math. Per-deploy approval
unchanged. THIS THREAD'S STATUS: holding client code until the SWH reconciliation contract
arrives; then revive per (4).

**Update 2026-07-16 PM — IN-APP REGISTRATION (HEY model, Austen; supersedes login-only entry):**
entry = Get Started (create in-app via Google/Apple/email) + Sign In. Bare first-time identities
are ADOPTED at boot: `ensureWebTrial {source:'ios'}` attaches the no-card 60-day trial
(one-trial-per-identity-EVER, subscription-history guard), profile collected in-app, user lands
in the live app. 3.1.3(f) posture UNCHANGED: nothing sold, no pricing, no purchase CTAs — the
HEY precedent (2020) is the compliance anchor. Boot hardening shipped with it: bootNative catch →
recoverable "Something went wrong" screen (Try Again / Sign out) — kills the stranded-loader
freeze class; malformed-data degradation; getMe now returns the mandatory-profile fields (their
omission re-showed onboarding to complete users every boot). Tested: 10-state boot matrix against
real boot code + live server e2e (probe account: signup→trial→contract→profile→one-trial-ever
refusal→self-delete) ALL PASS. Landed f3c70e3 (note: carried the SWH thread's trial-email-spine
WIP as a ride-along), functions + hosting deployed, device build installed. KNOWN GAP: swhFunnel
no-ops on native, so boot_unhandled/boot_trial_attach_failed beacons don't emit from the app —
console-only until the SWH thread opens the emitter to native auth_error events.

**Update 2026-07-15 — registration + billing overhaul (ALL LANDED: c3222d2 carried the
registration/Stripe work, 2c2e724 profile-first, 45ccfd0 login-only; deployed + synced):**
the iOS app is **LOGIN-ONLY** (Austen). Native entry = single Sign In CTA + plain-text pointer
to stopwastinghandshakes.com for account creation; the auth form's create-account toggle is
web-only; submitEmailSignUp is guarded on native. "Try for free"/demo removed from iOS earlier
the same day (web demo funnel intact). "Continue with Microsoft" is web-only + native guard
(its Web-SDK popup hangs in the WKWebView — likely the reported signup freeze). Signed-in
users route profile-first: incomplete profile → onboarding → (if unpaid) Stripe paywall (§5).
KNOWN EDGE: Google/Apple sign-in still implicitly creates a Firebase account for a brand-new
user (client-side unavoidable); such users fall into the onboarding → paywall flow, which is
acceptable but unadvertised. Any 1.43 build must be cut AFTER 45ccfd0 + `cap sync` (done).

**Release state (2026-07-03):** Scorecard 1.43 b30 is archive-ready pending Austen's beta week;
What's New copy is written and with Austen. App Store Connect still pending: the LISTING name change
to "The Scorecard" (may need a uniqueness qualifier) + the 1.43 version record + What's New paste.
**CRM CONVERSION LANDED 2026-07-16 (`be290ed` + `6ac1fb3`, deployed to hosting:crm, ios-crm
bundle synced):** the ratified triple is code-complete — Stripe-only (RC invocations removed,
LEGACY banner, revenueCatWebhook stays live), login-only (signup steering web-only + native
guards incl. doMicrosoftLogin), 3.1.3(f) (native upgrade screen renders neutral "Subscription
required", team pricing web-only, paywall modal neutralized to a status sheet). New plumbing:
recheckCrmPlanFromServer / recheckCrmAccountState / appStateChange re-check / Account-required
screen for bare implicit accounts. Also fixed in passing: a plan-gate bypass (.bottom-nav sits
outside #app-shell and became tappable once the IAP modal overlay was gone — now hidden while
gated), and **in-app account deletion added** (5.1.1(v), confirmDeleteCrmAccount →
deleteAccountSelf). 4.8 parity verified on CRM native (Google + Apple, MS hidden).
**Remaining for CRM App Store prep:** device build + beta verification (same two runs as the
Scorecard: bare identity → Account required; paid account → full access), ASC record + version
bump, 3.1.3(f)-clean metadata, reviewer demo credentials, legacy-IAP plan-resolution check.
NOTE: the CRM's profile-menu "💳 Subscription" item routes to a nonexistent screen (silent
no-op, pre-existing) — cosmetic, SWH thread's surface. Old TestFlight/App Store
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
