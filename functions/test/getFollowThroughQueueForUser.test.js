// getFollowThroughQueueForUser -- extraction test. Read half of the Morning
// Queue bridge for MyLola's MyTasks (docs/swh-morning-queue-in-mytasks.md).
// Sibling of getScorecardForUser: shared bearer, provision-on-read identity,
// canAct mirroring canLog.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const startMarker = 'exports.getFollowThroughQueueForUser = onRequest(';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'getFollowThroughQueueForUser not found');
const bodyStart = src.indexOf('async (req, res) => {', startIdx) + 'async (req, res) => {'.length;
const endIdx = src.indexOf('\n  }\n);', bodyStart);
assert.ok(endIdx !== -1, 'handler end not found');
const handlerOnlySrc = src.slice(bodyStart, endIdx);

function makeHandler({ users, queueDocs, secretValue, mylolaLinked, plan }) {
  const admin = {
    auth: () => ({
      getUserByEmail: async (email) => {
        const uid = Object.keys(users).find(u => users[u].email === email);
        if (!uid) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
        return { uid };
      },
      createUser: async ({ email }) => {
        const uid = 'provisioned_' + Object.keys(users).length;
        users[uid] = { email, plan: 'pro', subscriptionStatus: 'comp' };
        return { uid };
      },
    }),
    firestore: () => ({
      doc: (p) => {
        const m = p.match(/^users\/([^/]+)$/);
        if (m) return { get: async () => ({ exists: !!users[m[1]], data: () => users[m[1]] }) };
        throw new Error('unexpected doc path: ' + p);
      },
      collection: (p) => {
        const m = p.match(/^users\/([^/]+)\/followThroughQueue$/);
        assert.ok(m, 'unexpected collection path: ' + p);
        const uid = m[1];
        const filters = [];
        const api = {
          where(field, op, value) { filters.push({ field, op, value }); return api; },
          get: async () => {
            const docs = (queueDocs[uid] || []).filter(d =>
              filters.every(f => f.op === '==' ? d[f.field] === f.value : true)
            );
            return { docs: docs.map(d => ({ id: d.id, data: () => d })) };
          },
        };
        return api;
      },
    }),
  };

  const MYLOLA_INTEGRATION_SECRET = { value: () => secretValue };
  const getOrProvisionSwhUser = async (email) => {
    const existingUid = Object.keys(users).find(u => users[u].email === email);
    if (existingUid) return { uid: existingUid, provisioned: false };
    const uid = 'provisioned_' + Object.keys(users).length;
    users[uid] = { email, plan: 'pro', subscriptionStatus: 'comp' };
    return { uid, provisioned: true };
  };
  const hasLinkedMyLolaAccount = async () => !!mylolaLinked;
  const resolveEffectivePlan = async () => plan || 'free';
  const chicagoTodayKey = () => '2026-08-31';

  let statusCode = 200, jsonBody = null;
  const fakeRes = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  const fn = new Function(
    'admin', 'MYLOLA_INTEGRATION_SECRET', 'getOrProvisionSwhUser', 'hasLinkedMyLolaAccount', 'resolveEffectivePlan', 'chicagoTodayKey', 'FOLLOW_THROUGH_QUEUE_READ_MAX',
    `return async (req, res) => {${handlerOnlySrc}}`,
  )(admin, MYLOLA_INTEGRATION_SECRET, getOrProvisionSwhUser, hasLinkedMyLolaAccount, resolveEffectivePlan, chicagoTodayKey, 100);

  return async (body, headers) => {
    await fn({ method: 'POST', headers: headers || { authorization: 'Bearer ' + secretValue }, body }, fakeRes);
    return { statusCode, body: jsonBody };
  };
}

const STEP_ITEM = { id: 'c1_2', contactId: 'c1', contactName: 'Jamie', contactEmail: 'jamie@x.com', stepIndex: 2, stepName: 'Step 3', stepPoints: 5, dueDate: '2026-08-31', draftSubject: 'Hi', draftBody: 'Body', status: 'pending' };

test('rejects a bad bearer', async () => {
  const handler = makeHandler({ users: {}, queueDocs: {}, secretValue: 'real-secret' });
  const r = await handler({ subjectEmail: 'a@b.com' }, { authorization: 'Bearer wrong' });
  assert.equal(r.statusCode, 401);
});

test('an unknown email is provisioned, not told to link an account', async () => {
  const users = {};
  const call = makeHandler({ users, queueDocs: {}, secretValue: 's', plan: 'pro' });
  const r = await call({ subjectEmail: 'nobody@example.com' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.found, true);
  assert.deepEqual(r.body.items, []);
});

test('returns only pending items, mapped to the documented field shape', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'pro' } };
  const queueDocs = { u1: [STEP_ITEM, { ...STEP_ITEM, id: 'c1_3', status: 'sent' }] };
  const call = makeHandler({ users, queueDocs, secretValue: 's', plan: 'pro' });
  const r = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(r.body.items.length, 1, 'the sent item must not appear');
  const item = r.body.items[0];
  assert.equal(item.contactId, 'c1');
  assert.equal(item.stepIndex, 2);
  assert.equal(item.docId, 'c1_2');
});

test('a snoozed-forward item (dueDate in the future) is excluded even though status is still pending', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'pro' } };
  const queueDocs = { u1: [{ ...STEP_ITEM, dueDate: '2026-09-15' }] };
  const call = makeHandler({ users, queueDocs, secretValue: 's', plan: 'pro' });
  const r = await call({ subjectEmail: 'lo@example.com' });
  assert.deepEqual(r.body.items, [], 'a snoozed item due in the future must not show as actionable today');
});

test('a thank-you item (no stepIndex) is included with stepIndex normalized to null', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'pro' } };
  const thankYou = { id: 'c1_thanks_a1', contactId: 'c1', contactName: 'Jamie', contactEmail: 'jamie@x.com', kind: 'thankyou', stepName: 'Thanks!', stepPoints: 0, dueDate: '2026-08-30', draftSubject: 'Thanks', draftBody: 'Great meeting you', status: 'pending' };
  const queueDocs = { u1: [thankYou] };
  const call = makeHandler({ users, queueDocs, secretValue: 's', plan: 'pro' });
  const r = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].stepIndex, null);
});

test('canAct is true for a linked account even on a free SWH plan', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'free' } };
  const call = makeHandler({ users, queueDocs: { u1: [] }, secretValue: 's', plan: 'free', mylolaLinked: true });
  const r = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(r.body.canAct, true);
});

test('canAct is false for an unlinked free SWH plan', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'free' } };
  const call = makeHandler({ users, queueDocs: { u1: [] }, secretValue: 's', plan: 'free', mylolaLinked: false });
  const r = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(r.body.canAct, false);
});
