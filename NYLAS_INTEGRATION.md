# Nylas v3 unified integration — setup, cutover & retirement

One Nylas application, one API key, serving two Firebase projects. This doc is the
source of truth for the steps that need **your Nylas dashboard + credentials**
(which Claude cannot do) and the staged retirement of the legacy email/calendar code.

A copy of this file lives in both repos: `~/loaniq` and `~/swh-scoreboard`.

---

## 1. Reality vs. the original spec

The spec assumed three separate Firebase projects and Doppler. Neither is true here.

| Spec assumed | Actual |
|---|---|
| Projects `swh-scoreboard`, `swh-crm`, `mylola-crm` | **2 projects.** `swh-scoreboard` (Scorecard **and** CRM are hosting targets sharing one Functions backend) and `loaniq-75a20` (MyLola; `mylola-crm` is a hosting site, not a project) |
| Callbacks at `…swh-crm…` / `…mylola-crm…` | `https://us-central1-swh-scoreboard.cloudfunctions.net/nylasCallback` and `https://us-central1-loaniq-75a20.cloudfunctions.net/nylasCallback` |
| Secrets in **Doppler** | **Firebase Secret Manager** (`defineSecret`), matching the rest of both codebases. If you later standardize on Doppler, pipe Doppler → `firebase functions:secrets:set`; the function bindings do not change |
| All SWH functions TypeScript | SWH Functions backend is **CommonJS JavaScript**; the Nylas code matches it (`functions/nylas.js`). MyLola is TypeScript |
| Greenfield | **Not greenfield.** SWH already had `gmail*`/`outlook*` direct-OAuth functions; MyLola has a ~40-file Gmail/Graph email subsystem + Google/Microsoft calendar OAuth + `@loaniq/google-connectors`. Per your decision, Nylas **replaces** these — staged, see §6 |

Because Scorecard + CRM share one Functions backend, there is **one** product-parameterized
`getNylasAuthUrl`/`nylasCallback` for SWH (the `product` field selects scopes), not two.

---

## 2. What was built (all committed, syntax/type-checked, not yet deployed)

### SWH (`~/swh-scoreboard`, project `swh-scoreboard`) — CommonJS
- `functions/nylas.js` — `getNylasAuthUrl`, `nylasCallback`, `getUpcomingEvents`,
  `getContactThreads`, `getContacts`, `nylasWebhook`, `nylasFollowThroughSweep`,
  `nylasStatus`, `nylasDisconnect`. Re-exported via one line at the bottom of `functions/index.js`.
- `public-scorecard/nylas-calendar.js` — `SWHNylasCalendar.mountConnect()` (ConnectCalendar) + `mountWidget()` (CalendarWidget).
- `public-crm/nylas-email.js` — `SWHNylasEmail.mountConnect()` (ConnectAccounts) + `mountContactPanel()` (ContactEmailPanel) + `mountCalendar()` (CalendarPanel).
- `functions/package.json` — added `nylas` dep (installed).

### MyLola (`~/loaniq`, project `loaniq-75a20`) — TypeScript
- `functions/mylola/src/nylas/client.ts` — shared client, scope maps, helpers.
- `functions/mylola/src/nylas/functions.ts` — `getNylasAuthUrl`, `nylasCallback`,
  `getInbox` (paginated 50), `getContactThreads`, `sendEmail`→exported as **`nylasSendEmail`**,
  `getUpcomingEvents`→**`getNylasUpcomingEvents`**, `getContacts`→**`getNylasContacts`**
  (aliased to avoid colliding with the existing functions until cutover).
- `functions/mylola/src/nylas/webhook.ts` — `nylasWebhook` (message.created/updated, thread.replied, **message.bounce_detected**) + `nylasFollowThroughSweep` + LOLA triggers + bounce matching.
- `functions/mylola/src/nylas/drafts.ts` — `nylasSaveDraft`, `nylasListDrafts`, `nylasDeleteDraft`, `nylasSendDraft` (provider-side drafts).
- `functions/mylola/src/nylas/scheduled.ts` — `nylasScheduleEmail`, `nylasProcessScheduledEmails` (5-min cron), `nylasCancelScheduledEmail`.
- `functions/mylola/src/index.ts` — exports added; `pnpm typecheck` + `pnpm build` pass.
- `apps/mylola/components/nylas/NylasPanels.tsx` — `ConnectAccounts`, `InboxView` (+ compose/reply), `ContactEmailPanel`, `CalendarPanel`. Type-clean against the app tsconfig.

