// ============================================================
// Lola Connect proxy (P4 — SWH → Lola Connect service-to-service).
//
// SWH lives in its own Firebase project + auth pool. SWH FRONTENDS keep
// calling swh-scoreboard functions; this ONE function authenticates the SWH
// user (Firebase ID token, same requireAuth pattern as nylas.js) and proxies
// to the Lola Connect cross-project GATEWAY on loaniq-75a20, injecting the
// user's subject and product SERVER-SIDE so a client can never spoof either.
//
// The Lola Connect layer (connections/email/calendar/free-busy) is owned by
// the loaniq-75a20 monorepo; SWH consumes its API only.
//
// nylas.js's remaining endpoints (calendar events, direct/queue email send)
// call into this module directly -- Nylas itself fully removed 2026-08-08.
// The legacy Gmail/Outlook OAuth sync is a separate, still-independent path.
//
// Secret (Firebase Secret Manager, set with `firebase functions:secrets:set`):
//   LOLA_CONNECT_SERVICE_TOKEN  — the SAME value as on loaniq-75a20. Never
//   exposed to a frontend; only ever sent server→server to the gateway.
// ============================================================

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

const db = () => admin.firestore();

const LOLA_CONNECT_SERVICE_TOKEN = defineSecret('LOLA_CONNECT_SERVICE_TOKEN');

// ── Constants ──
const GATEWAY_URL = 'https://us-central1-loaniq-75a20.cloudfunctions.net/lolaConnectGateway';
// This SWH user population's namespace in Lola Connect. MUST stay stable and
// identical on connect AND on every later call, or connection authz 404s.
const SWH_POOL = 'swh-scoreboard';
// SWH is one product in Lola Connect. Injected server-side on every call so a
// client can't read another product's connections.
const SWH_PRODUCT = 'swh';

// Origins a hosted-auth redirect may return to (mirror of the Lola Connect
// APPROVED_REDIRECT_HOSTS entries for SWH). The Lola Connect side validates
// again and falls back if we send something off-list.
const APPROVED_ORIGINS = new Set([
  'https://crm.stopwastinghandshakes.com',
  'https://app.stopwastinghandshakes.com',
  'https://stopwastinghandshakes.com',
  'https://swh-crm.web.app',
  'https://swh-scoreboard.web.app',
]);
const DEFAULT_ORIGIN = 'https://crm.stopwastinghandshakes.com';

// Ops a SWH client may invoke. connections.* + the channels SWH uses. The
// gateway enforces per-product permission on top of this.
const ALLOWED_OPS = new Set([
  'connections.start',
  'connections.list',
  'connections.disconnect',
  'connections.enableProduct',
  'emails.list',
  'emails.send',
  'calendars.list',
  'calendars.freeBusy',
  'events.list',
  'events.create',
  'events.update',
  'events.delete',
]);

// Feature flag: SWH-wide kill switch + optional per-user beta gate. Ships OFF.
// Enable globally:  system/lolaConnect  { enabled: true }
// Beta allowlist:   system/lolaConnect  { betaUids: ['<uid>', ...] }
// (enabled:true opens it to everyone; betaUids opens it to just those uids.)
async function featureAllowed(uid) {
  try {
    const snap = await db().doc('system/lolaConnect').get();
    if (!snap.exists) return false;
    const cfg = snap.data() || {};
    if (cfg.enabled === true) return true;
    return Array.isArray(cfg.betaUids) && cfg.betaUids.includes(uid);
  } catch (e) {
    console.warn('[lolaConnect] flag read failed; staying disabled:', e.message);
    return false;
  }
}

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

// Which SWH origin a hosted-auth redirect returns to. Prefer a client-supplied
// returnOrigin (the card sends location.origin) because the Origin HEADER is
// unreliable inside the iOS WKWebView — without this, a Scorecard connect
// landed back on the CRM. Validated against the allowlist; header then default
// as fallbacks. This is a return target only (redirect), never trusted for authz.
function approvedOrigin(req, body) {
  const claimed = body && typeof body.returnOrigin === 'string' ? body.returnOrigin : undefined;
  if (claimed && APPROVED_ORIGINS.has(claimed)) return claimed;
  const origin = req.headers.origin;
  return origin && APPROVED_ORIGINS.has(origin) ? origin : DEFAULT_ORIGIN;
}

