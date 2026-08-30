// getScorecardForUser — the new loaniq-75a20 -> SWH read endpoint (MyClosings
// Scorecard display, 2026-08-06). Real handler invoked directly, not just its
// inner logic: auth (shared secret), identity resolution (email -> uid,
// found:false on no match), the activities-catalog fallback, and the
// server-side date-range clamp that's the one thing standing between this
// and an accidental unbounded export.
'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const mod = require('../index.js');
const { getScorecardForUser, admin } = mod;

const SECRET = 'test-shared-secret';
process.env.MYLOLA_INTEGRATION_SECRET = SECRET; // defineSecret(...).value() reads this in the emulator/test path

// ── Fake req/res for a Firebase v2 onRequest handler — same shape as
//    webhookHandlers.test.js's makeRes(): a real EventEmitter (the v2
//    wrapper listens for 'finish'), with json()/send() emitting it. ───────
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

// ── Fake Firestore: just enough for doc().get() and
//    collection().where().where().get(), chained ─────────────────────────
function makeFakeFirestore(seed) {
  const docs = seed.docs || {};       // 'users/uid/config/activities' -> {...}
  const dayDocs = seed.dayDocs || {}; // 'users/uid' -> [{dateKey, ...}, ...]
  return {
    doc(path) {
      return {
        async get() {
          const data = docs[path];
          return { exists: data !== undefined, data: () => data };
        },
        async set(data, opts) {
          docs[path] = (opts && opts.merge) ? { ...(docs[path] || {}), ...data } : data;
        },
      };
    },
    collection(path) {
      const filters = [];
      const api = {
        where(field, op, value) { filters.push({ field, op, value }); return api; },
        async get() {
          const uidPrefix = path; // 'users/{uid}/days'
          const rows = dayDocs[uidPrefix] || [];
          const matched = rows.filter((row) =>
            filters.every((f) => {
              if (f.op === '>=') return row[f.field] >= f.value;
              if (f.op === '<=') return row[f.field] <= f.value;
              return true;
            })
          );
          return { docs: matched.map((data) => ({ data: () => data })) };
        },
      };
      return api;
    },
  };
}

function withFakes({ users = {}, docs = {}, dayDocs = {} }, run) {
  return async () => {
    let nextProvisionedUid = 0;
    const fakeAuth = {
      async getUserByEmail(email) {
        const uid = users[email];
        if (!uid) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
        return { uid };
      },
      async createUser({ email }) {
        const uid = 'provisioned_' + (nextProvisionedUid++);
        users[email] = uid; // so a second lookup in the same test would resolve it too
        return { uid };
      },
    };
    // Both admin.auth and admin.firestore are inherited getter-only
    // accessors on the FirebaseNamespace prototype (same reason
    // webhookHandlers.test.js shadows admin.auth this way) -- a plain
    // assignment throws in strict mode; defineProperty shadows with an
    // own property, delete correctly reveals the real one afterward.
    Object.defineProperty(admin, 'auth', { configurable: true, value: () => fakeAuth });
    Object.defineProperty(admin, 'firestore', { configurable: true, value: () => makeFakeFirestore({ docs, dayDocs }) });
    try {
      await run();
    } finally {
      delete admin.auth;
      delete admin.firestore;
    }
  };
}

test('rejects a missing Authorization header', async () => {
  const { req, res } = fakeReqRes({ subjectEmail: 'a@b.com' }, { auth: '' });
  await getScorecardForUser(req, res);
  assert.equal(res.statusCode, 401);
});

test('rejects the wrong secret', async () => {
  const { req, res } = fakeReqRes({ subjectEmail: 'a@b.com' }, { auth: 'Bearer wrong-value' });
  await getScorecardForUser(req, res);
  assert.equal(res.statusCode, 401);
});

test('rejects a missing subjectEmail even with a valid secret', async () => {
  const { req, res } = fakeReqRes({});
  await getScorecardForUser(req, res);
  assert.equal(res.statusCode, 400);
});

