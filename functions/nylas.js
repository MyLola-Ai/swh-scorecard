// ============================================================
// NYLAS v3 UNIFIED INTEGRATION — calendar / email / contacts
// ============================================================
// Replaces the legacy gmail*/outlook* direct-OAuth functions (see
// index.js "EMAIL INTEGRATION — Gmail OAuth"). Those stay in place until
// this layer is live-tested with real Nylas credentials, then get retired
// per the cutover checklist (NYLAS_MIGRATION.md).
//
// One swh-scoreboard Cloud Functions backend serves BOTH SWH surfaces
// (Scorecard + CRM are hosting targets on the same Firebase project), so
// there is ONE getNylasAuthUrl / nylasCallback, parameterized by `product`:
//
//   product 'scorecard' → scopes [calendar.events]
//   product 'crm'       → scopes [email.metadata, calendar.events, contacts]
//
// Grant is stored per the spec at users/{uid}/integrations/nylas.
// Grant IDs are NEVER returned to the frontend — only server code reads them.
// A reverse-lookup doc nylasGrants/{grantId} → {uid, product} lets webhooks
// resolve which user a notification belongs to.
//
// Secrets (Firebase Secret Manager — set with `firebase functions:secrets:set`):
//   NYLAS_API_KEY  NYLAS_CLIENT_ID  NYLAS_CLIENT_SECRET  NYLAS_WEBHOOK_SECRET
//   OAUTH_STATE_SECRET (reused from the gmail integration — signs the `state`)
// ============================================================

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('crypto');
const admin = require('firebase-admin');

// Lazily resolve Firestore — admin.initializeApp() runs in index.js before
// this module is required, so we never touch firestore() at import time.
const db = () => admin.firestore();

// ── Secrets ──
const NYLAS_API_KEY = defineSecret('NYLAS_API_KEY');
const NYLAS_CLIENT_ID = defineSecret('NYLAS_CLIENT_ID');
const NYLAS_CLIENT_SECRET = defineSecret('NYLAS_CLIENT_SECRET');
const NYLAS_WEBHOOK_SECRET = defineSecret('NYLAS_WEBHOOK_SECRET');
const OAUTH_STATE_SECRET = defineSecret('OAUTH_STATE_SECRET');

// ── Constants ──
// US data region. EU apps use https://api.eu.nylas.com — change in one place.
const NYLAS_API_URI = 'https://api.us.nylas.com';
// Must be registered verbatim as a redirect URI in the Nylas dashboard.
const NYLAS_REDIRECT = 'https://us-central1-swh-scoreboard.cloudfunctions.net/nylasCallback';
const SWH_RETURN_BASE = 'https://swh-crm.web.app';

// Logical scopes stored in Firestore (match the spec's schema verbatim).
const PRODUCT_SCOPES = {
  scorecard: ['calendar.events'],
  // SWH CRM only reads email (auto-logging), so request gmail.readonly /
  // Mail.Read (least privilege for a cleaner Google verification).
  crm: ['email.read_only', 'email.send', 'calendar.events', 'contacts'],
};
// product request value → Firestore `product` field value
const PRODUCT_FIELD = {
  scorecard: 'swh-scorecard',
  crm: 'swh-crm',
};

// Logical scope → real provider OAuth scope. Nylas hosted auth forwards
// these to Google / Microsoft. Keep email.metadata read-only (headers only).
const GOOGLE_SCOPE_MAP = {
  'calendar.events': 'https://www.googleapis.com/auth/calendar.events',
  'email.metadata': 'https://www.googleapis.com/auth/gmail.metadata',
  'email.read_only': 'https://www.googleapis.com/auth/gmail.readonly',
  'email.send': 'https://www.googleapis.com/auth/gmail.send',
  'email.modify': 'https://www.googleapis.com/auth/gmail.modify',
  contacts: 'https://www.googleapis.com/auth/contacts',
};
const MICROSOFT_SCOPE_MAP = {
  'calendar.events': 'Calendars.ReadWrite',
  'email.metadata': 'Mail.ReadBasic',
  'email.read_only': 'Mail.Read',
  'email.send': 'Mail.Send',
  'email.modify': 'Mail.ReadWrite',
  contacts: 'Contacts.ReadWrite', // ReadWrite so the contacts push works on Outlook too
};

// ── Nylas SDK client (built per-request so secret values are available) ──
function nylasClient() {
  const NylasPkg = require('nylas');
  const Nylas = NylasPkg.default || NylasPkg;
  return new Nylas({ apiKey: NYLAS_API_KEY.value(), apiUri: NYLAS_API_URI });
}

