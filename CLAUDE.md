# SWH (Stop Wasting Handshakes) — Claude Code Instructions

Repo root: `~/swh-scoreboard`. Firebase project: `swh-scoreboard`.

---

## What this is

Stop Wasting Handshakes is a networking-productivity platform:

- **Scorecard** ($10/mo) — daily activity tracker, tier progression, weekly recap emails
- **Pro CRM** ($25/mo) — full CRM. Web: `crm.stopwastinghandshakes.com`. The same file ships as the native CRM iOS app (`ios-crm/` bundles `public-crm/` directly)

---

## Repo layout

```
public-scorecard/        Scorecard web app (app.stopwastinghandshakes.com)
  index.html             Scorecard SPA — the main app
  crm.html               LEGACY stale Scorecard v18 snapshot — NOT the CRM (see below)
public-crm/              CRM web app (crm.stopwastinghandshakes.com)
  index.html             CRM source of truth — serves web AND the native CRM iOS bundle
public-admin/            Admin panel (swh-admin.web.app)
public-landing/          Marketing landing (stopwastinghandshakes.com)
functions/               Cloud Functions (Node 24 CJS, deployed to swh-scoreboard)
ios-scorecard/           Capacitor iOS — App Store build (bundle: com.impactleadershipgroup.swh.scorecard)
ios-crm/                 Capacitor iOS — CRM app (bundle: com.impactleadershipgroup.swh.crm, webDir ../public-crm)
ios-combined/            Capacitor iOS — dev/test build (bundle: com.impactleadershipgroup.swh.combined)
firebase.json            Hosting targets config
firestore.rules          Firestore security rules
```

### CRM source of truth (the "two-file rule" is retired — 2026-07-06)

`public-crm/index.html` is the ONLY CRM file. It serves the web CRM at
crm.stopwastinghandshakes.com AND is bundled directly into the native CRM iOS app
(`ios-crm/capacitor.config.json` has `webDir: "../public-crm"`). All native-iOS behavior
(safe-area CSS, `html.native-platform` rules, native paywall, `showNativeSignedOut`) lives
inline in that one file behind `window.Capacitor?.isNativePlatform()` guards — there is no
separate patched copy to maintain.

`public-scorecard/crm.html` is NOT a CRM copy. It is a stale "SWH Scoreboard v18" snapshot
that has never contained CRM code in this repo's history (verified across every commit,
2026-07-06). Nothing in the current apps links to it — the Scorecard reaches the CRM via
`goToCRM()` → crm.stopwastinghandshakes.com with a cross-product token handoff. Do NOT
port or mirror CRM features into it. It is a deletion candidate (Austen's call; until
removed it is still publicly served at app.stopwastinghandshakes.com/crm.html, so its
user-visible copy — tier messages, em-dash sweeps — is kept from drifting).

After editing `public-crm/index.html`:
```bash
firebase deploy --only hosting:crm
cd ios-crm && npx cap sync ios   # refresh the native CRM bundle
```

---

## Firebase projects

| Surface | Project | Notes |
|---|---|---|
| SWH primary | `swh-scoreboard` | Auth, Firestore, Cloud Functions, Hosting |
| MyAppointment.AI | `myappointment-ai-8756e` | Cross-project via SA key secret |

---

## MyAppointment.AI integration — FULLY DEPLOYED, DO NOT REBUILD

Everything below is live. Do not re-implement any of it.

### Architecture note

mylola.ai / myappointment.ai scheduling data lives in **`loaniq-75a20`** (the LoanIQ shared project), NOT `myappointment-ai-8756e`. The `myappointment-ai-8756e` project is only used by `mintApptCustomToken` to provision Auth users and mint tokens for plan-sync.

Client-side Firestore reads from either external project are always `permission-denied`. All reads go through the `getApptData` Cloud Function, which uses `LOANIQ_SERVICE_ACCOUNT_KEY` (firebase-adminsdk SA for `loaniq-75a20`) to read scheduling data via admin SDK. There is NO secondary Firebase app in the client (`apptApp`/`apptAuth`/`apptDb`) — those were removed.

### Client-side (`public-crm/index.html`)

```javascript
// State — populated by loadApptData() via getApptData Cloud Function
let apptUserSlug    = '';  // users/{uid}/schedulingProfile/main .userSlug
let apptBookingPages = []; // users/{uid}/bookingPages
let upcomingMeetings = []; // users/{uid}/meetings start>=now, status=scheduled
```

After every sign-in, `bridgeToMyAppointment()` fires:
1. Fires `mintApptCustomToken` async, result ignored (plan-sync side-effect only)
2. Calls `loadApptData()` — calls `getApptData` CF, populates state, re-renders UI

`openApptDashboard()` opens `https://mylola.ai` in a new tab. Used by "Manage ↗" and empty-state setup buttons. When no booking pages exist, Appointments screen shows "Set up on mylola.ai ↗". Settings > My Booking Link button becomes blue "Set up ↗" when no link is available.

UI surfaces wired:
- **Appointments screen** — booking pages list + upcoming meetings list (sidebar + mobile bottom nav)
- **Dashboard "Next Meeting" card** — shows next meeting when available
- **Contact "Book" action button** — appears on contact profiles when apptUserSlug is loaded
- **Settings > Scheduling section** — booking link (copy or set-up), meeting count, manage link
- **Book Contact modal** (`#book-contact-overlay`) — pick page, copy or open link for a contact

### Cloud Functions (`functions/index.js`)