Grant doc (both projects): `users/{uid}/integrations/nylas` exactly per the spec schema.
Reverse lookup `nylasGrants/{grantId}` → `{ uid }` (webhook resolution). **Grant IDs never leave the server.**
MyLola thread cache: `users/{uid}/emailThreads/{threadId}` per spec.

---

## 3. Set the secrets (Firebase Secret Manager)

API key / client id / client secret are the same across both projects;
`NYLAS_WEBHOOK_SECRET` is **per-webhook** so it differs between SWH and MyLola (see §4).
Run in each repo (the second targets `loaniq-75a20`):

```bash
# In ~/swh-scoreboard
firebase functions:secrets:set NYLAS_API_KEY
firebase functions:secrets:set NYLAS_CLIENT_ID
firebase functions:secrets:set NYLAS_CLIENT_SECRET
firebase functions:secrets:set NYLAS_WEBHOOK_SECRET
# OAUTH_STATE_SECRET already exists in swh-scoreboard (used by the gmail flow); reused.

# In ~/loaniq  (deploys to loaniq-75a20)
firebase functions:secrets:set NYLAS_API_KEY
firebase functions:secrets:set NYLAS_CLIENT_ID
firebase functions:secrets:set NYLAS_CLIENT_SECRET
firebase functions:secrets:set NYLAS_WEBHOOK_SECRET
firebase functions:secrets:set NYLAS_REDIRECT_URI_MYLOLA
#   value: https://us-central1-loaniq-75a20.cloudfunctions.net/nylasCallback
```

SWH's redirect URI is hardcoded in `nylas.js` (matching the gmail convention); MyLola's is a
secret (matching the mylola convention). The original spec's Doppler names map 1:1:
`NYLAS_REDIRECT_URI_SWH_SCORECARD` + `…_SWH_CRM` collapse into SWH's single hardcoded callback;
`NYLAS_REDIRECT_URI_MYLOLA` → the secret above.

---

## 4. Nylas dashboard setup (your account — Claude cannot do this)

1. **One application**, US data region (`https://api.us.nylas.com`). Grab API Key / Client ID / Client Secret → the secrets in §3.
2. **Connectors** (auth providers): configure Google and Microsoft with these provider scopes:
   - Google: `gmail.readonly`, `gmail.send`, `gmail.modify`, `gmail.metadata`, `calendar.events`, `contacts` (+ `openid email profile`). SWH Scorecard only needs `calendar.events`; CRM needs `gmail.metadata`+`calendar.events`+`contacts`; MyLola needs the full set. The code requests the right subset per product.
   - Microsoft: `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, `Mail.ReadBasic`, `Calendars.ReadWrite`, `Contacts.Read` (+ `openid profile email offline_access`).
   - Google restricted scopes (`gmail.*`) require a Google CASA/security assessment for production verification. Until then, test users + unverified app work. (MyLola's existing google OAuth deliberately dropped Gmail scopes to stay on the light track — adopting Nylas Gmail send/read re-introduces that assessment. Confirm before going wide.)
3. **Redirect URIs** — register exactly:
   - `https://us-central1-swh-scoreboard.cloudfunctions.net/nylasCallback`
   - `https://us-central1-loaniq-75a20.cloudfunctions.net/nylasCallback`
