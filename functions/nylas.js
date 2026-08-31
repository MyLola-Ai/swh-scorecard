// ============================================================
// CALENDAR / EMAIL — Lola-Connect-only (Nylas fully removed 2026-08-08)
// ============================================================
// Was the Nylas v3 unified integration. Nylas EOL'd 2026-08-02; every
// endpoint here now proxies straight to Lola Connect (lola-connect.js),
// no fallback. OAuth connect/callback, the grant store at
// users/{uid}/integrations/nylas, and the old scope-mapping tables are
// gone -- connecting is entirely Lola Connect's own flow now (see
// public-crm/index.html's refreshLolaConnectStatus / lolaConnectConnect).
// ============================================================

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const lolaConnectModule = require('./lola-connect');

// Lazily resolve Firestore — admin.initializeApp() runs in index.js before
// this module is required, so we never touch firestore() at import time.
const db = () => admin.firestore();

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

// ============================================================
// Calendar: create / delete events on the user's primary calendar
// ============================================================
// Used by the CRM's 8-step follow-through system to schedule step reminders
// when starting a campaign, and to remove them when stopping sync.
// Only the user's own calendar is written — no invites are sent.
exports.createCalendarEvent = onRequest(
  { cors: true, secrets: [lolaConnectModule.LOLA_CONNECT_SERVICE_TOKEN], invoker: 'public' },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const src = req.body || {};
      const { title, startTime, endTime, description, participants, location } = src;
      if (!title || !startTime || !endTime) throw new Error('Missing title, startTime, or endTime');

      // Attendees — the calendar provider emails them a real invite
      const attendees = Array.isArray(participants)
        ? participants
            .filter(p => p && typeof p.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim()))
            .slice(0, 10)
            .map(p => ({ email: p.email.trim(), name: String(p.name || '').slice(0, 80) }))
        : [];

      // Lola Connect only (Nylas fallback removed 2026-07-28, Austen's
      // direct instruction ahead of the Aug 2 EOL — code no longer touches
      // Nylas here, even for a user with no LC connection).
      const lc = await lolaConnectModule.lcTryCreateEvent(decoded.uid, {
        title: String(title),
        startISO: new Date(Math.floor(Number(startTime)) * 1000).toISOString(),
        endISO: new Date(Math.floor(Number(endTime)) * 1000).toISOString(),
        description: description ? String(description).slice(0, 2000) : undefined,
        location: location ? String(location).slice(0, 200) : undefined,
        attendees,
        notify: attendees.length > 0,
      });
      if (!lc) {
        return res.status(409).json({
          error: 'Connect your calendar in Settings before scheduling.',
          code: 'lola_connect_required',
        });
      }
      return res.json({ ok: true, eventId: lc.eventId, invited: attendees.length, via: 'lola-connect' });
    } catch (e) {
      console.error('[createCalendarEvent]', e);
      sendErr(res, e);
    }
  }
);

exports.deleteCalendarEvent = onRequest(
  { cors: true, secrets: [lolaConnectModule.LOLA_CONNECT_SERVICE_TOKEN], invoker: 'public' },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const { eventId, notify } = req.body || {};
      if (!eventId) throw new Error('Missing eventId');

      // Lola Connect only (asymmetric miss fixed 2026-08-05: createCalendarEvent
      // migrated 2026-07-28 alongside sendContactEmail, this one didn't --
      // Nylas has been dead since Aug 2, code no longer touches it here).
      const lc = await lolaConnectModule.lcTryDeleteEvent(decoded.uid, { eventId, notify });
      if (!lc) {
        return res.status(409).json({
          error: 'Connect your calendar in Settings before managing events.',
          code: 'lola_connect_required',
        });
      }
      return res.json({ ok: true, via: 'lola-connect' });
    } catch (e) {
      console.error('[deleteCalendarEvent]', e);
      sendErr(res, e);
    }
  }
);

// ============================================================
// Direct send from the Lola Draft modal — any contact, no queue.
// Sends via the user's connected Lola Connect account and records the
// email on the contact (Emails tab). No step/points side effects; the
// user marks steps intentionally.
// ============================================================
// Nylas treats `body` as HTML while our drafts are plain text — sending raw
// text collapses every paragraph break into one blob on the recipient's end.
function textBodyToHtml(body) {
  return escapeHtml(String(body))
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>');
}