function providerScopesFor(product, provider) {
  const map = provider === 'microsoft' ? MICROSOFT_SCOPE_MAP : GOOGLE_SCOPE_MAP;
  const logical = PRODUCT_SCOPES[product] || PRODUCT_SCOPES.scorecard;
  // Functional scopes only. The Nylas connector auto-includes the required
  // identity scopes (openid + userinfo.email/profile) and manages refresh, so
  // passing bare openid/email/profile here is rejected as "scope_not_allowed".
  return logical.map((s) => map[s]).filter(Boolean);
}

// Nylas grantStatus ('valid'|'invalid') → our Firestore status field.
function grantStatusToFirestore(grantStatus) {
  return grantStatus === 'valid' ? 'active' : 'expired';
}

// ── Auth: verify Firebase ID token from Authorization: Bearer <token> ──
async function requireAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    const e = new Error('Missing Authorization bearer token');
    e.code = 401;
    throw e;
  }
  return admin.auth().verifyIdToken(token);
}

function sendErr(res, e) {
  const code = e.code === 401 ? 401 : 400;
  res.status(code).json({ error: e.message || 'Request failed' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── HMAC-signed `state` carrying uid + product (CSRF + binding) ──
function signState(obj) {
  const payload = JSON.stringify({ ...obj, ts: Date.now(), nonce: crypto.randomBytes(8).toString('hex') });
  const sig = crypto.createHmac('sha256', OAUTH_STATE_SECRET.value()).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}
function verifyState(state) {
  if (!state || typeof state !== 'string') throw new Error('Missing state');
  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) throw new Error('Malformed state');
  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  const expected = crypto.createHmac('sha256', OAUTH_STATE_SECRET.value()).update(payload).digest('hex').slice(0, 32);
  if (sig !== expected) throw new Error('State signature mismatch');
  const parsed = JSON.parse(payload);
  if (Date.now() - parsed.ts > 30 * 60 * 1000) throw new Error('State expired');
  return parsed; // { uid, product, ts, nonce }
}

// ── Email normalization (mirrors the gmail integration for contact matching) ──
function normalizeEmail(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim().toLowerCase();
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = angle ? angle[1] : trimmed;
  const [local, domain] = addr.split('@');
  if (!local || !domain) return addr;
  return `${local.split('+')[0]}@${domain}`;
}

// Resolve which user owns a grant (for webhook handling).
async function resolveGrant(grantId) {
  if (!grantId) return null;
  const snap = await db().doc(`nylasGrants/${grantId}`).get();
  return snap.exists ? snap.data() : null;
}

// Verify a Nylas webhook signature: HMAC-SHA256(rawBody, webhookSecret) hex
// compared (constant-time) against the x-nylas-signature header.
function verifyWebhookSignature(rawBody, signature) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', NYLAS_WEBHOOK_SECRET.value())
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ============================================================
// 1 + 2 (per product) — OAuth: auth URL + callback
// ============================================================

// GET/POST. Body/query: { product: 'scorecard'|'crm', provider?: 'google'|'microsoft' }
// Returns { authUrl }. Frontend redirects the browser to authUrl.
exports.getNylasAuthUrl = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY, NYLAS_CLIENT_ID, OAUTH_STATE_SECRET] },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const src = req.method === 'GET' ? req.query : req.body || {};
      const product = src.product === 'crm' ? 'crm' : 'scorecard';
      const provider = src.provider === 'microsoft' ? 'microsoft' : 'google';

      const nylas = nylasClient();
      const authUrl = nylas.auth.urlForOAuth2({
        clientId: NYLAS_CLIENT_ID.value(),
        provider,
        redirectUri: NYLAS_REDIRECT,
        scope: providerScopesFor(product, provider),
        accessType: 'offline', // Google: needed so Nylas receives a refresh token
        state: signState({ uid: decoded.uid, product }),
      });
      res.json({ authUrl });
    } catch (e) {
      console.error('[getNylasAuthUrl]', e);
      sendErr(res, e);
    }
  }
);

