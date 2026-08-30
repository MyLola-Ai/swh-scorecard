// getOrProvisionSwhUser -- the single shared helper behind Austen's ruling,
// 2026-08-30: "a MyLola user implies a comped SWH account." Extraction test
// against the real shipped function. Covers: the plain found-existing path
// (no create), first-touch provisioning with the comp fields stamped and
// attributed to the caller, and the concurrent-create race
// (auth/email-already-exists) resolving to the winner's uid instead of
// erroring -- Condition 1 ("idempotent and race-safe... handle the
// collision, don't hope").
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const startMarker = 'async function getOrProvisionSwhUser(email, via) {';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'getOrProvisionSwhUser not found');
const bodyStart = startIdx + startMarker.length;
const endIdx = src.indexOf('\n}', bodyStart);
assert.ok(endIdx !== -1, 'function end not found');
const bodySrc = src.slice(bodyStart, endIdx);

function makeFn({ existingUidByEmail = {}, createUserImpl, firestoreDocs = {} }) {
  const admin = {
    auth: () => ({
      getUserByEmail: async (email) => {
        const uid = existingUidByEmail[email];
        if (!uid) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
        return { uid };
      },
      createUser: createUserImpl,
    }),
    firestore: () => ({
      doc: (p) => ({
        set: async (data, opts) => {
          firestoreDocs[p] = (opts && opts.merge) ? { ...(firestoreDocs[p] || {}), ...data } : data;
        },
      }),
    }),
  };
  const SWH_COMP_PLAN_FIELDS = { plan: 'pro', subscriptionStatus: 'comp' };
  const fn = new Function(
    'admin', 'SWH_COMP_PLAN_FIELDS', 'console',
    `return async (email, via) => {${bodySrc}}`,
  )(admin, SWH_COMP_PLAN_FIELDS, console);
  return fn;
}

test('an existing account is found and NOT re-created', async () => {
  let createCalled = false;
  const firestoreDocs = {};
  const fn = makeFn({
    existingUidByEmail: { 'lo@example.com': 'uid_existing' },
    createUserImpl: async () => { createCalled = true; return { uid: 'should-not-happen' }; },
    firestoreDocs,
  });
  const result = await fn('lo@example.com', 'mylola-scorecard-read');
  assert.deepEqual(result, { uid: 'uid_existing', provisioned: false });
  assert.equal(createCalled, false, 'must not create a user that already exists');
  assert.deepEqual(firestoreDocs, {}, 'must not write anything for an existing account');
});

test('a first-touch email is provisioned with comp fields, attributed to the caller', async () => {
  const firestoreDocs = {};
  const fn = makeFn({
    existingUidByEmail: {},
    createUserImpl: async ({ email, emailVerified }) => {
      assert.equal(email, 'fresh@example.com');
      assert.equal(emailVerified, true);
      return { uid: 'uid_fresh' };
    },
    firestoreDocs,
  });
  const result = await fn('fresh@example.com', 'mylola-scorecard-write');
  assert.deepEqual(result, { uid: 'uid_fresh', provisioned: true });
  const written = firestoreDocs['users/uid_fresh'];
  assert.ok(written, 'expected a write to users/{uid}');
  assert.equal(written.plan, 'pro');
  assert.equal(written.subscriptionStatus, 'comp');
  assert.equal(written.provisionedVia, 'mylola-scorecard-write');
  assert.equal(written.email, 'fresh@example.com');
  assert.ok(written.createdAt, 'expected a createdAt stamp');
});

test('a concurrent create race resolves to the winner\'s uid instead of erroring', async () => {
  // Simulates real sequencing, not just a stubbed outcome: this call's OWN
  // first getUserByEmail must miss (nothing exists yet), THEN createUser
  // must lose the race, THEN the post-collision getUserByEmail must hit (the
  // winner's create landed in between). A getUserByEmail that just always
  // resolves would return from the function's first try block and never
  // reach the collision handling at all -- that would test nothing.
  let getUserByEmailCalls = 0;
  const admin = {
    auth: () => ({
      getUserByEmail: async () => {
        getUserByEmailCalls++;
        if (getUserByEmailCalls === 1) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
        return { uid: 'uid_winner' };
      },
      createUser: async () => { const e = new Error('races'); e.code = 'auth/email-already-exists'; throw e; },
    }),
    firestore: () => ({ doc: () => ({ set: async () => { throw new Error('must not write -- lost the race'); } }) }),
  };
  const SWH_COMP_PLAN_FIELDS = { plan: 'pro', subscriptionStatus: 'comp' };
  const raced = new Function(
    'admin', 'SWH_COMP_PLAN_FIELDS', 'console',
    `return async (email, via) => {${bodySrc}}`,
  )(admin, SWH_COMP_PLAN_FIELDS, console);
  const result = await raced('contested@example.com', 'mylola-scorecard-read');
  assert.deepEqual(result, { uid: 'uid_winner', provisioned: false }, 'the loser must resolve the winner\'s uid, not error or double-create');
  assert.equal(getUserByEmailCalls, 2, 'expected exactly the pre-create miss and the post-collision resolve');
});

test('a non-collision createUser failure propagates rather than being swallowed', async () => {
  const fn = makeFn({
    existingUidByEmail: {},
    createUserImpl: async () => { throw new Error('quota exceeded'); },
    firestoreDocs: {},
  });
  await assert.rejects(() => fn('fresh@example.com', 'mylola-scorecard-read'), /quota exceeded/);
});