/** Build the gateway body for one op. Subject + product are injected here and
 * NEVER taken from the client. Only whitelisted, typed fields pass through. */
function buildGatewayBody(op, uid, req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const subject = { pool: SWH_POOL, uid };
  const base = { op, subject, product: SWH_PRODUCT };
  const s = (v) => (typeof v === 'string' && v ? v : undefined);
  const n = (v) => (typeof v === 'number' ? v : undefined);
  const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined);

  switch (op) {
    case 'connections.start': {
      const origin = approvedOrigin(req, b);
      return {
        ...base,
        providers: strArr(b.providers), // ['google'] | ['microsoft']
        reconnectConnectionId: s(b.reconnectConnectionId),
        // The CRM is a single-page app served only at "/", so the return URL
        // must hit the root (a "/settings" path 404s on Firebase Hosting). The
        // app reads ?lolaConnect on boot to open Settings + refresh the card.
        successUrl: `${origin}/?lolaConnect=connected`,
        failureUrl: `${origin}/?lolaConnect=failed`,
      };
    }
    case 'connections.list':
      return base;
    case 'connections.disconnect':
    case 'connections.enableProduct':
      return { ...base, connectionId: s(b.connectionId) };
    case 'emails.list':
      return {
        ...base,
        connectionId: s(b.connectionId),
        folder: s(b.folder),
        limit: n(b.limit),
        cursor: s(b.cursor),
        metaOnly: b.metaOnly !== false,
      };
    case 'emails.send':
      return { ...base, connectionId: s(b.connectionId), draft: b.draft };
    case 'calendars.list':
      return { ...base, connectionId: s(b.connectionId) };
    case 'calendars.freeBusy':
      return {
        ...base,
        connectionId: s(b.connectionId),
        from: s(b.from),
        to: s(b.to),
        calendarIds: strArr(b.calendarIds),
      };
    case 'events.list':
      return { ...base, connectionId: s(b.connectionId), calendarId: s(b.calendarId), limit: n(b.limit), cursor: s(b.cursor) };
    case 'events.create':
      return { ...base, connectionId: s(b.connectionId), calendarId: s(b.calendarId), event: b.event };
    case 'events.update':
      return { ...base, connectionId: s(b.connectionId), calendarId: s(b.calendarId), eventId: s(b.eventId), patch: b.patch };
    case 'events.delete':
      return { ...base, connectionId: s(b.connectionId), calendarId: s(b.calendarId), eventId: s(b.eventId) };
    default:
      return base;
  }
}

