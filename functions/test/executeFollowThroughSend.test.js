// executeFollowThroughSend -- extraction test for the shared core of a
// follow-through "send" (functions/nylas.js), used by BOTH the CRM's own
// sendFollowThroughEmail (a signed-in user's session) and MyLola's
// actOnFollowThroughForUser 'send' action (a server-to-server bridge). This
// is the function that makes "send" more than "send an email": it must
// send via Lola Connect AND atomically record the email, log the activity,
// advance (or not) the contact's step, and mark the queue doc sent.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../nylas.js'), 'utf8');
const startMarker = 'async function executeFollowThroughSend(uid, { docId, contactId, stepIndex, kind, subject, body }) {';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'executeFollowThroughSend not found');
const bodyStart = startIdx + startMarker.length;
const endIdx = src.indexOf('\n}', bodyStart);
assert.ok(endIdx !== -1, 'function end not found');
const bodySrc = src.slice(bodyStart, endIdx);

// A minimal Firestore fake with real transaction semantics: txn.get reads
// from the SAME store a plain .get() would see, txn.set stages writes that
// only land in the store once the transaction function returns
// successfully -- close enough to the real contract for what this function
// exercises (no concurrent-writer simulation needed, just correctness of
// what gets written and in what shape).
function makeFirestore(store) {
  const docRef = (path) => ({
    __path: path,
    get: async () => ({ exists: store[path] !== undefined, data: () => store[path] }),
  });
  return {
    doc: (p) => docRef(p),
    runTransaction: async (fn) => {
      const staged = [];
      const txn = {
        get: async (ref) => ({ exists: store[ref.__path] !== undefined, data: () => store[ref.__path] }),
        set: (ref, data, opts) => {
          staged.push(() => {
            store[ref.__path] = (opts && opts.merge) ? { ...(store[ref.__path] || {}), ...data } : data;
          });
        },
      };
      const result = await fn(txn);
      staged.forEach(apply => apply());
      return result;
    },
  };
}

function makeFn({ store, lcResult, lcThrows }) {
  const admin = {
    firestore: () => makeFirestore(store),
  };
  admin.firestore.FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP' };
  const lolaConnectModule = {
    lcTrySendEmail: async () => {
      if (lcThrows) throw new Error('lola connect unavailable');
      return lcResult;
    },
  };
  const textBodyToHtml = (b) => `<p>${b}</p>`;
  const db = () => admin.firestore();
  const fn = new Function(
    'admin', 'lolaConnectModule', 'textBodyToHtml', 'db',
    `return async (uid, { docId, contactId, stepIndex, kind, subject, body }) => {${bodySrc}}`,
  )(admin, lolaConnectModule, textBodyToHtml, db);
  return fn;
}

const BASE_CONTACT = { name: 'Jamie Rivera', email: 'jamie@example.com', steps: 2 };
const BASE_QUEUE_DOC = { draftSubject: 'Checking in', draftBody: 'Hi there', stepName: 'Step 3', stepPoints: 5 };

test('a regular step: sends, records the email, advances steps by 1, marks the queue doc sent', async () => {
  const store = {
    'users/u1/followThroughQueue/c1_2': { ...BASE_QUEUE_DOC },
    'users/u1/contacts/c1': { ...BASE_CONTACT },
  };
  const fn = makeFn({ store, lcResult: { providerEmailId: 'lc_msg_1' } });
  const result = await fn('u1', { docId: 'c1_2', contactId: 'c1', stepIndex: 2, kind: undefined, subject: 'Checking in', body: 'Hi there' });

  assert.equal(result.newSteps, 3, 'steps must advance by exactly 1');
  assert.equal(result.sentMsgId, 'lc_msg_1');
  assert.equal(store['users/u1/contacts/c1'].steps, 3);
  assert.equal(store['users/u1/followThroughQueue/c1_2'].status, 'sent');
  assert.ok(store['users/u1/followThroughQueue/c1_2'].sentAt);
  const emailDoc = store['users/u1/contacts/c1/emails/lc_msg_1'];
  assert.ok(emailDoc, 'expected an email record');
  assert.equal(emailDoc.direction, 'sent');
  const activityDoc = store['users/u1/contacts/c1/activities/ftq_c1_2_' + new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })];
  assert.ok(activityDoc, 'expected an activity log entry');
});