// Austen's ruling, 2026-08-30: a MyLola user implies a comped SWH account.
// An unknown email is no longer "link your account" -- it's provisioned on
// the spot, via the same getOrProvisionSwhUser three endpoints share.
test('an unknown email is provisioned on the spot, not told to link an account', withFakes(
  { users: {} },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'nobody@example.com' });
    await getScorecardForUser(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._json.found, true, 'a fresh account must read as found, not found:false');
    assert.ok(res._json.activities.length > 0, 'a brand-new account still gets the default activities catalog');
    assert.deepEqual(res._json.days, [], 'no days logged yet');
  }
));

test('provisioning stamps the comped plan fields and attributes the trigger path', async () => {
  const docs = {};
  await withFakes({ users: {}, docs }, async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'fresh@example.com' });
    await getScorecardForUser(req, res);
    assert.equal(res.statusCode, 200);
  })();
  const written = Object.entries(docs).find(([path]) => /^users\/[^/]+$/.test(path));
  assert.ok(written, 'expected a write to the bare users/{uid} doc');
  const [, data] = written;
  assert.equal(data.plan, 'pro');
  assert.equal(data.subscriptionStatus, 'comp');
  assert.equal(data.provisionedVia, 'mylola-scorecard-read');
  assert.equal(data.email, 'fresh@example.com');
});

test('returns the matched user\'s own days and their custom activities list, not the default', withFakes(
  {
    users: { 'lo@example.com': 'uid_1' },
    docs: { 'users/uid_1/config/activities': { list: [{ name: 'Custom Activity', pts: 3 }] } },
    dayDocs: {
      'users/uid_1/days': [
        { dateKey: '2026-08-01', counts: { 0: 2 }, totalPts: 10, leadPts: 10, lagPts: 0, breakdown: { 'X': { count: 2, pts: 10 } } },
        { dateKey: '2026-08-02', counts: { 0: 1 }, totalPts: 5, leadPts: 5, lagPts: 0, breakdown: {} },
      ],
    },
  },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'LO@Example.com', fromDateKey: '2026-08-01', toDateKey: '2026-08-02' });
    await getScorecardForUser(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._json.found, true);
    assert.deepEqual(res._json.activities, [{ name: 'Custom Activity', pts: 3 }]);
    assert.equal(res._json.days.length, 2);
    assert.equal(res._json.days[0].dateKey, '2026-08-01');
    assert.equal(res._json.days[0].totalPts, 10);
    assert.equal(res._json.days[1].dateKey, '2026-08-02');
  }
));

test('falls back to the default activities list when the user has no config/activities doc', withFakes(
  {
    users: { 'lo@example.com': 'uid_2' },
    docs: {}, // no config/activities doc at all -- the common case
    dayDocs: { 'users/uid_2/days': [] },
  },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    assert.equal(res._json.found, true);
    assert.ok(res._json.activities.length > 0, 'should fall back to a non-empty default list');
    assert.ok(res._json.activities.some((a) => a.name === 'Call Someone from CRM'), 'default list should match the real DEFAULT_ACTS catalog');
  }
));

test('clamps an out-of-range fromDateKey to the max lookback window instead of returning everything', withFakes(
  {
    users: { 'lo@example.com': 'uid_3' },
    docs: {},
    dayDocs: {
      'users/uid_3/days': [
        { dateKey: '2020-01-01', counts: {}, totalPts: 999, leadPts: 999, lagPts: 0, breakdown: {} }, // way outside any real window
        { dateKey: '2026-08-01', counts: {}, totalPts: 5, leadPts: 5, lagPts: 0, breakdown: {} },
      ],
    },
  },
  async () => {
    // Ask for everything since 2000 -- the handler must clamp this itself,
    // not trust the caller's range.
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com', fromDateKey: '2000-01-01' });
    await getScorecardForUser(req, res);
    const keys = res._json.days.map((d) => d.dateKey);
    assert.ok(!keys.includes('2020-01-01'), 'the 2020 row is outside the 90-day clamp and must not be returned even though it was in range of the requested (unclamped) window');
  }
));