// ── Server-side LC consumption (feature wiring, leg 1: email send) ──────────
// Lets OTHER swh functions send through the caller's Lola Connect connection.
// Returns { providerEmailId } on success, or null when this user has no
// connected LC account (caller returns a 409 lola_connect_required — no
// Nylas fallback, Nylas is fully removed). Throws only on a genuine send
// failure so the caller can surface it.
async function lcTrySendEmail(uid, { to, name, subject, html }) {
  if (!(await featureAllowed(uid))) return null;
  const call = async (body) => {
    const r = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${LOLA_CONNECT_SERVICE_TOKEN.value()}`,
      },
      body: JSON.stringify({ subject: { pool: SWH_POOL, uid }, product: SWH_PRODUCT, ...body }),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const list = await call({ op: 'connections.list' });
  const conns = (list.json.result && list.json.result.connections) || [];
  const active = conns.find((c) => c.status === 'connected');
  if (!active) return null;

  const send = await call({
    op: 'emails.send',
    connectionId: active.id,
    draft: { to: [{ email: to, ...(name ? { name } : {}) }], subject, body: html },
  });
  if (!send.json.ok) {
    throw new Error(`Lola Connect send failed (${send.status}): ${send.json.error || 'unknown'}`);
  }
  return { providerEmailId: send.json.result && send.json.result.providerEmailId };
}

// ── Leg 3: calendar event via the caller's LC connection ────────────────────
// Mirrors lcTrySendEmail: null when the user has no connected LC account
// (caller returns a 409 lola_connect_required), throws on a genuine create failure.
// Times are ISO strings; notify defaults true so attendees get real invites
// (the layer passes it to the vendor; NOTE Outlook always notifies regardless).
async function lcTryCreateEvent(uid, { title, startISO, endISO, description, location, attendees, notify }) {
  if (!(await featureAllowed(uid))) return null;
  const call = async (body) => {
    const r = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${LOLA_CONNECT_SERVICE_TOKEN.value()}`,
      },
      body: JSON.stringify({ subject: { pool: SWH_POOL, uid }, product: SWH_PRODUCT, ...body }),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const list = await call({ op: 'connections.list' });
  const conns = (list.json.result && list.json.result.connections) || [];
  const active = conns.find((c) => c.status === 'connected');
  if (!active) return null;

  const cals = await call({ op: 'calendars.list', connectionId: active.id });
  const arr = (cals.json.result && cals.json.result.calendars) || [];
  const cal = arr.find((c) => c.isDefault) || arr[0];
  if (!cal) throw new Error('Lola Connect: no calendar available on the connected account');

  const created = await call({
    op: 'events.create',
    connectionId: active.id,
    calendarId: cal.id,
    event: {
      title,
      start: startISO,
      end: endISO,
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      attendees: Array.isArray(attendees) ? attendees : [],
      notify: notify !== false,
    },
  });
  if (!created.json.ok && !(created.json.result && created.json.result.event)) {
    throw new Error(`Lola Connect event create failed (${created.status}): ${created.json.error || 'unknown'}`);
  }
  const ev = (created.json.result && created.json.result.event) || {};
  return { eventId: ev.id || '', calendarId: cal.id };
}

// Mirrors lcTryCreateEvent: null when the user has no connected LC account,
// throws on a genuine delete failure. NOTE the gateway's events.delete dispatch
// (see buildGatewayBody above) does not thread a notify/notifyParticipants
// field through -- unlike events.create, a cancellation notice to attendees
// isn't currently wired end-to-end. Accepted here for call-signature parity
// with the old Nylas path, but it's a no-op until the gateway supports it.
async function lcTryDeleteEvent(uid, { eventId, notify }) {
  if (!(await featureAllowed(uid))) return null;
  const call = async (body) => {
    const r = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${LOLA_CONNECT_SERVICE_TOKEN.value()}`,
      },
      body: JSON.stringify({ subject: { pool: SWH_POOL, uid }, product: SWH_PRODUCT, ...body }),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const list = await call({ op: 'connections.list' });
  const conns = (list.json.result && list.json.result.connections) || [];
  const active = conns.find((c) => c.status === 'connected');
  if (!active) return null;

  const cals = await call({ op: 'calendars.list', connectionId: active.id });
  const arr = (cals.json.result && cals.json.result.calendars) || [];
  const cal = arr.find((c) => c.isDefault) || arr[0];
  if (!cal) throw new Error('Lola Connect: no calendar available on the connected account');

  const deleted = await call({ op: 'events.delete', connectionId: active.id, calendarId: cal.id, eventId: String(eventId) });
  if (!deleted.json.ok) {
    throw new Error(`Lola Connect event delete failed (${deleted.status}): ${deleted.json.error || 'unknown'}`);
  }
  return { ok: true };
}

exports.lcTrySendEmail = lcTrySendEmail;
exports.lcTryCreateEvent = lcTryCreateEvent;
exports.lcTryDeleteEvent = lcTryDeleteEvent;
exports.LOLA_CONNECT_SERVICE_TOKEN = LOLA_CONNECT_SERVICE_TOKEN;

// Returns the Set of uids with a connected LC account for product swh.
// Same connections.listByPool call already used by lolaConnectFollowThroughSweep
// below, pulled out so index.js's gmail-sync migration guard can reuse it
// instead of a third inline copy.
async function lcConnectedUidSet() {
  const call = async (body) => {
    const r = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${LOLA_CONNECT_SERVICE_TOKEN.value()}`,
      },
      body: JSON.stringify({ subject: { pool: SWH_POOL, uid: 'service' }, product: SWH_PRODUCT, ...body }),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const listing = await call({ op: 'connections.listByPool' });
  const conns = (listing.json.result && listing.json.result.connections) || [];
  const uids = new Set();
  conns
    .filter((c) => c.status === 'connected' && c.products && c.products.swh)
    .forEach((c) => (c.uids || []).forEach((uid) => uids.add(uid)));
  return uids;
}
exports.lcConnectedUidSet = lcConnectedUidSet;