// Nylas redirects the browser here with ?code=...&state=...
exports.nylasCallback = onRequest(
  { secrets: [NYLAS_API_KEY, NYLAS_CLIENT_ID, NYLAS_CLIENT_SECRET, OAUTH_STATE_SECRET] },
  async (req, res) => {
    try {
      const { code, state, error } = req.query;
      if (error) {
        return res.status(400).send(resultPage('Connection failed', String(error)));
      }
      if (!code) {
        return res.status(400).send(resultPage(
          "This page isn't a destination",
          'Connect your calendar from SWH Settings → Integrations. This URL only works when an account provider redirects back here after consent.'
        ));
      }
      const parsed = verifyState(String(state));
      const { uid, product } = parsed;

      const nylas = nylasClient();
      const exchange = await nylas.auth.exchangeCodeForToken({
        clientId: NYLAS_CLIENT_ID.value(),
        clientSecret: NYLAS_CLIENT_SECRET.value(),
        code: String(code),
        redirectUri: NYLAS_REDIRECT,
      });

      const grantId = exchange.grantId;
      const email = exchange.email || '';
      const provider = exchange.provider || 'google';

      // Store the grant per the spec schema. accessToken is NOT stored — Nylas
      // holds it and refreshes automatically; we only keep the grant id server-side.
      await db().doc(`users/${uid}/integrations/nylas`).set({
        grantId,
        product: PRODUCT_FIELD[product] || PRODUCT_FIELD.scorecard,
        email,
        provider,
        scopes: PRODUCT_SCOPES[product] || PRODUCT_SCOPES.scorecard,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active',
      }, { merge: true });

      // Reverse lookup for webhook → uid resolution.
      await db().doc(`nylasGrants/${grantId}`).set({
        uid, product, email, provider,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(200).send(resultPage(
        'Connected',
        `${escapeHtml(email)} is now linked. You can close this window and return to SWH.`,
        true
      ));
    } catch (e) {
      console.error('[nylasCallback]', e);
      res.status(400).send(resultPage('Connection failed', escapeHtml(e.message || 'Unexpected error')));
    }
  }
);

// ============================================================
// 3 — Calendar: next 7 days of events
// ============================================================
exports.getUpcomingEvents = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY] },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const integration = await loadActiveGrant(decoded.uid, res);
      if (!integration) return; // response already sent (reconnect prompt)

      const now = Math.floor(Date.now() / 1000);
      const sevenDays = now + 7 * 24 * 60 * 60;
      const nylas = nylasClient();
      const { data } = await nylas.events.list({
        identifier: integration.grantId,
        queryParams: { calendarId: 'primary', start: String(now), end: String(sevenDays), limit: 50 },
      });

      const events = (data || []).map((ev) => ({
        id: ev.id,
        title: ev.title || '(no title)',
        when: ev.when || null, // { startTime, endTime } (unix) or { date }
        location: ev.location || '',
        participants: (ev.participants || []).map((p) => ({ name: p.name || '', email: p.email })),
        status: ev.status || null,
      }));
      res.json({ events });
    } catch (e) {
      console.error('[getUpcomingEvents]', e);
      await maybeFlagExpired(req, e);
      sendErr(res, e);
    }
  }
);

// ============================================================
// 4 (CRM) — Email threads filtered by a contact's email address
// ============================================================
exports.getContactThreads = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY] },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const src = req.method === 'GET' ? req.query : req.body || {};
      const contactEmail = normalizeEmail(src.email || '');
      if (!contactEmail) throw new Error('Missing contact email');

      const integration = await loadActiveGrant(decoded.uid, res);
      if (!integration) return;

      const nylas = nylasClient();
      const { data } = await nylas.threads.list({
        identifier: integration.grantId,
        queryParams: { anyEmail: [contactEmail], limit: 20 },
      });

      const threads = (data || []).map((t) => ({
        id: t.id,
        subject: t.subject || '(no subject)',
        snippet: t.snippet || '',
        unread: !!t.unread,
        lastMessageAt: t.latestMessageReceivedDate || t.latestMessageSentDate || null,
        participants: (t.participants || []).map((p) => ({ name: p.name || '', email: p.email })),
        messageCount: (t.messageIds || []).length,
      }));
      res.json({ threads });
    } catch (e) {
      console.error('[getContactThreads]', e);
      await maybeFlagExpired(req, e);
      sendErr(res, e);
    }
  }
);

// ============================================================
// 5 (CRM) — Sync Nylas contacts into Firestore
// ============================================================
exports.getContacts = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY] },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const uid = decoded.uid;
      const integration = await loadActiveGrant(uid, res);
      if (!integration) return;

      const nylas = nylasClient();
      const { data } = await nylas.contacts.list({
        identifier: integration.grantId,
        queryParams: { limit: 100 },
      });

      let written = 0;
      const batch = db().batch();
      for (const c of data || []) {
        const primaryEmail = normalizeEmail((c.emails && c.emails[0] && c.emails[0].email) || '');
        if (!primaryEmail) continue;
        const ref = db().doc(`users/${uid}/nylasContacts/${c.id}`);
        batch.set(ref, {
          nylasContactId: c.id,
          name: [c.givenName, c.surname].filter(Boolean).join(' ') || c.displayName || '',
          email: primaryEmail,
          emails: (c.emails || []).map((e) => normalizeEmail(e.email)).filter(Boolean),
          company: c.companyName || '',
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        written++;
      }
      if (written) await batch.commit();
      res.json({ synced: written });
    } catch (e) {
      console.error('[getContacts]', e);
      await maybeFlagExpired(req, e);
      sendErr(res, e);
    }
  }
);

