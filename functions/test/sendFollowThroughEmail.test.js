// sendFollowThroughEmail -- extraction test for the entitlement-gate fix.
// This used to be hardcoded to ADMIN_EMAILS_FTQ = ['austen@austensmith.com'],
// a SEPARATE allowlist from the queue builder's own ADMIN_EMAILS, never
// updated when the builder was widened to include MyLola-linked users
// (2026-08-30). Result: a MyLola-linked non-Austen user could have queue
// items built for them but got a 403 the instant they tried to send one
// from the CRM itself. Now uses the same hasLinkedMyLolaAccount-or-paid
// check as getScorecardForUser/saveDayForUser/the builder.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../nylas.js'), 'utf8');
const startMarker = 'exports.sendFollowThroughEmail = onRequest(';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'sendFollowThroughEmail not found');
const bodyStart = src.indexOf('async (req, res) => {', startIdx) + 'async (req, res) => {'.length;
const endIdx = src.indexOf('\n  }\n);', bodyStart);
assert.ok(endIdx !== -1, 'handler end not found');
const handlerOnlySrc = src.slice(bodyStart, endIdx);

function makeHandler({ userData, mylolaLinked, plan, sendResult }) {
  const admin = {}; // unused directly by this slice; db() below stands in for admin.firestore()
  const requireAuth = async () => ({ uid: 'u1' });
  const db = () => ({
    doc: (p) => {
      if (p === 'users/u1') return { get: async () => ({ exists: userData !== null, data: () => userData }) };
      throw new Error('unexpected doc path: ' + p);
    },
  });
  const _hasLinkedMyLolaAccount = async () => !!mylolaLinked;
  const _resolveEffectivePlan = async () => plan || 'free';
  const executeFollowThroughSend = async () => sendResult || { newSteps: 3, sentMsgId: 'lc_1' };

  let statusCode = 200, jsonBody = null;
  const fakeRes = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  const fn = new Function(
    'admin', 'requireAuth', 'db', '_hasLinkedMyLolaAccount', '_resolveEffectivePlan', 'executeFollowThroughSend', 'console',
    `return async (req, res) => {${handlerOnlySrc}}`,
  )(admin, requireAuth, db, _hasLinkedMyLolaAccount, _resolveEffectivePlan, executeFollowThroughSend, console);

  return async (body) => {
    await fn({ body }, fakeRes);
    return { statusCode, body: jsonBody };
  };
}

test('a MyLola-linked user on a free SWH plan can send -- the exact gap this fix closes', async () => {
  const call = makeHandler({ userData: { plan: 'free' }, mylolaLinked: true });
  const r = await call({ docId: 'c1_2', contactId: 'c1', stepIndex: 2, subject: 'x', body: 'y' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
});

test('a paid SWH user (not MyLola-linked, not Austen) can send', async () => {
  const call = makeHandler({ userData: { plan: 'pro' }, mylolaLinked: false, plan: 'pro' });
  const r = await call({ docId: 'c1_2', contactId: 'c1', stepIndex: 2, subject: 'x', body: 'y' });
  assert.equal(r.statusCode, 200);
});

test('an unlinked, free SWH user is still blocked -- this is not a blanket opening', async () => {
  const call = makeHandler({ userData: { plan: 'free' }, mylolaLinked: false });
  const r = await call({ docId: 'c1_2', contactId: 'c1', stepIndex: 2, subject: 'x', body: 'y' });
  assert.equal(r.statusCode, 403);
});

test('lola_connect_required from the send core still surfaces as 409 through this endpoint too', async () => {
  const call = makeHandler({ userData: { plan: 'pro' }, mylolaLinked: false });
  // Override executeFollowThroughSend to throw, by rebuilding with a throwing send.
  const admin = {};
  const requireAuth = async () => ({ uid: 'u1' });
  const db = () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ plan: 'pro' }) }) }) });
  const _hasLinkedMyLolaAccount = async () => false;
  const _resolveEffectivePlan = async () => 'pro';
  const executeFollowThroughSend = async () => { const e = new Error('Connect your email in Settings before sending.'); e.lolaConnectRequired = true; throw e; };
  let statusCode = 200, jsonBody = null;
  const fakeRes = { status(c) { statusCode = c; return this; }, json(b) { jsonBody = b; return this; } };
  const fn = new Function(
    'admin', 'requireAuth', 'db', '_hasLinkedMyLolaAccount', '_resolveEffectivePlan', 'executeFollowThroughSend', 'console',
    `return async (req, res) => {${handlerOnlySrc}}`,
  )(admin, requireAuth, db, _hasLinkedMyLolaAccount, _resolveEffectivePlan, executeFollowThroughSend, console);
  await fn({ body: { docId: 'c1_2', contactId: 'c1', stepIndex: 2, subject: 'x', body: 'y' } }, fakeRes);
  assert.equal(statusCode, 409);
  assert.equal(jsonBody.code, 'lola_connect_required');
});
