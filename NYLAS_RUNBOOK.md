# Nylas cutover — full step-by-step runbook

Do these in order. Steps marked **[you]** are manual (Nylas dashboard / Google / Microsoft).
Steps marked **[cli]** are terminal commands. Everything is already coded; this is activation.

Two Firebase projects: `swh-scoreboard` (SWH Scorecard + CRM) and `loaniq-75a20` (MyLola).

---

## STEP 1 — Provider OAuth apps  [you]

Nylas connects to Google/Microsoft using YOUR OAuth apps. Set these up first.

### Google
1. Google Cloud Console → the project that holds your existing `GOOGLE_OAUTH_CLIENT_ID`.
2. APIs & Services → Enable: **Gmail API**, **Google Calendar API**, **People API**.
3. Credentials → your OAuth 2.0 Client → Authorized redirect URIs → **add**:
   `https://api.us.nylas.com/v3/connect/callback`
4. OAuth consent screen: Gmail send/read/modify are **restricted scopes**. For production
   verification Google requires a CASA security assessment. Until that clears, add your own
   address under **Test users** — testing works fully on an unverified app.

### Microsoft (only if you want Outlook)
1. Azure Portal → App registrations → your app (or create one).
2. Authentication → Redirect URIs → add `https://api.us.nylas.com/v3/connect/callback`.
3. API permissions → Microsoft Graph → delegated: `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`,
   `Calendars.ReadWrite`, `Contacts.Read`, plus `openid profile email offline_access`.
4. Certificates & secrets → new client secret → copy it.

---

## STEP 2 — Nylas application + connectors  [you]

1. Nylas dashboard → create/confirm ONE application, **US region** (`api.us.nylas.com`).
2. Grab two values: the application's **Client ID** (a.k.a. Application ID) and a generated **API Key**.
   NOTE: Nylas v3 has NO separate client secret. Wherever a client secret is needed, you use the
   API key. So in Step 4, `NYLAS_CLIENT_SECRET` is set to the SAME value as `NYLAS_API_KEY`.
3. Connectors (a.k.a. Integrations / Auth) → add **Google**: paste the Google client ID + secret
   from Step 1, check scopes `gmail.send gmail.modify calendar.events contacts` (+ the required
   `openid email profile`). Note: Nylas's connector does not offer `gmail.metadata`, so SWH CRM
   uses `gmail.modify`; `gmail.readonly` is also dropped (modify covers reading).
4. Add **Microsoft** connector the same way (if using Outlook).

---

## STEP 3 — Register OUR redirect URIs in Nylas  [you]

Application → Hosted Authentication / Callback URIs → add BOTH exactly:
- `https://us-central1-swh-scoreboard.cloudfunctions.net/nylasCallback`
- `https://us-central1-loaniq-75a20.cloudfunctions.net/nylasCallback`

---

## STEP 4 — Set the secrets  [cli]

API key / client id / client secret are identical in both projects. The webhook secret comes
LATER (Step 6), so set a placeholder now so the functions can deploy. Each command prompts for
the value on stdin; paste it and press enter.

```bash
# ---- SWH (project swh-scoreboard) ----
cd ~/swh-scoreboard
firebase functions:secrets:set NYLAS_API_KEY        --project swh-scoreboard
firebase functions:secrets:set NYLAS_CLIENT_ID      --project swh-scoreboard
firebase functions:secrets:set NYLAS_CLIENT_SECRET  --project swh-scoreboard   # = your Nylas API key (v3 has no separate secret)
firebase functions:secrets:set NYLAS_WEBHOOK_SECRET --project swh-scoreboard   # type: placeholder
# OAUTH_STATE_SECRET already exists in this project (reused from the gmail flow).

# ---- MyLola (project loaniq-75a20) ----
cd ~/loaniq
firebase functions:secrets:set NYLAS_API_KEY            --project loaniq-75a20
firebase functions:secrets:set NYLAS_CLIENT_ID          --project loaniq-75a20
firebase functions:secrets:set NYLAS_CLIENT_SECRET      --project loaniq-75a20   # = your Nylas API key (v3 has no separate secret)
firebase functions:secrets:set NYLAS_WEBHOOK_SECRET     --project loaniq-75a20   # type: placeholder
firebase functions:secrets:set NYLAS_REDIRECT_URI_MYLOLA --project loaniq-75a20
#   value: https://us-central1-loaniq-75a20.cloudfunctions.net/nylasCallback
```

---

## STEP 5 — Deploy the functions  [cli]

Secrets exist now, so the deploy will bind them.

```bash
# ---- SWH ----
cd ~/swh-scoreboard/functions && npm install      # pulls in the nylas dep
cd ~/swh-scoreboard
firebase deploy --only functions --project swh-scoreboard

# ---- MyLola (predeploy auto-builds via esbuild) ----
cd ~/loaniq
firebase deploy --only functions:mylola --project loaniq-75a20
```

Expected new functions live after this:
- **SWH**: getNylasAuthUrl, nylasCallback, getUpcomingEvents, getContactThreads, getContacts,
  nylasWebhook, nylasStatus, nylasDisconnect, nylasFollowThroughSweep
- **MyLola**: getNylasAuthUrl, nylasCallback, getInbox, getContactThreads, nylasSendEmail,
  getNylasUpcomingEvents, getNylasContacts, nylasWebhook, nylasFollowThroughSweep,
  nylasSaveDraft, nylasListDrafts, nylasDeleteDraft, nylasSendDraft,
  nylasScheduleEmail, nylasProcessScheduledEmails, nylasCancelScheduledEmail