// ============================================================
// 6 (CRM) — Webhook handler: message.created, thread.replied
//           + 8-Step Follow Through mapping
// ============================================================
exports.nylasWebhook = onRequest(
  { secrets: [NYLAS_WEBHOOK_SECRET] },
  async (req, res) => {
    // Nylas verifies a new webhook URL with a GET ?challenge=... — echo it back.
    if (req.method === 'GET') {
      return res.status(200).send(String(req.query.challenge || ''));
    }
    // Signature verification on the raw body (required for all webhooks).
    const signature = req.headers['x-nylas-signature'];
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (!verifyWebhookSignature(rawBody, signature)) {
      console.warn('[nylasWebhook] bad signature');
      return res.status(401).send('invalid signature');
    }
    // Always ack fast (Nylas retries non-2xx); process inline but guard errors.
    try {
      const body = req.body || {};
      const type = body.type;
      const object = (body.data && body.data.object) || {};
      const grantId = object.grantId || object.grant_id || (body.data && body.data.grantId);
      const owner = await resolveGrant(grantId);
      if (owner) {
        if (type === 'message.created') {
          await handleInboundMessage(owner.uid, object);
        } else if (type === 'thread.replied') {
          await handleThreadReplied(owner.uid, object);
        }
      }
    } catch (e) {
      console.error('[nylasWebhook] processing error', e);
      // Still ack — a 500 makes Nylas retry the same event repeatedly.
    }
    res.status(200).send('ok');
  }
);

// New email from a known contact → update lastActivityAt + log the touch.
// New email from an unknown address → queue a "create contact?" prompt.
async function handleInboundMessage(uid, msg) {
  const fromEmail = normalizeEmail(
    (msg.from && msg.from[0] && msg.from[0].email) || ''
  );
  if (!fromEmail) return;

  const contactSnap = await db()
    .collection(`users/${uid}/contacts`)
    .where('email', '==', fromEmail)
    .limit(1)
    .get();

  const touch = {
    messageId: msg.id,
    threadId: msg.threadId || msg.thread_id || null,
    subject: msg.subject || '(no subject)',
    snippet: msg.snippet || '',
    fromEmail,
    receivedAt: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
    source: 'nylas',
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (!contactSnap.empty) {
    const contactId = contactSnap.docs[0].id;
    await db().doc(`users/${uid}/contacts/${contactId}/emails/${msg.id}`).set(touch, { merge: true });
    await db().doc(`users/${uid}/contacts/${contactId}`).set({
      lastActivityAt: touch.receivedAt,
      lastInboundAt: touch.receivedAt,
      followThroughNeeded: false,
      cadencePaused: true,
      cadencePausedAt: touch.receivedAt,
    }, { merge: true });
  } else {
    // Unknown sender → surface a prompt for the user to create a contact.
    await db().doc(`users/${uid}/inboundUnmatched/${msg.id}`).set({
      ...touch,
      resolved: false,
    }, { merge: true });
  }
}

async function handleThreadReplied(uid, thread) {
  // A reply landed → bump activity + clear follow-through for matching contacts.
  const participants = (thread.participants || [])
    .map((p) => normalizeEmail(p.email))
    .filter(Boolean);
  if (!participants.length) return;
  const nowIso = new Date().toISOString();
  for (const email of participants) {
    const snap = await db().collection(`users/${uid}/contacts`).where('email', '==', email).limit(1).get();
    if (snap.empty) continue;
    await snap.docs[0].ref.set({
      lastActivityAt: nowIso,
      lastReplyAt: nowIso,
      followThroughNeeded: false,
      cadencePaused: true,
      cadencePausedAt: nowIso,
    }, { merge: true });
  }
}

// ── 8-Step rule: no reply in 7 days → Task "Follow Through needed" ──
// This is time-based (not a webhook event), so it runs on a daily schedule.
exports.nylasFollowThroughSweep = onSchedule(
  { schedule: 'every day 13:00', timeZone: 'America/Chicago' },
  async () => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // Only sweep users who have an active Nylas grant.
    const grants = await db().collectionGroup('integrations')
      .where('product', 'in', ['swh-crm', 'mylola'])
      .where('status', '==', 'active')
      .get();
    for (const g of grants.docs) {
      const uid = g.ref.parent.parent.id;
      const contacts = await db().collection(`users/${uid}/contacts`).get();
      for (const c of contacts.docs) {
        const data = c.data();
        // Use lastMeaningfulInteractionAt if available, fall back to lastActivityAt
        const lastTouch = data.lastMeaningfulInteractionAt || data.lastActivityAt;
        if (!lastTouch) continue; // never touched — skip
        if (Date.parse(lastTouch) >= cutoff) continue; // touched recently
        if (data.followThroughNeeded) continue;    // task already open
        await db().doc(`users/${uid}/tasks/${c.id}`).set({
          type: 'follow_through',
          label: 'Follow Through needed',
          contactId: c.id,
          contactName: data.name || '',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'open',
        }, { merge: true });
        await c.ref.set({ followThroughNeeded: true }, { merge: true });
      }
    }
  }
);