// ── Leg 2: email auto-log via LC pull-sync ──────────────────────────────────
// Every 15 minutes, for each SWH user with a connected LC account, pull new
// mail and log it onto matched contacts' timelines — the LC replacement for
// the old Nylas webhook auto-log (removed 2026-08-05). Same doc shape as the
// legacy writers, with source:'lola-connect' and lc_-prefixed ids.
//
// Double-log guard: while the Nylas webhook was still live, it logged the
// same mail under a DIFFERENT doc id for users with a working grant. Before
// writing, skip any message whose (sentAt, direction) already exists on that
// contact — cheap contact-scoped equality query, no cross-stack id mapping
// needed. Kept post-removal so old webhook-logged history never double-counts
// if a re-sync ever revisits the same window.

const normEmail = (e) => String(e || '').trim().toLowerCase();

async function lcBuildContactIndex(uid) {
  const snap = await db().collection(`users/${uid}/contacts`).select('email').get();
  const index = {};
  snap.forEach((doc) => {
    const em = normEmail((doc.data() || {}).email);
    if (!em) return;
    (index[em] = index[em] || []).push(doc.id);
  });
  return index;
}

async function lcSyncUserEmails(uid, connection, gwCall) {
  const stateRef = db().doc(`users/${uid}/integrations/lolaConnectSync`);
  const state = (await stateRef.get()).data() || {};
  // First run: look back 1h only (no historical backfill from a cron tick).
  // 5-min overlap on later runs; the dedup check absorbs the replays.
  const after = state.cursorAfter || new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const runStarted = new Date().toISOString();

  const page = await gwCall({
    op: 'emails.list',
    connectionId: connection.id,
    after,
    limit: 50,
    metaOnly: true,
  });
  const items = ((page.json.result && page.json.result.items) || []).filter((m) => m && m.id);
  if (!items.length) {
    await stateRef.set({ cursorAfter: runStarted, lastRunAt: runStarted, lastCount: 0 }, { merge: true });
    return { logged: 0, seen: 0 };
  }

  const index = await lcBuildContactIndex(uid);
  const selfEmail = normEmail(connection.email);
  let logged = 0;

  for (const m of items) {
    const fromEmail = normEmail(m.from && m.from.email);
    const toEmails = (m.to || []).map((p) => normEmail(p.email)).filter(Boolean);
    const ccEmails = (m.cc || []).map((p) => normEmail(p.email)).filter(Boolean);
    const direction = fromEmail && fromEmail === selfEmail ? 'sent' : 'received';
    // Received: match sender + any other to/cc party (mirrors nylas.js's
    // handleThreadReplied participant loop — a contact CC'd on their own
    // reply still counts). Sent: match recipients, as before.
    const targets = direction === 'sent'
      ? [...toEmails, ...ccEmails]
      : [fromEmail, ...toEmails, ...ccEmails].filter((em) => em && em !== selfEmail);
    const matched = new Set();
    targets.forEach((em) => (index[em] || []).forEach((cid) => matched.add(cid)));
    if (!matched.size) continue;

    const sentAt = m.date || runStarted;
    const emailDoc = {
      direction,
      sentAt,
      subject: m.subject || '(no subject)',
      snippet: m.snippet || '',
      fromEmail,
      toEmails,
      ccEmails,
      threadId: m.threadId || '',
      source: 'lola-connect',
      syncedAt: new Date().toISOString(),
    };
    // Reply detection (2026-07-29): nylas.js's handleThreadReplied clears
    // follow-through on an inbound reply — this cron was logging mail but
    // never clearing it, which would have silently broken wasted-handshake
    // detection the moment Nylas is cut. Direction-gated so an LO's own
    // OUTBOUND mail never clears follow-through (that would invert the
    // feature — a "reply" must come FROM the contact, not to them).
    const contactUpdate = direction === 'received'
      ? { lastActivityAt: sentAt, lastReplyAt: sentAt, followThroughNeeded: false, cadencePaused: true, cadencePausedAt: sentAt }
      : { lastActivityAt: sentAt };
    for (const contactId of matched) {
      const emailsCol = db().collection(`users/${uid}/contacts/${contactId}/emails`);
      // Double-log guard vs the Nylas webhook's differently-keyed doc — this
      // dedupes the LOG WRITE ONLY. Bug found 2026-08 (real contacts hit:
      // Mario Lazo received two more "good meeting you" templates after he'd
      // already replied, prompting him to warn Austen it read as obviously
      // automated): a bare `continue` here used to skip contactUpdate too —
      // any message the legacy Nylas webhook logged first (routine during
      // the Nylas dual-run) silently skipped cadencePaused/followThroughNeeded
      // on this path. The reply is real regardless of which system logged the
      // message first, so the contact-side-effect must apply unconditionally.
      const dup = await emailsCol.where('sentAt', '==', sentAt).where('direction', '==', direction).limit(1).get();
      const batch = db().batch();
      if (dup.empty) {
        batch.set(emailsCol.doc(`lc_${m.id}`), emailDoc, { merge: true });
      }
      batch.update(db().doc(`users/${uid}/contacts/${contactId}`), contactUpdate);
      await batch.commit();
      if (dup.empty) logged++;
    }
  }

  await stateRef.set(
    {
      cursorAfter: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      lastRunAt: runStarted,
      lastCount: logged,
    },
    { merge: true },
  );
  return { logged, seen: items.length };
}

