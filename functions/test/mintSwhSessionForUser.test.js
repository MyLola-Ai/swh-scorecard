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
    Object.defineProperty(admin, 'auth', { configurable: true, value: () => fakeAuth });
    try {
      await run({ created, mintedFor });
    } finally {
      delete admin.auth;
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
  async ({ created, mintedFor }) => {
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
