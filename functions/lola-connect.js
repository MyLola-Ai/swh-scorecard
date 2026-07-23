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
// ADDITIVE + FLAG-GATED: does not touch nylas.js or the legacy Gmail/Outlook
// sync. Retirement (R2) is a later, separate step.
//
// Secret (Firebase Secret Manager, set with `firebase functions:secrets:set`):
//   LOLA_CONNECT_SERVICE_TOKEN  — the SAME value as on loaniq-75a20. Never
//   exposed to a frontend; only ever sent server→server to the gateway.
// ============================================================

const { onRequest } = require('firebase-functions/v2/https');
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
// connected LC account (caller falls back to Nylas — dual-run, nobody breaks).
// Throws only on a genuine send failure so the caller can surface it.
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

exports.lcTrySendEmail = lcTrySendEmail;
exports.LOLA_CONNECT_SERVICE_TOKEN = LOLA_CONNECT_SERVICE_TOKEN;

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