exports.sendContactEmail = onRequest(
  { cors: true, secrets: [lolaConnectModule.LOLA_CONNECT_SERVICE_TOKEN], invoker: 'public' },
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

      const html = textBodyToHtml(body);

      // Lola Connect only (Nylas fallback removed 2026-07-28, Austen's
      // direct instruction ahead of the Aug 2 EOL — code no longer touches
      // Nylas here, even for a user with no LC connection).
      const lc = await lolaConnectModule.lcTrySendEmail(uid, {
        to: contact.email,
        name: contact.name || contact.email,
        subject: subject || 'Hello',
        html,
      });
      if (!lc) {
        return res.status(409).json({
          error: 'Connect your email in Settings before sending.',
          code: 'lola_connect_required',
        });
      }
      const lcMsgId = lc.providerEmailId || `lc_${Date.now()}`;
      await db().doc(`users/${uid}/contacts/${contactId}/emails/${lcMsgId}`).set({
        direction: 'sent',
        subject: subject || '',
        snippet: String(body).slice(0, 200),
        sentAt: new Date().toISOString(),
        source: 'lola-draft',
        via: 'lola-connect',
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ ok: true, id: lcMsgId, via: 'lola-connect' });
    } catch (e) {
      console.error('[sendContactEmail]', e.message);
      return sendErr(res, e);
    }
  }
);

// ============================================================
// Follow-Through Queue: one-tap send from the morning queue
// ============================================================
// Entitlement helpers live in index.js (hasLinkedMyLolaAccount,
// resolveEffectivePlan) -- injected here rather than required directly to
// avoid a circular require (index.js already requires this module to
// Object.assign its exports). Set once at cold start, before any request is
// served; the no-op defaults exist only so a missing injection fails
// closed (nothing entitled) instead of throwing.
let _hasLinkedMyLolaAccount = async () => false;
let _resolveEffectivePlan = async () => 'free';
function setSharedEntitlementHelpers({ hasLinkedMyLolaAccount, resolveEffectivePlan }) {
  _hasLinkedMyLolaAccount = hasLinkedMyLolaAccount;
  _resolveEffectivePlan = resolveEffectivePlan;
}
exports.setSharedEntitlementHelpers = setSharedEntitlementHelpers;

