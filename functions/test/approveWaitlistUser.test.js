// approveWaitlistUser -- extraction test against the real shipped function.
// Security fix 2026-09-11 (adjacent to findings F1/F1b/F2/F3, Austen's call,
// not one of the four): approving a waitlist entry is Austen personally
// vouching for that exact address, so it now marks emailVerified:true --
// on first-touch create, AND on an existing-but-unverified account, so the
// outcome doesn't depend on whether the person signed up before being
// approved. Covers the admin gate (must not weaken it) and the rest of the
// function's existing behavior (plan tier, waitlist status, mail doc) so
// this change doesn't regress anything alongside it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const startMarker = "exports.approveWaitlistUser = onCall({ cors: true }, async (request) => {";
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'approveWaitlistUser not found');
const bodyStart = startIdx + startMarker.length;
const endIdx = src.indexOf('\n});', bodyStart);
assert.ok(endIdx !== -1, 'function end not found');
const bodySrc = src.slice(bodyStart, endIdx);

function makeFn({ authStore, waitlistDocs, mailDocs = [] }) {
  const ADMIN_EMAILS = ['austen@austensmith.com'];
  const authOps = { updateUserCalls: [], createUserCalls: [] };
  const admin = {
    auth: () => ({
      getUserByEmail: async (email) => {
        const found = authStore.find(u => u.email === email);
        if (!found) { const e = new Error('not found'); e.code = 'auth/user-not-found'; throw e; }
        return { ...found };
      },
      createUser: async ({ email, emailVerified }) => {
        authOps.createUserCalls.push({ email, emailVerified });
        const rec = { uid: 'new-' + (authStore.length + 1), email, emailVerified };
        authStore.push(rec);
        return { ...rec };
      },
      updateUser: async (uid, patch) => {
        authOps.updateUserCalls.push({ uid, patch });
        const rec = authStore.find(u => u.uid === uid);
        if (rec) Object.assign(rec, patch);
        return { ...rec };
      },
      generatePasswordResetLink: async (email) => `https://example.com/reset?email=${encodeURIComponent(email)}`,
    }),
  };
  const collections = { waitlist: waitlistDocs, users: {}, mail: null };
  const db = {
    collection: (name) => {
      if (name === 'mail') {
        return { add: async (doc) => { mailDocs.push(doc); } };
      }
      const store = collections[name];
      return {
        doc: (id) => ({
          get: async () => {
            const data = store[id];
            return { exists: !!data, data: () => ({ ...data }) };
          },
          set: async (data, opts) => {
            store[id] = (opts && opts.merge) ? { ...(store[id] || {}), ...data } : data;
          },
          update: async (data) => { store[id] = { ...(store[id] || {}), ...data }; },
        }),
      };
    },
  };
  const fn = new Function(
    'admin', 'db', 'ADMIN_EMAILS',
    `return async (request) => {${bodySrc}};`,
  )(admin, db, ADMIN_EMAILS);
  return { fn, authOps, authStore, collections };
}

function fakeRequest(callerEmail, data) {
  return { auth: callerEmail ? { token: { email: callerEmail } } : null, data };
}

test('non-admin caller is rejected (admin gate unaffected by this change)', async () => {
  const { fn } = makeFn({ authStore: [], waitlistDocs: { w1: { email: 'new@example.com' } } });
  await assert.rejects(
    () => fn(fakeRequest('notadmin@example.com', { waitlistDocId: 'w1' })),
    /admin only/,
  );
});

test('first-touch approval creates the account already emailVerified:true', async () => {
  const { fn, authOps, authStore } = makeFn({
    authStore: [],
    waitlistDocs: { w1: { email: 'fresh@example.com' } },
  });
  const result = await fn(fakeRequest('austen@austensmith.com', { waitlistDocId: 'w1', plan: 'scorecard' }));
  assert.equal(result.ok, true);
  assert.equal(authOps.createUserCalls.length, 1);
  assert.equal(authOps.createUserCalls[0].emailVerified, true, 'must not hardcode false for an address Austen just personally approved');
  const created = authStore.find(u => u.uid === result.uid);
  assert.equal(created.emailVerified, true);
});

test('approving an existing-but-unverified account flips it to verified too', async () => {
  const authStore = [{ uid: 'existing-1', email: 'already-signed-up@example.com', emailVerified: false }];
  const { fn, authOps } = makeFn({
    authStore,
    waitlistDocs: { w1: { email: 'already-signed-up@example.com' } },
  });
  const result = await fn(fakeRequest('austen@austensmith.com', { waitlistDocId: 'w1' }));
  assert.equal(result.uid, 'existing-1');
  assert.equal(authOps.updateUserCalls.length, 1, 'must update the existing record, not just the fresh-create path');
  assert.deepEqual(authOps.updateUserCalls[0], { uid: 'existing-1', patch: { emailVerified: true } });
  assert.equal(authStore[0].emailVerified, true);
});

test('an already-verified existing account is left alone (no redundant write)', async () => {
  const authStore = [{ uid: 'existing-2', email: 'already-verified@example.com', emailVerified: true }];
  const { fn, authOps } = makeFn({
    authStore,
    waitlistDocs: { w1: { email: 'already-verified@example.com' } },
  });
  await fn(fakeRequest('austen@austensmith.com', { waitlistDocId: 'w1' }));
  assert.equal(authOps.updateUserCalls.length, 0, 'no need to touch an account that is already verified');
});

test('regression: plan tier, waitlist status, and welcome email are unaffected by this change', async () => {
  const mailDocs = [];
  const { fn, collections } = makeFn({
    authStore: [],
    waitlistDocs: { w1: { email: 'pro-user@example.com' } },
    mailDocs,
  });
  const result = await fn(fakeRequest('austen@austensmith.com', { waitlistDocId: 'w1', plan: 'pro' }));
  assert.equal(result.plan, 'pro');
  assert.equal(collections.waitlist.w1.status, 'approved');
  assert.equal(collections.waitlist.w1.uid, result.uid);
  assert.equal(collections.users[result.uid].plan, 'pro');
  assert.equal(mailDocs.length, 1, 'expected the welcome email to still be queued');
  assert.deepEqual(mailDocs[0].to, ['pro-user@example.com']);
});

test('missing waitlist entry still errors clearly (unaffected baseline)', async () => {
  const { fn } = makeFn({ authStore: [], waitlistDocs: {} });
  await assert.rejects(
    () => fn(fakeRequest('austen@austensmith.com', { waitlistDocId: 'does-not-exist' })),
    /Waitlist entry not found/,
  );
});
