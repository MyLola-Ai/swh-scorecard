// mintSwhSessionForUser — the SSO endpoint for MyClosings' launch-into-SWH
// flow (2026-08-06). Sibling of getScorecardForUser: same auth, same
// identity resolution, this one mints a custom token instead of reading
// data. Real handler invoked directly.
'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const mod = require('../index.js');
const { mintSwhSessionForUser, admin } = mod;

const SECRET = 'test-shared-secret';
process.env.MYLOLA_INTEGRATION_SECRET = SECRET;

function makeRes() {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(o) { this._json = o; this.emit('finish'); return this; },
    send(s) { this._sent = s; this.emit('finish'); return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
  });
}
function fakeReqRes(body, { auth = `Bearer ${SECRET}` } = {}) {
  const req = { method: 'POST', headers: { authorization: auth }, body };
  return { req, res: makeRes() };
}

function withFakeAuth({ users = {} }, run) {
  return async () => {
    const created = [];
    const mintedFor = [];
    const firestoreWrites = []; // { uid, data }
    const fakeAuth = {
      async getUserByEmail(email) {
        const uid = users[email];
        if (!uid) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
        return { uid };
      },
      async createUser({ email }) {
        const uid = 'new_' + email.replace(/[^a-z0-9]/gi, '_');
        created.push({ email, uid });
        users[email] = uid; // so a subsequent getUserByEmail in the same test would find it
        return { uid };
      },
      async createCustomToken(uid) {
        mintedFor.push(uid);
        return `fake-custom-token-for-${uid}`;
      },
    };
    const fakeFirestore = {
      doc(path) {
        const uid = path.split('/')[1];
        return {
          async set(data, opts) {
            firestoreWrites.push({ uid, data, opts });
          },
        };
      },
    };
    Object.defineProperty(admin, 'auth', { configurable: true, value: () => fakeAuth });
    Object.defineProperty(admin, 'firestore', { configurable: true, value: () => fakeFirestore });
    try {
      await run({ created, mintedFor, firestoreWrites });
    } finally {
      delete admin.auth;
      delete admin.firestore;
    }
  };
}

test('rejects a missing Authorization header', async () => {
  const { req, res } = fakeReqRes({ subjectEmail: 'a@b.com' }, { auth: '' });
  await mintSwhSessionForUser(req, res);
  assert.equal(res.statusCode, 401);
});

test('rejects the wrong secret', async () => {
  const { req, res } = fakeReqRes({ subjectEmail: 'a@b.com' }, { auth: 'Bearer wrong-value' });
  await mintSwhSessionForUser(req, res);
  assert.equal(res.statusCode, 401);
});

test('rejects a missing subjectEmail even with a valid secret', async () => {
  const { req, res } = fakeReqRes({});
  await mintSwhSessionForUser(req, res);
  assert.equal(res.statusCode, 400);
});

test('mints a token for an existing SWH account, provisioned:false', withFakeAuth(
  { users: { 'lo@example.com': 'uid_existing' } },
  async ({ created, mintedFor }) => {
    const { req, res } = fakeReqRes({ subjectEmail: 'LO@Example.com' }); // case-insensitivity check too
    await mintSwhSessionForUser(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._json.found, true);
    assert.equal(res._json.provisioned, false);
    assert.equal(res._json.customToken, 'fake-custom-token-for-uid_existing');
    assert.equal(created.length, 0, 'must not create a new account when one already exists');
    assert.deepEqual(mintedFor, ['uid_existing'], 'must mint for the resolved existing uid, not a new one');
  }
));

test('provisions a bare Auth user when none exists, provisioned:true, still mints a token', withFakeAuth(
  { users: {} },
  async ({ created, mintedFor, firestoreWrites }) => {
    const { req, res } = fakeReqRes({ subjectEmail: 'brandnew@example.com' });
    await mintSwhSessionForUser(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._json.found, true);
    assert.equal(res._json.provisioned, true);
    assert.ok(res._json.customToken, 'must still return a usable token for a freshly provisioned user');
    assert.equal(created.length, 1);
    assert.equal(created[0].email, 'brandnew@example.com');
    assert.deepEqual(mintedFor, [created[0].uid], 'must mint for the newly created uid');
  }
));