// Shared core of a follow-through "send": send the email via Lola Connect,
// then atomically transition state (email record, activity log, advance the
// contact's step, mark the queue doc sent). Used by BOTH
// sendFollowThroughEmail below (the CRM's own one-tap send, a signed-in
// user's own session) and actOnFollowThroughForUser's 'send' action in
// index.js (MyLola's server-to-server bridge, which has no signed-in
// session to present). Callers do their OWN auth/entitlement gating --
// this trusts the uid it's given, same shape as getOrProvisionSwhUser.
//
// A transaction, not the original's plain batch: the steps advance is
// capped at 8 and a thank-you never advances at all, neither of which a
// bare FieldValue.increment can express atomically. Re-reading the contact
// at commit time (and retrying on contention, which runTransaction does
// automatically) closes a real if narrow race the original left open: two
// concurrent sends for the same contact could both read steps=N and both
// write N+1, losing one advance.
async function executeFollowThroughSend(uid, { docId, contactId, stepIndex, kind, subject, body }) {
  const isThankYou = kind === 'thankyou';
  if (!docId || !contactId || (!isThankYou && stepIndex === undefined) || !body) {
    const e = new Error('Missing required fields.');
    e.code = 400;
    throw e;
  }

  const [queueDoc, contactDoc] = await Promise.all([
    db().doc(`users/${uid}/followThroughQueue/${docId}`).get(),
    db().doc(`users/${uid}/contacts/${contactId}`).get(),
  ]);
  if (!queueDoc.exists) { const e = new Error('Queue item not found.'); e.code = 404; throw e; }
  if (!contactDoc.exists) { const e = new Error('Contact not found.'); e.code = 404; throw e; }

  const contact = contactDoc.data();
  if (!contact.email) { const e = new Error('Contact has no email address.'); e.code = 400; throw e; }

  // Lola Connect only (asymmetric miss fixed 2026-08-05: sendContactEmail
  // migrated 2026-07-28 alongside createCalendarEvent, this one -- the
  // follow-through queue's one-tap send -- did not. Nylas has been dead
  // since Aug 2; every send through this path was failing until now).
  const lc = await lolaConnectModule.lcTrySendEmail(uid, {
    to: contact.email,
    name: contact.name || contact.email,
    subject: subject || queueDoc.data().draftSubject || 'Checking in',
    html: textBodyToHtml(body),
  });
  if (!lc) {
    const e = new Error('Connect your email in Settings before sending.');
    e.code = 409;
    e.lolaConnectRequired = true;
    throw e;
  }

  const sentMsgId = lc.providerEmailId || `lc_${Date.now()}`;
  const nowIso = new Date().toISOString();
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const q = queueDoc.data();

  const newSteps = await db().runTransaction(async (txn) => {
    const freshContactSnap = await txn.get(db().doc(`users/${uid}/contacts/${contactId}`));
    const freshSteps = freshContactSnap.exists ? (freshContactSnap.data().steps || 0) : 0;
    // A thank-you is NOT a playbook step -- advancing here would silently
    // push the contact forward a step they never actually completed.
    const computedNewSteps = isThankYou ? freshSteps : Math.min(8, freshSteps + 1);

    txn.set(db().doc(`users/${uid}/contacts/${contactId}/emails/${sentMsgId}`), {
      direction: 'sent',
      subject: subject || q.draftSubject || '',
      snippet: body.slice(0, 200),
      sentAt: nowIso,
      source: 'follow-through-queue',
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const actId = `ftq_${contactId}_${isThankYou ? 'thanks' : stepIndex}_${todayKey}`;
    txn.set(db().doc(`users/${uid}/contacts/${contactId}/activities/${actId}`), {
      type: q.stepName || `Step ${stepIndex + 1}`,
      source: 'follow-through-queue',
      points: q.stepPoints || 1,
      timestamp: nowIso,
      dateKey: todayKey,
      contactId,
      contactName: contact.name,
    });

    txn.set(db().doc(`users/${uid}/contacts/${contactId}`), {
      steps: computedNewSteps,
      lastActivityAt: nowIso,
      lastOutboundAt: nowIso,
    }, { merge: true });

    txn.set(db().doc(`users/${uid}/followThroughQueue/${docId}`), {
      status: 'sent',
      sentAt: nowIso,
    }, { merge: true });

    return computedNewSteps;
  });

  return { newSteps, sentMsgId, stepPoints: q.stepPoints, stepName: q.stepName };
}
exports.executeFollowThroughSend = executeFollowThroughSend;

exports.sendFollowThroughEmail = onRequest(
  { cors: true, secrets: [lolaConnectModule.LOLA_CONNECT_SERVICE_TOKEN], invoker: 'public' },
  async (req, res) => {
    try {
      const decoded = await requireAuth(req);
      const uid = decoded.uid;

      // Entitled if paid SWH or a linked MyLola account (Austen's ruling,
      // 2026-08-30) -- same check getScorecardForUser/saveDayForUser/the
      // queue builder already use. This used to be a SEPARATE hardcoded
      // ADMIN_EMAILS_FTQ = ['austen@austensmith.com'] that was never
      // updated when the builder itself was widened: a MyLola-linked
      // non-Austen user could have queue items built for them but got a
      // 403 the moment they tried to actually send one from the CRM.
      const userSnap = await db().doc(`users/${uid}`).get();
      const userData = userSnap.exists ? userSnap.data() : {};
      const [linked, plan] = await Promise.all([
        _hasLinkedMyLolaAccount(uid),
        _resolveEffectivePlan(uid, userData),
      ]);
      if (!linked && plan === 'free') {
        return res.status(403).json({ error: 'Not available yet.' });
      }

      const { docId, contactId, stepIndex, subject, body, kind } = req.body || {};
      const result = await executeFollowThroughSend(uid, { docId, contactId, stepIndex, kind, subject, body });
      res.json({ ok: true, newSteps: result.newSteps, sentMsgId: result.sentMsgId, via: 'lola-connect' });
    } catch (e) {
      console.error('[sendFollowThroughEmail]', e);
      if (e.lolaConnectRequired) {
        return res.status(409).json({ error: e.message, code: 'lola_connect_required' });
      }
      sendErr(res, e);
    }
  }
);