exports.lolaConnectEmailSyncCron = onSchedule(
  { schedule: 'every 15 minutes', secrets: [LOLA_CONNECT_SERVICE_TOKEN], timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const gwCallFor = (uid) => async (body) => {
      const r = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${LOLA_CONNECT_SERVICE_TOKEN.value()}`,
        },
        body: JSON.stringify({ subject: { pool: SWH_POOL, uid }, product: SWH_PRODUCT, ...body }),
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };

    // Enumerate this pool's connections (service-scoped; uid here is nominal).
    const listing = await gwCallFor('service')({ op: 'connections.listByPool' });
    const conns = (listing.json.result && listing.json.result.connections) || [];
    const connected = conns.filter((c) => c.status === 'connected' && c.products && c.products.swh);

    let totalLogged = 0;
    for (const conn of connected) {
      for (const uid of conn.uids || []) {
        try {
          const r = await lcSyncUserEmails(uid, conn, gwCallFor(uid));
          totalLogged += r.logged;
        } catch (e) {
          console.warn(`[lcEmailSync] uid=${uid} failed:`, e.message);
        }
      }
    }
    console.log(`[lcEmailSync] connections=${connected.length} logged=${totalLogged}`);
  },
);

// ── Follow-through OPENER sweep (2026-07-29) ────────────────────────────────
// nylas.js's nylasFollowThroughSweep opens a "Follow Through needed" task
// after 7 days of silence — but its eligibility gate reads ONLY
// users/{uid}/integrations/nylas docs (collectionGroup('integrations'),
// product in ['swh-crm','mylola'], status:'active'). That doc is Nylas-only;
// nothing LC-based ever satisfies it. So cutting Nylas wouldn't just break
// reply-clearing (the gap that stopped the cut) — it would silently sweep
// ZERO users and disable the OPENING half of follow-through detection for
// EVERYONE, LC-connected users included, since lastActivityAt keeps updating
// (via lcEmailSync above) but nothing ever checks it again. Same exact logic
// as the Nylas version; eligibility gate swapped to "has a connected LC
// account for product swh" instead of "has an active Nylas grant" — the
// intent (only sweep users with SOME working mail sync) is unchanged.
exports.lolaConnectFollowThroughSweep = onSchedule(
  { schedule: 'every day 13:00', timeZone: 'America/Chicago', secrets: [LOLA_CONNECT_SERVICE_TOKEN] },
  async () => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const call = async (body) => {
      const r = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${LOLA_CONNECT_SERVICE_TOKEN.value()}`,
        },
        body: JSON.stringify({ subject: { pool: SWH_POOL, uid: 'service' }, product: SWH_PRODUCT, ...body }),
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    const listing = await call({ op: 'connections.listByPool' });
    const conns = (listing.json.result && listing.json.result.connections) || [];
    const uids = new Set();
    conns
      .filter((c) => c.status === 'connected' && c.products && c.products.swh)
      .forEach((c) => (c.uids || []).forEach((uid) => uids.add(uid)));

    let opened = 0;
    for (const uid of uids) {
      try {
        const contacts = await db().collection(`users/${uid}/contacts`).get();
        for (const c of contacts.docs) {
          const data = c.data();
          const lastTouch = data.lastMeaningfulInteractionAt || data.lastActivityAt;
          if (!lastTouch) continue;
          if (Date.parse(lastTouch) >= cutoff) continue;
          if (data.followThroughNeeded) continue;
          await db().doc(`users/${uid}/tasks/${c.id}`).set({
            type: 'follow_through',
            label: 'Follow Through needed',
            contactId: c.id,
            contactName: data.name || '',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'open',
          }, { merge: true });
          await c.ref.set({ followThroughNeeded: true }, { merge: true });
          opened++;
        }
      } catch (e) {
        console.warn(`[lcFollowThroughSweep] uid=${uid} failed:`, e.message);
      }
    }
    console.log(`[lcFollowThroughSweep] users=${uids.size} opened=${opened}`);
  },
);

