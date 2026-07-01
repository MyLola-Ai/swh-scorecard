# Google OAuth verification — prep pack

Everything ready to go for verifying the **Lola OAuth** Google Cloud app (it serves both
MyLola and SWH, one shared app). Marked **[you]** vs **[Claude can apply]**. Nothing here is
deployed yet — the live connect flow is untouched.

> Not needed for the beta. Test users (100) bypass all of this. This is only for going public.

---

## 0. The blockers I found (fix these or Google bounces the submission)

1. **Privacy policy doesn't mention Gmail/email.** `apps/mylola/app/privacy/page.tsx` discloses
   Calendar + Contacts (line ~59-60) and the Limited Use section (line ~93) only covers those.
   We now request **Gmail** scopes, so the policy must disclose email use too. Ready-to-paste fix in §2.
2. **Scope over-ask: `gmail.modify`.** Our code only **reads** and **sends** email; it never writes
   back to Gmail (no mark-read, label, archive). Google requires the *narrowest* scope, so they'll
   likely reject `gmail.modify` and tell you to use `gmail.readonly`. **Recommend downgrading to
   `gmail.readonly` + `gmail.send`** (both still restricted → still CASA, but a clean justification).
   See §3. (`gmail.readonly` IS available in the Nylas connector checkbox list.)
3. **Contacts policy says "one-way, we don't read your contacts back"** (privacy line ~60). That's
   true only if we *don't* use `getNylasContacts` (the pull). Decide: keep it push-only (policy stays
   accurate) or enable the pull (update the policy). See §3.

---

## 1. Ordered checklist

**Phase 1 — branding + domain [you]**
- [ ] Verify `mylola.ai` in Google Search Console (DNS TXT in GoDaddy).
- [ ] OAuth consent screen → Branding: app name, support email, **logo (120×120 PNG)**,
      homepage `https://mylola.ai`, privacy `https://mylola.ai/privacy`, terms `https://mylola.ai/terms`.
- [ ] Apply the privacy-policy update (§2) and redeploy the mylola site so the live page covers Gmail.

**Phase 2 — code prep [Claude can apply, with you testing]**
- [ ] Decide scopes (§3): downgrade `gmail.modify` → `gmail.readonly` + keep `gmail.send`.
- [ ] Swap the connect button to a compliant **"Sign in with Google"** button (§5).
- [ ] Re-add the Nylas `prompt` param with a *valid* value (§5). Needs a live re-test, so we do this
      together, last time we touched `prompt` it broke connect.

**Phase 3 — submit [you, with my drafted materials]**
- [ ] Publish app (Audience → Publish app, Testing → In production).
- [ ] Paste scope justifications (§4).
- [ ] Record + upload the demo video (§6 script), paste the YouTube link.
- [ ] Submit for verification.