- **`getApptData`** (callable, auth required) — reads schedulingProfile, bookingPages, meetings from `myappointment-ai-8756e` via admin SDK. Resolves appt UID via `getUserByEmail()` so SWH uid != appt uid is handled automatically. Returns `{ userSlug, bookingPages[], meetings[] }` with `.start` as ISO string. Secret: `MYAPPOINTMENT_SERVICE_ACCOUNT_KEY`.
- **`mintApptCustomToken`** (callable, auth required) — provisions user in `myappointment-ai-8756e` Auth via email lookup, mints custom token for plan-sync side-effect. Secret: `MYAPPOINTMENT_SERVICE_ACCOUNT_KEY`.
- **`stripeWebhook`** — on `customer.subscription.updated/created` with `pro` plan, calls `syncApptPlan()` fire-and-forget.
- **`syncApptPlan(uid, billingRef)`** — POSTs to `https://us-central1-loaniq-75a20.cloudfunctions.net/upgradePlan` with `{ email, tier:'swh', billingRef }`. Uses `.trim()` on secret. Secret: `MYAPPOINTMENT_UPGRADE_SECRET`.
- One-time backfill `migrateProUsersToAppt` ran 2026-05-28, removed (stub comment remains at bottom of `functions/index.js`).

### myappointment-ai Firestore schema (canonical — confirmed from loaniq source)

```
users/{uid}/schedulingProfile/main      .userSlug  (public URL username)
users/{uid}/bookingPages/{pageId}       .displayName, .slug, .isPublic, .isPublishable
users/{uid}/meetings/{meetingId}        .status ('scheduled'), .start (Timestamp),
                                        .bookingPageId, .location {type, detail}
                                        NOTE: no .guestName/.guestEmail on meeting doc —
                                        guest linked via .subject {type, id} to household/partner
```

### Required secrets in `swh-scoreboard` project

| Secret | Purpose |
|---|---|
| `MYAPPOINTMENT_SERVICE_ACCOUNT_KEY` | SA JSON for `myappointment-ai-8756e` |
| `MYAPPOINTMENT_UPGRADE_SECRET` | Bearer token for `upgradePlan` endpoint |

---

## iOS / Capacitor rules (CRITICAL)

Firebase Web Auth and Firestore SDK **hang silently** on `capacitor://` origin. On native iOS:
- **Never** use `firebase/auth` or `firebase/firestore` directly on the native path
- Detect native: `window.Capacitor?.isNativePlatform()` (set early as `isNativeEarly`)
- All authenticated iOS data goes through HTTPS Cloud Functions
- Bootstrap module initialization MUST be at end of module (not top-level await)

Native Cloud Functions used from Scorecard iOS:
`getMe`, `saveDay`, `saveLag`, `saveSettings`, `approveWaitlistUser`, `deleteUser`, `submitWaitlist`, `scanBusinessCard`

### iOS builds

| Project | Bundle ID | Notes |
|---|---|---|
| `ios-scorecard/` | `com.impactleadershipgroup.swh.scorecard` | App Store build, build 10 uploaded |
| `ios-crm/` | `com.impactleadershipgroup.swh.crm` | CRM app — bundles `public-crm/` directly |
| `ios-combined/` | `com.impactleadershipgroup.swh.combined` | Dev/test build — includes CRM tab |

`ios-combined/` uses `webDir: "../public-scorecard"` and hostname `app.stopwastinghandshakes.com`. It has its own `GoogleService-Info.plist` registered in `project.pbxproj`.

---

## Hosting targets

| Target | Dir | URL |
|---|---|---|
| `scorecard` | `public-scorecard/` | app.stopwastinghandshakes.com |
| `crm` | `public-crm/` | crm.stopwastinghandshakes.com |
| `admin` | `public-admin/` | swh-admin.web.app |
| `landing` | `public-landing/` | stopwastinghandshakes.com |

---

## Firestore collections (SWH primary)

```
/users/{uid}
  /days/{dateKey}          daily activity log
  /lag/{date}              meeting lag tracking
  /contacts/{id}           CRM contacts
  /opportunities/{id}      deals/opportunities
  /config/settings         user preferences
/teams/{teamId}            team subscriptions
/announcements             platform announcements
/platform/activities       activity catalog
/waitlist                  pre-signup email capture
```

---

## Stripe plan structure

| Plan | Price ID | Monthly |
|---|---|---|
| `scorecard` | `price_1TV0G35dEXTl1F5TvTpDo7kq` | $10 |
| `pro` (CRM) | `price_1TWSjh5dEXTl1F5TonpKPaOb` | $25 |
| `team` | `price_1TZHb75dEXTl1F5Tu7dWgMIk` | volume |
| `team_crm` | `price_1TZfBe5dEXTl1F5T5vGF3vum` | volume |

60-day trial. `STRIPE_RETURN_BASE = 'https://swh-scoreboard.web.app'`

---

## Pending work

- **App Review** — Build 10 is uploaded to App Store Connect. Need to: link subscription, reply to Apple's Guideline 3 message, submit build for review.
- **RevenueCat → Firestore sync** — RevenueCat webhook should write plan status to Firestore so iOS native knows the user's plan without a Cloud Function roundtrip.
- **Android build** — No Android device on hand. Deferred until device is available.

---

## Decisions already made — don't re-open

- CJS not ESM for `functions/index.js`
- RevenueCat for Apple IAP — NOT wired to MyAppointment plan sync (intentional for now)
- `MYAPPOINTMENT_UPGRADE_SECRET` uses `.trim()` comparison (secret was set with trailing newline via pipe)
- `body.modal-open` must NOT use `position:fixed` — breaks iOS WKWebView touch targets
- MutationObserver in Scorecard watches specific modal elements only, not full DOM subtree
- The `crm.html` "two-file rule" is retired (2026-07-06): `public-scorecard/crm.html` is a stale Scorecard v18 snapshot, not a CRM copy. The CRM ships from `public-crm/index.html` everywhere (web + `ios-crm/` bundle)