// ============================================================
// Status / disconnect — reconnect-prompt support
// ============================================================
// Refreshes grant status from Nylas; if expired, flips Firestore status so the
// UI can surface a reconnect prompt. Returns connection summary (NO grant id).
exports.nylasStatus = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY] },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const snap = await db().doc(`users/${decoded.uid}/integrations/nylas`).get();
      if (!snap.exists) return res.json({ connected: false });
      const integration = snap.data();

      let status = integration.status;
      try {
        const nylas = nylasClient();
        const grant = await nylas.grants.find({ grantId: integration.grantId });
        const live = grantStatusToFirestore((grant.data || grant).grantStatus);
        if (live !== status) {
          status = live;
          await snap.ref.set({ status }, { merge: true });
        }
      } catch (probeErr) {
        console.warn('[nylasStatus] grant probe failed', probeErr.message);
      }

      res.json({
        connected: true,
        status,                       // 'active' | 'expired'
        email: integration.email,
        provider: integration.provider,
        product: integration.product,
        scopes: integration.scopes,
        needsReconnect: status === 'expired',
      });
    } catch (e) {
      console.error('[nylasStatus]', e);
      sendErr(res, e);
    }
  }
);

exports.nylasDisconnect = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY] },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const ref = db().doc(`users/${decoded.uid}/integrations/nylas`);
      const snap = await ref.get();
      if (snap.exists) {
        const integration = snap.data();
        try {
          const nylas = nylasClient();
          await nylas.grants.destroy({ grantId: integration.grantId });
        } catch (revokeErr) {
          console.warn('[nylasDisconnect] revoke failed', revokeErr.message);
        }
        await db().doc(`nylasGrants/${integration.grantId}`).delete().catch(() => {});
        await ref.delete();
      }
      res.json({ disconnected: true });
    } catch (e) {
      console.error('[nylasDisconnect]', e);
      sendErr(res, e);
    }
  }
);

// ============================================================
// Contacts PUSH — SWH contact → connected account (Google or Outlook)
// ============================================================
// Replaces the legacy gContactsToken (Google People API) + pushContactToOutlook
// paths. One function, both providers — Nylas routes by the grant's provider.
// Idempotent: stores the returned nylasContactId on the SWH contact so a second
// push updates the same provider contact instead of duplicating it.

