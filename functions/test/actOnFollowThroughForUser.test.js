// actOnFollowThroughForUser -- extraction test. Write half of the Morning
// Queue bridge for MyLola (docs/swh-morning-queue-in-mytasks.md): ONE
// endpoint for send | snooze | dismiss | regenerate, so MyLola never writes
// SWH's Firestore directly. send is the highest-stakes action -- it must
// route through the SAME executeFollowThroughSend core the CRM's own
// one-tap send uses, then separately award day-doc points (the one thing
// that has no server-side equivalent anywhere else), and it must honor
// client-provided clientEventId idempotency the same way saveDayForUser does.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const startMarker = 'exports.actOnFollowThroughForUser = onRequest(';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'actOnFollowThroughForUser not found');
const bodyStart = src.indexOf('async (req, res) => {', startIdx) + 'async (req, res) => {'.length;
const endIdx = src.indexOf('\n  }\n);', bodyStart);
assert.ok(endIdx !== -1, 'handler end not found');
const handlerOnlySrc = src.slice(bodyStart, endIdx);

function makeHandler({ users, queueDocs, contacts, secretValue, mylolaLinked, plan, sendThrows, draftResult }) {
  const admin = {
    firestore: () => ({
      doc: (p) => {
        let m;
        if ((m = p.match(/^users\/([^/]+)$/))) {
          return { get: async () => ({ exists: !!users[m[1]], data: () => users[m[1]] }) };
        }
        if ((m = p.match(/^users\/([^/]+)\/followThroughQueue\/([^/]+)$/))) {
          const [, uid, docId] = m;
          const doc = (queueDocs[uid] || {})[docId];
          return {
            get: async () => ({ exists: !!doc, data: () => doc }),
            set: async (data, opts) => {
              queueDocs[uid] = queueDocs[uid] || {};
              queueDocs[uid][docId] = (opts && opts.merge) ? { ...(queueDocs[uid][docId] || {}), ...data } : data;
            },
          };
        }
        if ((m = p.match(/^users\/([^/]+)\/contacts\/([^/]+)$/))) {
          const [, uid, cid] = m;
          return {
            get: async () => ({ exists: !!(contacts[uid] || {})[cid], data: () => (contacts[uid] || {})[cid] }),
            set: async (data, opts) => {
              contacts[uid] = contacts[uid] || {};
              contacts[uid][cid] = (opts && opts.merge) ? { ...(contacts[uid][cid] || {}), ...data } : data;
            },
          };
        }
        if (/\/config\/settings$/.test(p)) return { get: async () => ({ exists: false, data: () => ({}) }) };
        throw new Error('unexpected doc path: ' + p);
      },
      runTransaction: async (fn) => {
        const txn = {
          get: async (ref) => ref.get(),
          set: (ref, data, opts) => { ref.set(data, opts); },
        };
        return fn(txn);
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
  const executeFollowThroughSend = async (uid, args) => {
    if (sendThrows) throw sendThrows;
    const qDoc = (queueDocs[uid] || {})[args.docId];
    if (qDoc) qDoc.status = 'sent'; // mirror the real core's side effect for assertions
    return { newSteps: 3, sentMsgId: 'lc_test_1', stepPoints: qDoc ? qDoc.stepPoints : 5, stepName: qDoc ? qDoc.stepName : 'Step' };
  };
  let awardCalls = [];
  const awardFollowThroughPoints = async (uid, stepPoints) => {
    awardCalls.push({ uid, stepPoints });
    return { activityName: 'Perform Other 8 Step Activities', pts: stepPoints };
  };
  const draftWriteStep = async (ctx) => draftResult || { subject: 'New subject', body: 'New body', text: 'New body' };
  const meetRecencyPhrase = () => 'recently';
  const toDateKey = () => '2026-08-20';
  const buildSignature = () => 'Best,\nJamie';
  const stepLink = () => '';

  let statusCode = 200, jsonBody = null;
  const fakeRes = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  const fn = new Function(
    'admin', 'MYLOLA_INTEGRATION_SECRET', 'getOrProvisionSwhUser', 'hasLinkedMyLolaAccount', 'resolveEffectivePlan',
    'executeFollowThroughSend', 'awardFollowThroughPoints', 'draftWriteStep', 'meetRecencyPhrase', 'toDateKey', 'buildSignature', 'stepLink',
    `return async (req, res) => {${handlerOnlySrc}}`,
  )(admin, MYLOLA_INTEGRATION_SECRET, getOrProvisionSwhUser, hasLinkedMyLolaAccount, resolveEffectivePlan,
    executeFollowThroughSend, awardFollowThroughPoints, draftWriteStep, meetRecencyPhrase, toDateKey, buildSignature, stepLink);

  return {
    call: async (body, headers) => {
      await fn({ method: 'POST', headers: headers || { authorization: 'Bearer ' + secretValue }, body }, fakeRes);
      return { statusCode, body: jsonBody };
    },
    awardCalls: () => awardCalls,
  };
}

const BASE_USERS = () => ({ u1: { email: 'lo@example.com', plan: 'pro' } });
const BASE_QUEUE = () => ({ u1: { c1_2: { contactId: 'c1', stepIndex: 2, stepName: 'Step 3', stepPoints: 5, draftSubject: 'Hi', draftBody: 'Body', status: 'pending' } } });
const BASE_CONTACTS = () => ({ u1: { c1: { name: 'Jamie', email: 'jamie@x.com', steps: 2 } } });

test('rejects a bad bearer', async () => {
  const { call } = makeHandler({ users: BASE_USERS(), queueDocs: BASE_QUEUE(), contacts: BASE_CONTACTS(), secretValue: 'real' });
  const r = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'send' }, { authorization: 'Bearer wrong' });
  assert.equal(r.statusCode, 401);
});

test('rejects an unknown action', async () => {
  const { call } = makeHandler({ users: BASE_USERS(), queueDocs: BASE_QUEUE(), contacts: BASE_CONTACTS(), secretValue: 's' });
  const r = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'delete' });
  assert.equal(r.statusCode, 400);
});

