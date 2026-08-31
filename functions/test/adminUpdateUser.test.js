// adminUpdateUser -- the generic admin-only user-field patcher, same shape
// as the pre-existing adminUpdateTeam. Built 2026-08-31 for one field
// (morningQueueEnabled: Austen's manual, superadmin-controlled per-user
// Morning Queue rollout, ahead of any broader eligibility rule) but
// architected like adminUpdateTeam's own allowlist so more admin-settable
// user fields can be added here later without a new function each time.
//
// Deliberately an Admin SDK write, not a client updateDoc like setUserPlan
// in public-admin/index.html: morningQueueEnabled gates a feature, and
// firestore.rules' entitlementFieldsUpdate() allowlist exists specifically
// because a 2026-08-13 bug let a user grant themselves paid access by
// writing an unlisted field to their own doc via the client SDK. Routing
// this through a Cloud Function sidesteps needing a rules change entirely
// -- Admin SDK writes bypass rules, so the allowlist inside this function
// IS the only gate, and it must be real, tested, and not the raw patch
// object written straight through.
'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const mod = require('../index.js');
const { adminUpdateUser, admin } = mod;

function makeRes() {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(o) { this._json = o; this.emit('finish'); return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
  });
}
function fakeReqRes(body, { callerEmail = 'austen@austensmith.com' } = {}) {
  const req = { method: 'POST', headers: { authorization: 'Bearer faketoken' }, body, _callerEmail: callerEmail };
  return { req, res: makeRes() };
}

function withFakeAuth({ users = {} }, run) {
  return async () => {
    const firestoreWrites = []; // { uid, data, opts }
    let capturedCallerEmail = null;
    const fakeAuth = {
      async verifyIdToken(token) {
        // capturedCallerEmail is set per-request by the caller below, since
        // verifyIdToken itself only ever sees the opaque token string.
        return { email: capturedCallerEmail };
      },
      async getUser(uid) {
        const email = Object.keys(users).find((e) => users[e] === uid);
        if (!email) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
        return { uid, email };
      },
      async getUserByEmail(email) {
        const uid = users[email];
        if (!uid) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
        return { uid, email };
      },
    };
    const fakeFirestore = {
      collection(name) {
        assert.equal(name, 'users');
        return {
          doc(uid) {
            return {
              async set(data, opts) { firestoreWrites.push({ uid, data, opts }); },
            };
          },
        };
      },
    };
    Object.defineProperty(admin, 'auth', { configurable: true, value: () => fakeAuth });
    Object.defineProperty(admin, 'firestore', { configurable: true, value: () => fakeFirestore });
    const call = async (body, opts = {}) => {
      capturedCallerEmail = opts.callerEmail || 'austen@austensmith.com';
      const { req, res } = fakeReqRes(body, opts);
      await adminUpdateUser(req, res);
      return { statusCode: res.statusCode, body: res._json };
    };
    try {
      await run({ call, firestoreWrites });
    } finally {
      delete admin.auth;
      delete admin.firestore;
    }
  };
}

test('rejects a non-admin caller, even with a valid token', withFakeAuth(
  { users: { 'someone@example.com': 'uid_x' } },
  async ({ call, firestoreWrites }) => {
    const { statusCode } = await call({ uid: 'uid_x', patch: { morningQueueEnabled: true } }, { callerEmail: 'someone@example.com' });
    assert.equal(statusCode, 403);
    assert.equal(firestoreWrites.length, 0, 'a rejected caller must never reach the write');
  }
));

test('rejects a request with no email/uid or no patch', withFakeAuth(
  { users: {} },
  async ({ call }) => {
    assert.equal((await call({ patch: { morningQueueEnabled: true } })).statusCode, 400);
    assert.equal((await call({ uid: 'uid_x' })).statusCode, 400);
  }
));

test('an admin caller can set morningQueueEnabled true on a target user by uid', withFakeAuth(
  { users: { 'austen@austensmith.com': 'uid_admin', 'tony@example.com': 'uid_tony' } },
  async ({ call, firestoreWrites }) => {
    const { statusCode, body } = await call({ uid: 'uid_tony', patch: { morningQueueEnabled: true } });
    assert.equal(statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(firestoreWrites.length, 1);
    assert.equal(firestoreWrites[0].uid, 'uid_tony');
    assert.equal(firestoreWrites[0].data.morningQueueEnabled, true);
    assert.equal(firestoreWrites[0].data.updatedBy, 'austen@austensmith.com');
    assert.ok(firestoreWrites[0].opts && firestoreWrites[0].opts.merge, 'must merge, never blind-overwrite the rest of the user doc');
  }
));

test('resolves the target by email when uid is not given', withFakeAuth(
  { users: { 'austen@austensmith.com': 'uid_admin', 'tony@example.com': 'uid_tony' } },
  async ({ call, firestoreWrites }) => {
    await call({ email: 'tony@example.com', patch: { morningQueueEnabled: true } });
    assert.equal(firestoreWrites[0].uid, 'uid_tony');
  }
));

test('coerces a truthy-but-non-boolean value rather than writing it raw', withFakeAuth(
  { users: { 'austen@austensmith.com': 'uid_admin', 'tony@example.com': 'uid_tony' } },
  async ({ call, firestoreWrites }) => {
    await call({ uid: 'uid_tony', patch: { morningQueueEnabled: 'yes' } });
    assert.strictEqual(firestoreWrites[0].data.morningQueueEnabled, true, 'a truthy string must coerce to boolean true, not be persisted as the string itself');
  }
));

// The allowlist IS the security boundary here (Admin SDK bypasses
// firestore.rules entirely) -- this is the one test that must never be
// allowed to regress silently.
test('a field outside the allowlist is silently dropped, never written', withFakeAuth(
  { users: { 'austen@austensmith.com': 'uid_admin', 'tony@example.com': 'uid_tony' } },
  async ({ call, firestoreWrites }) => {
    const { statusCode, body } = await call({ uid: 'uid_tony', patch: { plan: 'pro', subscriptionStatus: 'comp' } });
    assert.equal(statusCode, 400, 'a patch with nothing recognized must fail rather than silently no-op');
    assert.equal(firestoreWrites.length, 0);
  }
));

test('an allowlisted field alongside a non-allowlisted one: only the allowlisted one is written', withFakeAuth(
  { users: { 'austen@austensmith.com': 'uid_admin', 'tony@example.com': 'uid_tony' } },
  async ({ call, firestoreWrites }) => {
    await call({ uid: 'uid_tony', patch: { morningQueueEnabled: true, plan: 'pro' } });
    assert.equal(firestoreWrites[0].data.morningQueueEnabled, true);
    assert.equal(firestoreWrites[0].data.plan, undefined, 'plan is not in this function\'s allowlist and must never be settable through it');
  }
));

test('an unresolvable target (no such auth user) is a 404, not a silent no-op', withFakeAuth(
  { users: { 'austen@austensmith.com': 'uid_admin' } },
  async ({ call, firestoreWrites }) => {
    const { statusCode } = await call({ email: 'ghost@example.com', patch: { morningQueueEnabled: true } });
    assert.equal(statusCode, 404);
    assert.equal(firestoreWrites.length, 0);
  }
));