**Phase 4 — CASA [you + Claude]**
- [ ] Engage **TAC Security** (~$540/yr, Google's preferred partner) for a CASA Tier 2 assessment.
- [ ] I help remediate any code findings.
- [ ] Submit the Letter of Validation to Google.

---

## 2. Privacy policy — ready-to-paste additions

**Add to the "what we collect" list** (next to the Calendar/Contacts bullets, ~line 60):
```
<li>Gmail and Outlook email: the messages in the mailbox you connect. We read them to
automatically log correspondence onto the matching client and household timelines and to show
your inbox inside MyLola, and we send messages that you compose or schedule. We do not read,
log, or store messages with people who are not in your CRM beyond what is needed to match them.</li>
```

**Replace the Limited Use sentence** (~line 93) so it covers email:
```
<strong>Limited use.</strong> MyLola's use and transfer of information received from Google APIs to
any other app adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google
API Services User Data Policy</a>, including the Limited Use requirements. We use Google email,
Calendar, and Contacts data only to provide the email-logging, sending, scheduling, and
contact-sync features you turn on. We never sell it, never share it with data brokers, never use it
for advertising, and never use it to train AI or machine-learning models. No human reads it except
where you ask us to, where it is needed for security or to fix a failed sync, or where we are
compelled by law. The same limits apply to the Microsoft (Outlook) data you connect.
```

(If you keep contacts push-only, the existing "one-way, we do not read your contacts back" line stays
correct. If you enable `getNylasContacts`, delete that clause.)

---

## 3. Scope decision (do this before submitting)

| Scope requested today | Used for | Recommendation |
|---|---|---|
| `gmail.modify` | reading inbox + threads (we never write to Gmail) | **Downgrade → `gmail.readonly`** |
| `gmail.send` | composing/sending/scheduled email | keep |
| `calendar.events` | show upcoming events + write 8-step/booking events | keep (read+write justified) |
| `contacts` | push CRM contacts into Google Contacts | keep (full scope required for write; no write-only scope exists) |

Downgrading `modify→readonly` means: edit the scope maps (`functions/mylola/src/nylas/client.ts`
and `swh-scoreboard/functions/nylas.js`), tick `gmail.readonly` instead of `gmail.modify` in the
Nylas Google connector, and on the Google consent screen. I can do the code; you do the two dashboards.
(If you later want inbox actions like mark-read/archive, we go back to `gmail.modify` and justify it.)

---

## 4. Scope justifications (paste into Google's verification form)

**`.../auth/gmail.readonly`**
> Lola is a CRM for loan officers. When the user connects their mailbox, we read their messages to
> automatically log email correspondence onto the matching client/household record and to display
> their inbox inside the product (MyInbox). Read-only is sufficient; we do not modify the mailbox.
> Data is shown only to the account owner, matched only against their own contacts, and is never
> sold, shared, used for ads, or used to train ML models (Limited Use).

**`.../auth/gmail.send`**
> Loan officers send email to clients directly from the CRM (compose, reply, scheduled follow-ups).
> gmail.send lets the product send messages the user composes or approves, from their own account.
> No narrower scope allows sending. We do not read mail with this scope.

**`.../auth/calendar.events`**
> We display the user's upcoming events in the CRM dashboard and create events on their behalf when
> they book a meeting or enable auto-scheduling of follow-up steps. Read-only is insufficient because
> the product writes events the user initiates. Calendar data is shown only to the owner.

**`.../auth/contacts`**
> The product mirrors the clients and referral partners the user already manages in the CRM into the
> user's Google Contacts so they appear on their phone. This requires write access; Google offers no
> write-only contacts scope. Data flows out of the CRM into the user's address book at their request.

---

## 5. Code items to apply tomorrow (with a live re-test)

**A. "Sign in with Google" button.** Google requires the official branded button in the flow.
Replace the purple "Connect Gmail" button with Google's standard button (white background, Google
"G" logo, text "Sign in with Google"). I have the markup ready; it's a small change to
`nylas-email.js` (SWH) and `NylasPanels.tsx` (MyLola). Cosmetic, but we should eyeball it live.

**B. Nylas `prompt` parameter.** Nylas's verification guide says set `prompt` to `select_provider`
or `detect,select_provider` (and never use `login_hint` alone), or verification can be delayed/failed.
We currently send no `prompt` (we stripped the bad `consent` value). We don't use `login_hint`, so we
may already be fine, but to follow Nylas's guidance I'll add `prompt: 'detect'`. This touches the live
auth URL, so we apply it and immediately re-test connect together (this is the parameter that broke
the flow once already).

---

## 6. Demo video script (record ~2-3 min, upload unlisted to YouTube)

Google's reviewer must see the consent flow + each scope used. Screen-record this, narrate it:

1. **Intro (10s):** "This is MyLola, a CRM for loan officers, at mylola.ai. OAuth client ID
   630019277552-…googleusercontent.com."
2. **Sign in (20s):** Click **Sign in with Google** → show the consent screen listing the scopes →
   approve. (Shows the branded button + consent.)
3. **gmail.readonly (30s):** Open MyInbox / a client record → show emails auto-logged onto the
   client's timeline. "We read mail only to log it against the client and display it to the owner."
4. **gmail.send (20s):** Compose a reply from inside the CRM → send. "Sending from the user's account."
5. **calendar.events (20s):** Show the dashboard's upcoming events, then create/auto-add an event.
6. **contacts (20s):** Click "Push to Contacts" → show the contact appear in Google Contacts.
7. **Close (10s):** "All data is shown only to the account owner and used solely for these features,
   per Google's Limited Use policy. Privacy policy at mylola.ai/privacy."

---

## 7. CASA (after Google accepts the verification request)

- Provider: **TAC Security** — ~$540/yr basic, Google's preferred partner (cheapest credible option).
- They run a CASA **Tier 2** scan against OWASP ASVS. I help fix anything it flags in the code.
- They issue a **Letter of Validation**; you submit it to Google. Annual renewal.
- Whole thing: ~4-10 weeks, mostly waiting.

---

## What I'll have ready when you're back
- The "Sign in with Google" button markup + the `prompt` patch (apply + re-test together).
- The privacy-policy edits above (you review the legal wording, then we deploy).
- Scope justifications + video script: copy-paste ready here.

The only things that genuinely need *you*: Search Console domain verification, the consent-screen
branding/logo, publishing, recording the video, and engaging TAC Security.