4. **Webhooks** — create one per project. Nylas generates a **signing secret per webhook**, so SWH and MyLola get *different* secrets; set each project's `NYLAS_WEBHOOK_SECRET` to its own webhook's value (the spec's "same value everywhere" is wrong on this point):
   - SWH → `https://us-central1-swh-scoreboard.cloudfunctions.net/nylasWebhook`, triggers: `message.created`, `thread.replied`
   - MyLola → `https://us-central1-loaniq-75a20.cloudfunctions.net/nylasWebhook`, triggers: `message.created`, `message.updated`, `thread.replied`, `message.bounce_detected`
   - The handler answers the GET `challenge` automatically; deploy the function first so the URL is live before you save the webhook.

---

## 5. Deploy + end-to-end test (the spec's build-order steps 5/9)

```bash
# SWH
cd ~/swh-scoreboard/functions && npm install
firebase deploy --only functions:getNylasAuthUrl,functions:nylasCallback,functions:getUpcomingEvents,functions:getContactThreads,functions:getContacts,functions:nylasWebhook,functions:nylasStatus,functions:nylasDisconnect,functions:nylasFollowThroughSweep

# MyLola
cd ~/loaniq/functions/mylola && pnpm build
firebase deploy --only functions:getNylasAuthUrl,functions:nylasCallback,functions:getInbox,functions:getContactThreads,functions:nylasSendEmail,functions:getNylasUpcomingEvents,functions:getNylasContacts,functions:nylasWebhook,functions:nylasFollowThroughSweep
```

Test order (smallest scope first, per the spec):
1. **Scorecard** — connect Google Calendar from Settings, confirm grant doc at `users/{uid}/integrations/nylas`, confirm CalendarWidget lists next-7-days events.
2. **SWH CRM** — connect (all 3 scopes), confirm contact threads + calendar + contact sync; send yourself an email and confirm the `nylasWebhook` fires `message.created` (check logs + `lastActivityAt` / `inboundUnmatched`).
3. **MyLola** — connect Gmail, confirm `getInbox`, send via `nylasSendEmail`, confirm `emailThreads` cache + LOLA signals (`lolaSignals`, loan-keyword flag).

---

## 6. Retiring the legacy integrations (staged — do NOT delete before §5 passes)

Nothing built here deletes or alters the old code. Retire only after the Nylas path is
live-tested and users are re-consented (a Nylas grant is a fresh OAuth; existing users must reconnect once).

### SWH
- Legacy: `gmailOauthInitiate/Callback`, `gmailStatus`, `gmailDisconnect`, `gmailRunBackfill`,
  `gmailScheduledSync`, `outlookOauthInitiate/Callback`, `pushContactToOutlook`, and the helpers
  in the "EMAIL INTEGRATION — Gmail OAuth" block of `functions/index.js`.
- Frontend: the `gContactsToken`/`gcalToken` direct-Google calls + "Email Integrations" Gmail UI in `public-crm/index.html`.
- Steps: cut the UI over to the new modules → migrate connected users → delete the gmail*/outlook* exports → `firebase functions:delete`.

### MyLola (the big one)
- Legacy: the ~40-file `functions/mylola/src/email/*` subsystem (Gmail watch/push real-time sync,
  drafts, send, threads, Outlook equivalents, bounce processing, scheduled sends, smart matching,
  `lolaDraftReply`), `calendar/oauthGoogle`+`oauthMicrosoft`+`listGoogleCalendarEvents`, `google/`,
  `microsoft/`, `contacts-sync/`, and `@loaniq/google-connectors` (consumed by `lola-sms`).
- This is a multi-step migration, not a swap. Map each legacy capability to its Nylas equivalent
  before deleting anything:
  | Legacy | Nylas replacement | Gap to close |
  |---|---|---|
  | `syncGmailInbox`/`gmailPushHandler` (real-time) | `nylasWebhook` message.created | confirm webhook latency is acceptable vs. Gmail push |
  | `listGmailMessages`/`getGmailThread` | `getInbox`/`getContactThreads` | thread/message detail view parity |
  | `sendEmail`/`sendOutlookEmail` | `nylasSendEmail` | attachments, templates, mail-merge variables |
  | `saveGmailDraft`/`listGmailDrafts`/`deleteGmailDraft` (+ Outlook) | `nylasSaveDraft`/`nylasListDrafts`/`nylasDeleteDraft`/`nylasSendDraft` ✓ built | provider-side drafts via Nylas Drafts API |
  | `scheduledEmails` (`scheduleEmail`/`processScheduledEmails`/`cancelScheduledEmail`) | `nylasScheduleEmail`/`nylasProcessScheduledEmails`/`nylasCancelScheduledEmail` ✓ built | Firestore queue `users/{uid}/nylasScheduledEmails` + 5-min cron; subject activity on send |
  | `processBounces` (DSN parsing) | `message.bounce_detected` in `nylasWebhook` ✓ built | only catches bounces for mail sent THROUGH Nylas and threaded to the original; writes `email_bounced` activity matched to households/partners |
  | `listGoogleCalendarEvents` | `getNylasUpcomingEvents` | full calendar CRUD if needed |
  | `@loaniq/google-connectors` in `lola-sms` | Nylas grant read | re-point `lola-sms` Gmail/Calendar reads |
- Until those gaps are closed, run Nylas **alongside** the legacy subsystem behind a per-user flag.

---

## 7. Known caveats / schema-binding TODOs

- **Contact/household resolution** (webhooks + follow-through) currently queries
  `users/{uid}/contacts where email == X`. MyLola's CRM is household-centric
  (`users/{uid}/households/...`, `referralPartners`). Bind the lookup to the real contact index
  (`functions/mylola/src/contactIndex`) at the spots marked `CUTOVER` in `webhook.ts`.
- **`lastOutboundAt` type** — the follow-through sweep compares `lastOutboundAt` as an ISO string.
  Some existing docs store Firestore Timestamps. Pick one type per collection or the `where('<')`
  filter is unreliable. `nylasSendEmail` writes ISO; reconcile with the CRM's existing writers.
- **The 7-day "no reply" rule** is time-based, so it is a daily scheduled sweep
  (`nylasFollowThroughSweep`), not a webhook event, despite the spec listing it under webhooks.
- **SWH iOS CRM** — no `crm.html` step: the CRM iOS app (`ios-crm/`) bundles `public-crm/`
  directly, so `public-crm/index.html` + `public-crm/nylas-email.js` wiring carries over via
  `npx cap sync ios`. (`public-scorecard/crm.html` is a stale Scorecard snapshot, not a CRM
  copy — the two-file rule was retired 2026-07-06.)
- **Frontend embed** — SWH modules expose `mount*` functions; add a `<script>` tag + container
  and call them from the existing settings/dashboard render code. MyLola: import the components
  into `app/settings/connections`, `app/inbox`, the contact/household view, and a dashboard slot.
- **Nylas SDK version** — installed `nylas@7.13.3` (npm package v7.x = API v3). v8.x exists; pin v7 until you validate v8.

---

## 8. Status checklist

- [x] SWH Nylas backend (Scorecard + CRM) — written, `node --check` clean, SDK methods verified
- [x] SWH frontends — written, `node --check` clean
- [x] MyLola Nylas backend — written, `pnpm typecheck` + `pnpm build` pass
- [x] MyLola React components — written, type-clean against app tsconfig
- [x] MyLola feature-parity gaps — drafts, scheduled send, bounce handling built; `pnpm typecheck` + `pnpm build` pass
- [ ] Secrets set (§3) — **you**
- [ ] Nylas dashboard: connectors, redirect URIs, webhooks (§4) — **you**
- [ ] Deploy + end-to-end test (§5) — **you**
- [ ] Wire frontend mounts/imports into the live UIs (§7) — small, can be done next
- [ ] Staged retirement of legacy integrations (§6) — after tests pass

---

## 9. UI wiring status

Done (additive — legacy connect paths left intact until cutover):
- **MyLola** `app/scheduling/connections` — `ConnectAccounts` mounted at top with a `?nylas=connected|error` result banner (`NylasConnectSection`).
- **MyLola** `app/inbox-nylas/page.tsx` — new route rendering `InboxView` + `CalendarPanel` (the live `app/inbox` is untouched).
- **MyLola** `nylasCallback` `returnTo` default fixed to `/scheduling/connections`.
- **SWH CRM** `public-crm/index.html` — `#nylas-connect-mount` container in the Settings → Email & Calendar card; idempotent `SWHNylasEmail.mountConnect` in the `onAuthStateChanged` ready path (token getter wired to the module-scoped `auth`); `nylas-email.js` script include. `nylas-email.js` also copied to `public-scorecard/` for the Capacitor `crm.html`.

Remaining wiring:
- ~~SWH `crm.html` re-sync~~ — dropped 2026-07-06: `public-scorecard/crm.html` turned out to be a stale Scorecard v18 snapshot, not a diverged CRM copy. The CRM iOS app (`ios-crm/`) bundles `public-crm/` directly; there is no second CRM file to wire.
- **SWH Scorecard** `public-scorecard/index.html` — add `nylas-calendar.js` + `SWHNylasCalendar.mountConnect` (settings) and `mountWidget` (dashboard), same pattern as CRM.
- **SWH CRM** — mount `SWHNylasEmail.mountCalendar` on the dashboard and `mountContactPanel(el, email)` in the contact profile.
- **MyLola** — `ContactEmailPanel` in the contact/household detail (`app/contact`), `CalendarPanel` on the dashboard/home, and switch the inbox nav link to `/inbox-nylas` at cutover.
- **At cutover**: remove the legacy Gmail/Outlook connect rows (SWH) and the direct-OAuth provider buttons (MyLola connections page).