exports.lolaConnect = onRequest(
  { cors: true, secrets: [LOLA_CONNECT_SERVICE_TOKEN], timeoutSeconds: 60 },
  async (req, res) => {
    const started = Date.now();
    let uid = null;
    let op = null;
    try {
      if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'Method Not Allowed' });
        return;
      }
      const decoded = await requireAuth(req);
      uid = decoded.uid;

      if (!(await featureAllowed(uid))) {
        res.status(403).json({ ok: false, error: 'Lola Connect is not enabled for your account yet.' });
        return;
      }

      op = req.body && typeof req.body.op === 'string' ? req.body.op : '';
      if (!ALLOWED_OPS.has(op)) {
        res.status(400).json({ ok: false, error: `Unsupported op "${op}".` });
        return;
      }

      const gatewayRes = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${LOLA_CONNECT_SERVICE_TOKEN.value()}`,
        },
        body: JSON.stringify(buildGatewayBody(op, uid, req)),
      });
      const payload = await gatewayRes.json().catch(() => ({ ok: false, error: 'Bad gateway response' }));
      // Pass the gateway's status + JSON straight through (never the token).
      res.status(gatewayRes.status).json(payload);
    } catch (e) {
      const code = e.code === 401 ? 401 : 500;
      console.error(`[lolaConnect] op=${op} uid=${uid || 'anon'} failed:`, e.message);
      res.status(code).json({ ok: false, error: e.message || 'Request failed' });
    } finally {
      console.log(`[lolaConnect] op=${op} uid=${uid || 'anon'} ${Date.now() - started}ms`);
    }
  },
);
