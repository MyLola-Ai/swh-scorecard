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
const ADMIN_EMAILS_FTQ = ['austen@austensmith.com'];

exports.sendFollowThroughEmail = onRequest(
  { cors: true, secrets: [lolaConnectModule.LOLA_CONNECT_SERVICE_TOKEN], invoker: 'public' },
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

      const { docId, contactId, stepIndex, subject, body, kind } = req.body || {};
      // A 1:1 thank-you is queued by onOneOnOneLogged, not by the playbook
      // builder, so it legitimately carries no stepIndex.
      const isThankYou = kind === 'thankyou';
      if (!docId || !contactId || (!isThankYou && stepIndex === undefined) || !body) {
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
        return res.status(409).json({
          error: 'Connect your email in Settings before sending.',
          code: 'lola_connect_required',
        });
      }
      const sentMsgId = lc.providerEmailId || `lc_${Date.now()}`;
      const nowIso = new Date().toISOString();
      const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

      const q = queueDoc.data();
      const batch = db().batch();

      // (a) Email record with direction:'sent' so the Emails tab renders correctly
      batch.set(db().doc(`users/${uid}/contacts/${contactId}/emails/${sentMsgId}`), {
        direction: 'sent',
        subject: subject || q.draftSubject || '',
        snippet: body.slice(0, 200),
        sentAt: nowIso,
        source: 'follow-through-queue',
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // (b) Activity log
      const actId = `ftq_${contactId}_${isThankYou ? 'thanks' : stepIndex}_${todayKey}`;
      batch.set(db().doc(`users/${uid}/contacts/${contactId}/activities/${actId}`), {
        type: q.stepName || `Step ${stepIndex + 1}`,
        source: 'follow-through-queue',
        points: q.stepPoints || 1,
        timestamp: nowIso,
        dateKey: todayKey,
        contactId,
        contactName: contact.name,
      });

      // (c) Advance steps counter (integer, capped at 8). A thank-you is NOT a
      // playbook step — advancing here would silently push the contact forward
      // a step they never actually completed, so it holds its current value.
      const newSteps = isThankYou ? (contact.steps || 0) : Math.min(8, (contact.steps || 0) + 1);
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

      res.json({ ok: true, newSteps, sentMsgId, via: 'lola-connect' });
    } catch (e) {
      console.error('[sendFollowThroughEmail]', e);
      sendErr(res, e);
    }
  }
);