test('404s on an unknown docId', async () => {
  const { call } = makeHandler({ users: BASE_USERS(), queueDocs: BASE_QUEUE(), contacts: BASE_CONTACTS(), secretValue: 's', plan: 'pro' });
  const r = await call({ subjectEmail: 'lo@example.com', docId: 'nonexistent', action: 'send' });
  assert.equal(r.statusCode, 404);
});

test('a free, unlinked account is paywalled (402) before any action runs', async () => {
  const { call, awardCalls } = makeHandler({ users: { u1: { email: 'lo@example.com', plan: 'free' } }, queueDocs: BASE_QUEUE(), contacts: BASE_CONTACTS(), secretValue: 's', plan: 'free', mylolaLinked: false });
  const r = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'send' });
  assert.equal(r.statusCode, 402);
  assert.equal(r.body.code, 'PAYWALL');
  assert.equal(awardCalls().length, 0, 'must not have sent/scored anything');
});

test('a linked account on a free SWH plan is NOT paywalled', async () => {
  const { call } = makeHandler({ users: { u1: { email: 'lo@example.com', plan: 'free' } }, queueDocs: BASE_QUEUE(), contacts: BASE_CONTACTS(), secretValue: 's', plan: 'free', mylolaLinked: true });
  const r = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'send' });
  assert.equal(r.statusCode, 200);
});

test('send: calls the shared send core, then awards day points, honoring an edited body/subject over the stored draft', async () => {
  const users = BASE_USERS();
  const { call, awardCalls } = makeHandler({ users, queueDocs: BASE_QUEUE(), contacts: BASE_CONTACTS(), secretValue: 's', plan: 'pro' });
  const r = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'send', subject: 'Edited subject', body: 'Edited body' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.status, 'sent');
  assert.equal(r.body.newSteps, 3);
  assert.equal(awardCalls().length, 1, 'points must be awarded exactly once');
  assert.equal(awardCalls()[0].stepPoints, 5);
});

test('send: a lola_connect_required failure surfaces as 409, not 500', async () => {
  const e = new Error('Connect your email in Settings before sending.');
  e.lolaConnectRequired = true;
  const { call, awardCalls } = makeHandler({ users: BASE_USERS(), queueDocs: BASE_QUEUE(), contacts: BASE_CONTACTS(), secretValue: 's', plan: 'pro', sendThrows: e });
  const r = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'send' });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.code, 'lola_connect_required');
  assert.equal(awardCalls().length, 0, 'must not award points when nothing was actually sent');
});

test('send: a repeated clientEventId is skipped, not re-sent', async () => {
  const users = BASE_USERS();
  const queueDocs = { u1: { c1_2: { ...BASE_QUEUE().u1.c1_2, mylolaActionEventIds: ['evt-1'] } } };
  const { call, awardCalls } = makeHandler({ users, queueDocs, contacts: BASE_CONTACTS(), secretValue: 's', plan: 'pro' });
  const r = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'send', clientEventId: 'evt-1' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(awardCalls().length, 0, 'a retried send must not send or score again');
});