(Same names in both projects is fine — they're separate Firebase projects.)

---

## STEP 6 — Create webhooks + capture signing secrets  [you]

Now that `nylasWebhook` is live (it auto-answers Nylas's verification GET), create the webhooks.

1. Nylas dashboard → Webhooks → Create:
   - **SWH** → URL `https://us-central1-swh-scoreboard.cloudfunctions.net/nylasWebhook`
     triggers: `message.created`, `thread.replied`
   - **MyLola** → URL `https://us-central1-loaniq-75a20.cloudfunctions.net/nylasWebhook`
     triggers: `message.created`, `message.updated`, `thread.replied`, `message.bounce_detected`
2. Nylas shows a **signing secret** for each webhook on creation. They are DIFFERENT per webhook.
   Copy SWH's and MyLola's separately.

---

## STEP 7 — Set the real webhook secrets + redeploy  [cli]

```bash
cd ~/swh-scoreboard
firebase functions:secrets:set NYLAS_WEBHOOK_SECRET --project swh-scoreboard   # SWH webhook's secret
firebase deploy --only functions:nylasWebhook --project swh-scoreboard

cd ~/loaniq
firebase functions:secrets:set NYLAS_WEBHOOK_SECRET --project loaniq-75a20      # MyLola webhook's secret (different!)
firebase deploy --only functions:mylola:nylasWebhook --project loaniq-75a20
```

---

## STEP 8 — Test each product end to end  [you]  (smallest scope first)

### A. SWH Scorecard (calendar only)
1. Open the Scorecard app, sign in, go to Settings.
2. Click Connect Google Calendar (once the Scorecard UI is wired — see Step 9).
   To test the function directly before UI wiring, call `getNylasAuthUrl` with a Bearer ID token
   and `{product:'scorecard'}`, open the returned `authUrl`, complete consent.
3. Confirm Firestore `users/{uid}/integrations/nylas` exists with `status:'active'`.
4. Confirm `getUpcomingEvents` returns your next 7 days.

### B. SWH CRM (email + calendar + contacts)
1. CRM → Settings → Email & Calendar → Connect Google Account (already wired).
2. Confirm the grant doc, then verify: contact threads (`getContactThreads`), calendar, and
   `getContacts` sync into `users/{uid}/nylasContacts`.
3. Send yourself an email → confirm `nylasWebhook` logged `message.created` and the contact's
   `lastActivityAt` updated (or an `inboundUnmatched` doc for an unknown sender).

### C. MyLola (full email)
1. `/scheduling/connections` → Connect Gmail (already wired).
2. Visit `/inbox-nylas` → confirm `getInbox` lists threads; send a test via the composer.
3. Confirm `users/{uid}/emailThreads/{threadId}` cache populates.
4. Bounce test: send to a known-bad address → confirm `email_bounced` activity on the matched
   household/partner (bounces only fire for mail sent THROUGH Nylas, threaded to the original).
5. LOLA: confirm loan-keyword emails create a `lolaSignals` doc.

Check function logs while testing:
```bash
firebase functions:log --only nylasWebhook --project swh-scoreboard
firebase functions:log --only nylasWebhook --project loaniq-75a20
```

---

## STEP 9 — Finish the UI wiring  [cli/code]

Already wired: MyLola connections page (Connect buttons), MyLola `/inbox-nylas`, SWH CRM settings
connect. Remaining (Claude can do these on request):
- SWH Scorecard `public-scorecard/index.html` — calendar connect + dashboard widget.
- SWH CRM — dashboard calendar panel + contact-profile email panel.
- MyLola — contact/household email panel, home calendar panel, point the inbox nav at `/inbox-nylas`.
- SWH `crm.html` — re-sync from `public-crm/index.html` first (it has diverged), then the wiring
  carries over for the Capacitor build.

Deploy hosting after wiring:
```bash
cd ~/swh-scoreboard && firebase deploy --only hosting:scorecard,hosting:crm --project swh-scoreboard
cd ~/loaniq && (build the mylola app, then) firebase deploy --only hosting:mylola --project loaniq-75a20
```

---

## STEP 10 — Migrate users + retire the legacy code  [you + cli]  (only after Step 8 passes)

1. **Re-consent**: a Nylas grant is a fresh OAuth, so every already-connected user must click
   Connect once. Announce it; keep both paths live during the window.
2. **Switch the UI** to Nylas-only (remove the legacy Gmail/Outlook connect buttons).
3. **Delete legacy functions** once nothing calls them:
   - SWH: `gmailOauth*`, `gmailStatus`, `gmailDisconnect`, `gmailRunBackfill`, `gmailScheduledSync`,
     `outlookOauth*`, `pushContactToOutlook` (+ helpers) in `functions/index.js`.
   - MyLola: the `email/` subsystem, `calendar/oauthGoogle|oauthMicrosoft|listGoogleCalendarEvents`,
     `google/`, `microsoft/`, `contacts-sync/`, and `@loaniq/google-connectors` (re-point `lola-sms`).
   ```bash
   firebase functions:delete gmailOauthInitiate gmailOauthCallback ... --project swh-scoreboard
   firebase functions:delete <legacy names> --project loaniq-75a20
   ```
4. Remove the dead source + secrets (`GOOGLE_OAUTH_*`, `MICROSOFT_OAUTH_*`) once unused.

---

## Gotchas
- **Order matters**: secrets must exist before Step 5 deploy; the webhook secret is a placeholder
  until Step 7 because Nylas only reveals it at webhook creation (Step 6).
- **Per-webhook secret**: SWH and MyLola get DIFFERENT `NYLAS_WEBHOOK_SECRET` values.
- **Redirect URIs** must match the registered values exactly, or consent fails.
- **Google restricted scopes** need CASA before the unverified-app warning clears for all users.
- Full architecture + file map + caveats: `NYLAS_INTEGRATION.md`.