function buildNylasContactBody(c) {
  const name = (c.name || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const body = {
    givenName: parts[0] || name || '(no name)',
    sourceApp: 'SWH',
  };
  if (parts.length > 1) body.surname = parts.slice(1).join(' ');
  const emails = [];
  const add = (raw) => { const a = normalizeEmail(raw); if (a) emails.push({ email: a, type: 'work' }); };
  if (c.email) add(c.email);
  if (Array.isArray(c.emails)) c.emails.forEach((e) => add(typeof e === 'string' ? e : (e.address || e.email)));
  const seen = new Set();
  const deduped = emails.filter((e) => (seen.has(e.email) ? false : seen.add(e.email)));
  if (deduped.length) body.emails = deduped;
  const phone = c.phone || c.phoneNumber;
  if (phone) body.phoneNumbers = [{ number: String(phone), type: 'mobile' }];
  if (c.company) body.companyName = c.company;
  return body;
}

// Cross-reference the account for an existing contact: first by email, then by
// mobile phone (last 10 digits). Catches people already saved under a different
// or blank email. Returns the existing contact id, or null.
async function findExistingContactId(nylas, grantId, requestBody) {
  for (const e of (requestBody.emails || [])) {
    try {
      const r = await nylas.contacts.list({ identifier: grantId, queryParams: { email: e.email, limit: 1 } });
      if (r.data && r.data.length) return r.data[0].id;
    } catch (_) { /* keep checking */ }
  }
  for (const p of (requestBody.phoneNumbers || [])) {
    const digits = String(p.number).replace(/\D/g, '').slice(-10);
    if (digits.length < 7) continue;
    try {
      const r = await nylas.contacts.list({ identifier: grantId, queryParams: { phoneNumber: digits, limit: 1 } });
      if (r.data && r.data.length) return r.data[0].id;
    } catch (_) { /* keep checking */ }
  }
  return null;
}

// Push one contact. Returns { action: 'created'|'updated'|'skipped', id }.
// - already pushed by us (has nylasContactId) → update, keep it in sync
// - matches an existing Contact by email or mobile → SKIP (bypass), leave the
//   user's existing contact untouched
// - otherwise → create
async function pushOneContact(nylas, grantId, ref, c) {
  const requestBody = buildNylasContactBody(c);
  if (c.nylasContactId) {
    const r = await nylas.contacts.update({ identifier: grantId, contactId: c.nylasContactId, requestBody });
    const pushed = r.data || r;
    await ref.set({ nylasContactId: pushed.id, pushedToProviderAt: new Date().toISOString() }, { merge: true });
    return { action: 'updated', id: pushed.id };
  }
  const existingId = await findExistingContactId(nylas, grantId, requestBody);
  if (existingId) {
    await ref.set({ existsInProvider: true, matchedProviderContactId: existingId, pushBypassedAt: new Date().toISOString() }, { merge: true });
    return { action: 'skipped', id: existingId };
  }
  const r = await nylas.contacts.create({ identifier: grantId, requestBody });
  const pushed = r.data || r;
  await ref.set({ nylasContactId: pushed.id, pushedToProviderAt: new Date().toISOString() }, { merge: true });
  return { action: 'created', id: pushed.id };
}

// Push a single contact by id.
exports.nylasPushContact = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY] },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const src = req.method === 'GET' ? req.query : req.body || {};
      const contactId = src.contactId;
      if (!contactId) throw new Error('Missing contactId');
      const integration = await loadActiveGrant(decoded.uid, res);
      if (!integration) return;
      const snap = await db().doc(`users/${decoded.uid}/contacts/${contactId}`).get();
      if (!snap.exists) throw new Error('Contact not found');
      const c = snap.data();
      if (!c.email && !(Array.isArray(c.emails) && c.emails.length)) {
        throw new Error('Contact has no email to push');
      }
      const r = await pushOneContact(nylasClient(), integration.grantId, snap.ref, c);
      res.json({ ok: true, action: r.action, nylasContactId: r.id });
    } catch (e) {
      console.error('[nylasPushContact]', e);
      await maybeFlagExpired(req, e);
      sendErr(res, e);
    }
  }
);

// Bulk push every contact in the user's network.
exports.nylasSyncContacts = onRequest(
  { cors: true, timeoutSeconds: 300, memory: '512MiB', secrets: [NYLAS_API_KEY] },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const integration = await loadActiveGrant(decoded.uid, res);
      if (!integration) return;
      const nylas = nylasClient();
      const contacts = await db().collection(`users/${decoded.uid}/contacts`).get();
      let pushed = 0, bypassed = 0, skipped = 0, failed = 0;
      for (const doc of contacts.docs) {
        const c = doc.data();
        if (!c.email && !(Array.isArray(c.emails) && c.emails.length) && !(c.phone || c.phoneNumber)) { skipped++; continue; }
        try {
          const r = await pushOneContact(nylas, integration.grantId, doc.ref, c);
          if (r.action === 'skipped') bypassed++; else pushed++;
        } catch (e) { console.warn('[nylasSyncContacts] failed', doc.id, e.message); failed++; }
      }
      res.json({ ok: true, pushed, bypassed, skipped, failed, total: contacts.size });
    } catch (e) {
      console.error('[nylasSyncContacts]', e);
      await maybeFlagExpired(req, e);
      sendErr(res, e);
    }
  }
);

// ============================================================
// 9 — Calendar: create / delete events on the user's primary calendar
// ============================================================
// Used by the CRM's 8-step follow-through system to schedule step reminders
// when starting a campaign, and to remove them when stopping sync.
// Only the user's own calendar is written — no invites are sent.
exports.createNylasEvent = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY], invoker: 'public' },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const src = req.body || {};
      const { title, startTime, endTime, description, participants, location } = src;
      if (!title || !startTime || !endTime) throw new Error('Missing title, startTime, or endTime');

      const integration = await loadActiveGrant(decoded.uid, res);
      if (!integration) return;

      // Attendees — the calendar provider emails them a real invite
      const attendees = Array.isArray(participants)
        ? participants
            .filter(p => p && typeof p.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim()))
            .slice(0, 10)
            .map(p => ({ email: p.email.trim(), name: String(p.name || '').slice(0, 80) }))
        : [];

      const requestBody = {
        title: String(title),
        when: { startTime: Math.floor(Number(startTime)), endTime: Math.floor(Number(endTime)) },
      };
      if (description) requestBody.description = String(description).slice(0, 2000);
      if (location) requestBody.location = String(location).slice(0, 200);
      if (attendees.length) requestBody.participants = attendees;

      const nylas = nylasClient();
      const r = await nylas.events.create({
        identifier: integration.grantId,
        queryParams: { calendarId: 'primary', notifyParticipants: attendees.length > 0 },
        requestBody,
      });
      res.json({ ok: true, eventId: (r.data || r).id, invited: attendees.length });
    } catch (e) {
      console.error('[createNylasEvent]', e);
      await maybeFlagExpired(req, e);
      sendErr(res, e);
    }
  }
);