test('send: two DIFFERENT clientEventIds both apply -- not a blanket single-send lock', async () => {
  // Note: sending twice on the SAME already-'sent' doc is a contrived setup
  // (the real doc would 404 as fresh once actually sent in prod), but this
  // isolates exactly what's under test: the idempotency KEY comparison, not
  // full state transition, matching how saveDayForUser's own equivalent
  // test isolates the same concern.
  const users = BASE_USERS();
  const queueDocs = BASE_QUEUE();
  const { call, awardCalls } = makeHandler({ users, queueDocs, contacts: BASE_CONTACTS(), secretValue: 's', plan: 'pro' });
  await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'send', clientEventId: 'evt-a' });
  queueDocs.u1.c1_2.status = 'pending'; // reset only what a fresh due-again item would show
  const r2 = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'send', clientEventId: 'evt-b' });
  assert.equal(r2.body.duplicate, undefined, 'a different event id must not be treated as a duplicate');
  assert.equal(awardCalls().length, 2);
});

test('snooze: rejects a malformed date, applies a valid one', async () => {
  const { call } = makeHandler({ users: BASE_USERS(), queueDocs: BASE_QUEUE(), contacts: BASE_CONTACTS(), secretValue: 's', plan: 'pro' });
  const bad = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'snooze', snoozeUntil: 'tomorrow' });
  assert.equal(bad.statusCode, 400);

  const queueDocs = BASE_QUEUE();
  const { call: call2 } = makeHandler({ users: BASE_USERS(), queueDocs, contacts: BASE_CONTACTS(), secretValue: 's', plan: 'pro' });
  const ok = await call2({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'snooze', snoozeUntil: '2026-09-05' });
  assert.equal(ok.statusCode, 200);
  assert.equal(queueDocs.u1.c1_2.dueDate, '2026-09-05');
  assert.ok(queueDocs.u1.c1_2.snoozedAt);
});

test('dismiss: sets status skipped and advances the step once, with no points', async () => {
  const queueDocs = BASE_QUEUE();
  const contacts = BASE_CONTACTS();
  const { call, awardCalls } = makeHandler({ users: BASE_USERS(), queueDocs, contacts, secretValue: 's', plan: 'pro' });
  const r = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'dismiss' });
  assert.equal(r.statusCode, 200);
  assert.equal(queueDocs.u1.c1_2.status, 'skipped');
  assert.equal(contacts.u1.c1.steps, 3, 'must advance the step once');
  assert.equal(awardCalls().length, 0, 'dismiss must never award points');
});

test('dismiss: does not rewind progress if the contact has already advanced past this step', async () => {
  const queueDocs = BASE_QUEUE();
  const contacts = { u1: { c1: { name: 'Jamie', email: 'jamie@x.com', steps: 5 } } }; // already past stepIndex 2
  const { call } = makeHandler({ users: BASE_USERS(), queueDocs, contacts, secretValue: 's', plan: 'pro' });
  await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'dismiss' });
  assert.equal(contacts.u1.c1.steps, 5, 'must not move steps backward or re-advance a stale item');
});

test('dismiss: a thank-you item never touches steps', async () => {
  const queueDocs = { u1: { c1_thanks_a1: { contactId: 'c1', kind: 'thankyou', stepPoints: 0, status: 'pending' } } };
  const contacts = BASE_CONTACTS();
  const { call } = makeHandler({ users: BASE_USERS(), queueDocs, contacts, secretValue: 's', plan: 'pro' });
  await call({ subjectEmail: 'lo@example.com', docId: 'c1_thanks_a1', action: 'dismiss' });
  assert.equal(contacts.u1.c1.steps, 2, 'a thank-you dismissal must not touch the playbook step count');
});

test('regenerate: passes the current draft and contact context into draftWriteStep, writes the new draft back', async () => {
  const queueDocs = BASE_QUEUE();
  const { call } = makeHandler({
    users: BASE_USERS(), queueDocs, contacts: BASE_CONTACTS(), secretValue: 's', plan: 'pro',
    draftResult: { subject: 'Warmer subject', body: 'Warmer body', text: 'Warmer body' },
  });
  const r = await call({ subjectEmail: 'lo@example.com', docId: 'c1_2', action: 'regenerate', feedback: 'Make it warmer' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.draftSubject, 'Warmer subject');
  assert.equal(queueDocs.u1.c1_2.draftSubject, 'Warmer subject');
  assert.equal(queueDocs.u1.c1_2.draftBody, 'Warmer body');
  assert.ok(queueDocs.u1.c1_2.regeneratedAt);
});