test('steps cap at 8, never higher, even from 7', async () => {
  const store = {
    'users/u1/followThroughQueue/c1_7': { ...BASE_QUEUE_DOC },
    'users/u1/contacts/c1': { ...BASE_CONTACT, steps: 7 },
  };
  const fn = makeFn({ store, lcResult: { providerEmailId: 'lc_msg_2' } });
  const result = await fn('u1', { docId: 'c1_7', contactId: 'c1', stepIndex: 7, subject: 'x', body: 'y' });
  assert.equal(result.newSteps, 8);

  // One more send past the cap must stay at 8, not go to 9.
  store['users/u1/followThroughQueue/c1_8'] = { ...BASE_QUEUE_DOC };
  const result2 = await fn('u1', { docId: 'c1_8', contactId: 'c1', stepIndex: 8, subject: 'x', body: 'y' });
  assert.equal(result2.newSteps, 8, 'must not exceed the 8-step cap');
});

test('a thank-you item (kind:"thankyou") does NOT advance steps, needs no stepIndex', async () => {
  const store = {
    'users/u1/followThroughQueue/c1_thanks_a1': { contactName: 'Jamie', draftSubject: 'Thanks!', draftBody: 'Great meeting you', stepPoints: 0 },
    'users/u1/contacts/c1': { ...BASE_CONTACT, steps: 4 },
  };
  const fn = makeFn({ store, lcResult: { providerEmailId: 'lc_msg_3' } });
  const result = await fn('u1', { docId: 'c1_thanks_a1', contactId: 'c1', kind: 'thankyou', subject: 'Thanks!', body: 'Great meeting you' });
  assert.equal(result.newSteps, 4, 'a thank-you must not advance the playbook step count');
  assert.equal(store['users/u1/contacts/c1'].steps, 4);
});

test('missing required fields (no stepIndex, not a thank-you) throws a 400-coded error, sends nothing', async () => {
  const store = { 'users/u1/followThroughQueue/c1_2': { ...BASE_QUEUE_DOC }, 'users/u1/contacts/c1': { ...BASE_CONTACT } };
  const fn = makeFn({ store, lcResult: { providerEmailId: 'should-not-send' } });
  await assert.rejects(
    () => fn('u1', { docId: 'c1_2', contactId: 'c1', body: 'Hi' }),
    (e) => e.code === 400,
  );
});

test('a contact with no email address is rejected before any send attempt', async () => {
  const store = {
    'users/u1/followThroughQueue/c1_2': { ...BASE_QUEUE_DOC },
    'users/u1/contacts/c1': { name: 'No Email Contact', steps: 1 },
  };
  const fn = makeFn({ store, lcResult: { providerEmailId: 'should-not-send' } });
  await assert.rejects(
    () => fn('u1', { docId: 'c1_2', contactId: 'c1', stepIndex: 1, subject: 'x', body: 'y' }),
    (e) => e.code === 400 && /email/i.test(e.message),
  );
});

test('no Lola Connect connection surfaces as a 409 with lolaConnectRequired, no partial state change', async () => {
  const store = {
    'users/u1/followThroughQueue/c1_2': { ...BASE_QUEUE_DOC },
    'users/u1/contacts/c1': { ...BASE_CONTACT },
  };
  const fn = makeFn({ store, lcResult: null }); // lcTrySendEmail resolves null == not connected
  await assert.rejects(
    () => fn('u1', { docId: 'c1_2', contactId: 'c1', stepIndex: 2, subject: 'x', body: 'y' }),
    (e) => e.code === 409 && e.lolaConnectRequired === true,
  );
  assert.equal(store['users/u1/followThroughQueue/c1_2'].status, undefined, 'must not mark sent when nothing was actually sent');
  assert.equal(store['users/u1/contacts/c1'].steps, 2, 'must not advance steps when nothing was actually sent');
});

test('unknown queue doc or unknown contact both 404, not 500', async () => {
  const storeNoQueue = { 'users/u1/contacts/c1': { ...BASE_CONTACT } };
  const fnNoQueue = makeFn({ store: storeNoQueue, lcResult: { providerEmailId: 'x' } });
  await assert.rejects(() => fnNoQueue('u1', { docId: 'missing', contactId: 'c1', stepIndex: 1, subject: 'x', body: 'y' }), (e) => e.code === 404);

  const storeNoContact = { 'users/u1/followThroughQueue/c1_2': { ...BASE_QUEUE_DOC } };
  const fnNoContact = makeFn({ store: storeNoContact, lcResult: { providerEmailId: 'x' } });
  await assert.rejects(() => fnNoContact('u1', { docId: 'c1_2', contactId: 'missing', stepIndex: 2, subject: 'x', body: 'y' }), (e) => e.code === 404);
});