exports.deleteNylasEvent = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY], invoker: 'public' },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const { eventId, notify } = req.body || {};
      if (!eventId) throw new Error('Missing eventId');

      const integration = await loadActiveGrant(decoded.uid, res);
      if (!integration) return;

      const nylas = nylasClient();
      await nylas.events.destroy({
        identifier: integration.grantId,
        eventId: String(eventId),
        // notify=true sends attendees the provider's standard cancellation
        queryParams: { calendarId: 'primary', notifyParticipants: !!notify },
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('[deleteNylasEvent]', e);
      await maybeFlagExpired(req, e);
      sendErr(res, e);
    }
  }
);

// ============================================================
// Shared helpers
// ============================================================

// Load the user's active grant. If missing/expired, respond with a
// reconnect-prompt payload and return null (caller should stop).
async function loadActiveGrant(uid, res) {
  const snap = await db().doc(`users/${uid}/integrations/nylas`).get();
  if (!snap.exists) {
    res.status(409).json({ error: 'not_connected', needsReconnect: true });
    return null;
  }
  const integration = snap.data();
  if (integration.status === 'expired') {
    res.status(409).json({ error: 'grant_expired', needsReconnect: true });
    return null;
  }
  return integration;
}

// If a Nylas call fails with auth/grant errors, flip Firestore status to
// 'expired' so the next status check surfaces a reconnect prompt.
async function maybeFlagExpired(req, e) {
  const status = e.statusCode || e.status || 0;
  if (status !== 401 && status !== 403) return;
  // A 403 from a missing scope is NOT token expiry. Don't flag the grant.
  // Nylas nests the provider's message (e.g. Google's "insufficient
  // authentication scopes") in providerError while e.message is just
  // "Forbidden" — check both, or scope errors wrongly kill the grant.
  const errMsg = (String(e.message || e.body || '') + ' '
    + String(e.providerError?.error?.message || '')).toLowerCase();
  if (errMsg.includes('scope') || errMsg.includes('permission') || errMsg.includes('insufficient')) return;
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return;
    const decoded = await admin.auth().verifyIdToken(token);
    await db().doc(`users/${decoded.uid}/integrations/nylas`).set({ status: 'expired' }, { merge: true });
  } catch (_) { /* best effort */ }
}

// Minimal branded result page for the OAuth callback.
function resultPage(title, body, success) {
  const accent = success ? '#34D399' : '#A78BFA';
  return `<!doctype html><meta charset="utf-8"><title>SWH · ${escapeHtml(title)}</title>
<body style="font-family:'DM Sans',-apple-system,sans-serif;background:#0f1117;color:#fff;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:24px;">
  <div style="max-width:480px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:18px;padding:32px;line-height:1.6;text-align:center;">
    <div style="width:48px;height:48px;border-radius:50%;background:${accent};margin:0 auto 18px;"></div>
    <h1 style="font-size:22px;font-weight:800;margin:0 0 12px;">${escapeHtml(title)}</h1>
    <p style="color:rgba(255,255,255,0.75);font-size:14px;margin:0 0 22px;">${body}</p>
    <a href="${SWH_RETURN_BASE}" style="display:inline-block;background:${accent};color:#0f1117;padding:11px 22px;border-radius:12px;text-decoration:none;font-weight:700;font-size:14px;">Return to SWH</a>
  </div>
</body>`;
}

// ============================================================
// Direct send from the Lola Draft modal — any contact, no queue.
// Sends via the user's connected grant and records the email on the
// contact (Emails tab). No step/points side effects; the user marks
// steps intentionally.
// ============================================================
// Nylas treats `body` as HTML while our drafts are plain text — sending raw
// text collapses every paragraph break into one blob on the recipient's end.
function textBodyToHtml(body) {
  return escapeHtml(String(body))
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>');
}