test('provisioning stamps full comped access, not the free/paywalled default', withFakeAuth(
  { users: {} },
  async ({ created, firestoreWrites }) => {
    const { req, res } = fakeReqRes({ subjectEmail: 'brandnew@example.com' });
    await mintSwhSessionForUser(req, res);
    assert.equal(firestoreWrites.length, 1, 'must write exactly one users/{uid} doc for a newly provisioned account');
    const write = firestoreWrites[0];
    assert.equal(write.uid, created[0].uid, 'must write to the newly created uid, not a stale one');
    assert.equal(write.data.plan, 'pro', 'must be the same plan value the real Stripe-upgrade path uses, so requirePaid() passes');
    assert.equal(write.data.subscriptionStatus, 'comp', 'must reuse the existing granted-not-paid marker (adminCompTeam), not invent a new one');
    assert.equal(write.data.email, 'brandnew@example.com');
    assert.equal(write.data.provisionedVia, 'myclosings');
    assert.ok(write.opts && write.opts.merge, 'must merge, never blind-overwrite');
  }
));

test('does NOT write a Firestore doc for an already-existing account -- provisioning is additive, never touches real users', withFakeAuth(
  { users: { 'lo@example.com': 'uid_existing' } },
  async ({ firestoreWrites }) => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await mintSwhSessionForUser(req, res);
    assert.equal(firestoreWrites.length, 0, 'an existing account\'s plan/entitlement must never be touched by this endpoint');
  }
));

// CTO, 2026-08-31: this endpoint is shared by both products (same
// MYLOLA_INTEGRATION_SECRET) but the request carried no caller marker, so
// EVERY caller -- MyLola included -- got the hardcoded 'myclosings' grant.
// A MyLola user minting a session here got the full paid CRM, silently,
// under the exact commit (1793947) titled to prevent that. Caught before
// deploy. These three tests are the wire contract: absent stays myclosings
// (MyClosings' Books tab won't send this field on day one -- flipping the
// default would silently downgrade it the moment this ships), a recognized
// MyLola marker grants scorecard, and an unrecognized value ALSO falls to
// scorecard but is never written raw into provisionedVia.
test('no via field (today\'s only caller) still provisions myclosings/pro -- the untouched default', withFakeAuth(
  { users: {} },
  async ({ firestoreWrites }) => {
    const { req, res } = fakeReqRes({ subjectEmail: 'stillmyclosings@example.com' });
    await mintSwhSessionForUser(req, res);
    assert.equal(firestoreWrites[0].data.plan, 'pro');
    assert.equal(firestoreWrites[0].data.provisionedVia, 'myclosings');
  }
));

// CTO, 2026-08-31: null is not undefined. A future MyClosings sender that
// explicitly passes `via: null` (rather than omitting the field) must not
// silently downgrade a paying customer to scorecard -- the exact failure
// the absent-default exists to prevent, just reached through a different
// falsy value. Harmless today only because MyClosings sends no field at
// all; guarding it now means step 3 can't reintroduce the problem step 1
// was built to avoid.
test('via: null is treated the same as an absent via, not as unrecognized', withFakeAuth(
  { users: {} },
  async ({ firestoreWrites }) => {
    const { req, res } = fakeReqRes({ subjectEmail: 'explicitnull@example.com', via: null });
    await mintSwhSessionForUser(req, res);
    assert.equal(firestoreWrites[0].data.plan, 'pro', 'null must not silently downgrade the way an unrecognized string does');
    assert.equal(firestoreWrites[0].data.provisionedVia, 'myclosings');
  }
));

test('via: "mylola" provisions scorecard, not pro -- the actual bug fix', withFakeAuth(
  { users: {} },
  async ({ firestoreWrites }) => {
    const { req, res } = fakeReqRes({ subjectEmail: 'mylolauser@example.com', via: 'mylola' });
    await mintSwhSessionForUser(req, res);
    assert.equal(firestoreWrites[0].data.plan, 'scorecard');
    assert.equal(firestoreWrites[0].data.provisionedVia, 'mylola-session-mint');
  }
));

test('an unrecognized via falls to the scorecard grant but is never written raw into provisionedVia', withFakeAuth(
  { users: {} },
  async ({ firestoreWrites }) => {
    const { req, res } = fakeReqRes({ subjectEmail: 'typo@example.com', via: 'mylola-typo-XYZ' });
    await mintSwhSessionForUser(req, res);
    assert.equal(firestoreWrites[0].data.plan, 'scorecard', 'a typo must fail toward the smaller grant, not the larger one');
    assert.notEqual(firestoreWrites[0].data.provisionedVia, 'mylola-typo-XYZ', 'must never persist an unvalidated caller-supplied string');
    assert.equal(firestoreWrites[0].data.provisionedVia, 'mint-unrecognized-via');
  }
));