exports.sendContactEmail = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY], invoker: 'public' },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const uid = decoded.uid;

      const { contactId, subject, body } = req.body || {};
      if (!contactId || !body) return res.status(400).json({ error: 'Missing required fields.' });

      const contactDoc = await db().doc(`users/${uid}/contacts/${contactId}`).get();
      if (!contactDoc.exists) return res.status(404).json({ error: 'Contact not found.' });
      const contact = contactDoc.data();
      if (!contact.email) return res.status(400).json({ error: 'Contact has no email address.' });

      const integration = await loadActiveGrant(uid, res);
      if (!integration) return;

      const html = textBodyToHtml(body);

      const nylas = nylasClient();
      const sendResp = await nylas.messages.send({
        identifier: integration.grantId,
        requestBody: {
          to: [{ email: contact.email, name: contact.name || contact.email }],
          subject: subject || 'Hello',
          body: html,
        },
      });

      const msgData = sendResp.data || sendResp;
      const nylasMsgId = msgData.id || `ld_${Date.now()}`;
      await db().doc(`users/${uid}/contacts/${contactId}/emails/${nylasMsgId}`).set({
        direction: 'sent',
        subject: subject || '',
        snippet: String(body).slice(0, 200),
        sentAt: new Date().toISOString(),
        source: 'lola-draft',
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.json({ ok: true, id: nylasMsgId });
    } catch (e) {
      await maybeFlagExpired(req, e);
      console.error('[sendContactEmail]', e.message);
      return sendErr(res, e);
    }
  }
);

// ============================================================
// Follow-Through Queue: one-tap send from the morning queue
// ============================================================
const ADMIN_EMAILS_FTQ = ['austen@austensmith.com'];

exports.sendFollowThroughEmail = onRequest(
  { cors: true, secrets: [NYLAS_API_KEY], invoker: 'public' },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const uid = decoded.uid;

      // V1 gate
      const userSnap = await db().doc(`users/${uid}`).get();
      const userEmail = userSnap.exists ? (userSnap.data().email || '') : '';
      if (!ADMIN_EMAILS_FTQ.includes(userEmail)) {
        return res.status(403).json({ error: 'Not available yet.' });
      }

      const { docId, contactId, stepIndex, subject, body } = req.body || {};
      if (!docId || !contactId || stepIndex === undefined || !body) {
        return res.status(400).json({ error: 'Missing required fields.' });
      }

      const [queueDoc, contactDoc] = await Promise.all([
        db().doc(`users/${uid}/followThroughQueue/${docId}`).get(),
        db().doc(`users/${uid}/contacts/${contactId}`).get(),
      ]);
      if (!queueDoc.exists) return res.status(404).json({ error: 'Queue item not found.' });
      if (!contactDoc.exists) return res.status(404).json({ error: 'Contact not found.' });

      const contact = contactDoc.data();
      if (!contact.email) return res.status(400).json({ error: 'Contact has no email address.' });

      const integration = await loadActiveGrant(uid, res);
      if (!integration) return;

      const nylas = nylasClient();
      const sendResp = await nylas.messages.send({
        identifier: integration.grantId,
        requestBody: {
          to: [{ email: contact.email, name: contact.name }],
          subject: subject || queueDoc.data().draftSubject || 'Checking in',
          body: textBodyToHtml(body),
        },
      });

      const msgData = sendResp.data || sendResp;
      const nylasMsgId = msgData.id || `ftq_${Date.now()}`;
      const nowIso = new Date().toISOString();
      const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

      const q = queueDoc.data();
      const batch = db().batch();

      // (a) Email record with direction:'sent' so the Emails tab renders correctly
      batch.set(db().doc(`users/${uid}/contacts/${contactId}/emails/${nylasMsgId}`), {
        direction: 'sent',
        subject: subject || q.draftSubject || '',
        snippet: body.slice(0, 200),
        sentAt: nowIso,
        source: 'follow-through-queue',
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // (b) Activity log
      const actId = `ftq_${contactId}_${stepIndex}_${todayKey}`;
      batch.set(db().doc(`users/${uid}/contacts/${contactId}/activities/${actId}`), {
        type: q.stepName || `Step ${stepIndex + 1}`,
        source: 'follow-through-queue',
        points: q.stepPoints || 1,
        timestamp: nowIso,
        dateKey: todayKey,
        contactId,
        contactName: contact.name,
      });

      // (c) Advance steps counter (integer, capped at 8)
      const newSteps = Math.min(8, (contact.steps || 0) + 1);
      batch.set(db().doc(`users/${uid}/contacts/${contactId}`), {
        steps: newSteps,
        lastActivityAt: nowIso,
        lastOutboundAt: nowIso,
      }, { merge: true });

      // (d) Mark queue doc sent
      batch.set(db().doc(`users/${uid}/followThroughQueue/${docId}`), {
        status: 'sent',
        sentAt: nowIso,
      }, { merge: true });

      await batch.commit();

      res.json({ ok: true, newSteps, nylasMsgId });
    } catch (e) {
      console.error('[sendFollowThroughEmail]', e);
      await maybeFlagExpired(req, e);
      sendErr(res, e);
    }
  }
);
