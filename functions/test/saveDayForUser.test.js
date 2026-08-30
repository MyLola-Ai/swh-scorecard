// saveDayForUser -- extraction test. Pulls the real handler body out of the
// shipped functions/index.js via string markers (not a reimplementation) and
// runs it against a fake admin.firestore()/admin.auth(), covering the
// requirements from docs/swh-write-bridge-spec.md (loaniq repo): catalog-index
// resolution (Change 3), unknown-activity rejection, fail-closed paywall,
// source-namespaced accumulation, and clientEventId idempotency.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function extractBetween(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, 'start marker not found: ' + startMarker);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, 'end marker not found: ' + endMarker);
  return src.slice(start, end);
}

// Pull the real SCORECARD_DEFAULT_ACTIVITIES array verbatim so the test's
// "unknown activity" case is real, not guessed.
const catalogSrc = extractBetween(
  'const SCORECARD_DEFAULT_ACTIVITIES = [',
  '];'
) + '];';
const SCORECARD_DEFAULT_ACTIVITIES = new Function(catalogSrc + '\nreturn SCORECARD_DEFAULT_ACTIVITIES;')();

const startMarker = 'exports.saveDayForUser = onRequest(\n  { cors: true, secrets: [MYLOLA_INTEGRATION_SECRET] },\n  async (req, res) => {';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'start marker not found');
const endMarker = '\n  }\n);';
const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
assert.ok(endIdx !== -1, 'end marker not found');
// Body only -- excludes the "exports.saveDayForUser = onRequest(..., async
// (req, res) => {" wrapper AND its closing "}", since the test's own wrapper
// template below supplies both the opening and closing brace.
const handlerOnlySrc = src.slice(startIdx + startMarker.length, endIdx);

function makeHandler({ users, days, activitiesDocs, secretValue, mylolaLinked }) {
  const admin = {
    auth: () => ({
      getUserByEmail: async (email) => {
        const uid = Object.keys(users).find(u => users[u].email === email);
        if (!uid) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
        return { uid };
      },
    }),
    firestore: () => ({
      doc: (p) => {
        const m = p.match(/^users\/([^/]+)$/);
        if (m) {
          const uid = m[1];
          return {
            get: async () => ({ exists: !!users[uid], data: () => users[uid] }),
          };
        }
        const m2 = p.match(/^users\/([^/]+)\/config\/activities$/);
        if (m2) {
          const uid = m2[1];
          const list = activitiesDocs[uid];
          return { get: async () => ({ exists: !!list, data: () => ({ list }) }) };
        }
        throw new Error('unexpected doc path: ' + p);
      },
    }),
  };
  const userRefFor = (uid) => ({
    get: async () => ({ exists: !!users[uid], data: () => users[uid] }),
    collection: (name) => {
      assert.equal(name, 'days');
      return {
        doc: (dateKey) => ({
          get: async () => {
            const d = (days[uid] || {})[dateKey];
            return { exists: !!d, data: () => d };
          },
          set: async (data, opts) => {
            days[uid] = days[uid] || {};
            if (opts && opts.merge) days[uid][dateKey] = { ...(days[uid][dateKey] || {}), ...data };
            else days[uid][dateKey] = data;
          },
        }),
      };
    },
  });
  // admin.firestore().doc(`users/${uid}`) is called both directly (for the
  // top-level userRef pattern) and needs .collection() too -- patch it in.
  const realDoc = admin.firestore().doc;
  admin.firestore = () => ({
    doc: (p) => {
      const m = p.match(/^users\/([^/]+)$/);
      if (m) return userRefFor(m[1]);
      const m2 = p.match(/^users\/([^/]+)\/config\/activities$/);
      if (m2) {
        const list = activitiesDocs[m2[1]];
        return { get: async () => ({ exists: !!list, data: () => ({ list }) }) };
      }
      throw new Error('unexpected doc path: ' + p);
    },
  });

  const MYLOLA_INTEGRATION_SECRET = { value: () => secretValue };
  const resolveEffectivePlan = async (uid, userData) => userData.plan || 'free';
  // hasLinkedMyLolaAccount never throws in the real implementation (it has
  // its own internal try/catch) -- the fake mirrors that contract rather
  // than a scenario that can't happen.
  const hasLinkedMyLolaAccount = async () => !!mylolaLinked;

  const fakeReq = { method: 'POST', headers: {}, body: {} };
  let statusCode = 200, jsonBody = null;
  const fakeRes = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
    send() { return this; },
  };

  const onRequest = (_opts, fn) => fn;
  const runner = new Function(
    'admin', 'MYLOLA_INTEGRATION_SECRET', 'resolveEffectivePlan', 'hasLinkedMyLolaAccount', 'SCORECARD_DEFAULT_ACTIVITIES', 'onRequest', 'console',
    `const handler = onRequest({}, async (req, res) => {${handlerOnlySrc}});\nreturn handler;`
  )(admin, MYLOLA_INTEGRATION_SECRET, resolveEffectivePlan, hasLinkedMyLolaAccount, SCORECARD_DEFAULT_ACTIVITIES, onRequest, console);

  return async (body, headers) => {
    fakeReq.body = body;
    fakeReq.headers = headers || { authorization: 'Bearer ' + secretValue };
    statusCode = 200; jsonBody = null;
    await runner(fakeReq, fakeRes);
    return { status: statusCode, body: jsonBody };
  };
}

test('rejects a bad bearer token', async () => {
  const call = makeHandler({ users: {}, days: {}, activitiesDocs: {}, secretValue: 'real-secret' });
  const r = await call({ subjectEmail: 'a@b.com', dateKey: '2026-08-29', entries: [{ name: 'x', count: 1 }], source: 'mylola' }, { authorization: 'Bearer wrong' });
  assert.equal(r.status, 401);
});

test('unknown email returns found:false, not an error', async () => {
  const call = makeHandler({ users: {}, days: {}, activitiesDocs: {}, secretValue: 's' });
  const r = await call({ subjectEmail: 'nobody@example.com', dateKey: '2026-08-29', entries: [{ name: 'x', count: 1 }], source: 'mylola' });
  assert.equal(r.status, 200);
  assert.equal(r.body.found, false);
});

test('free plan is paywalled (402), never silently accepted', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'free' } };
  const call = makeHandler({ users, days: {}, activitiesDocs: {}, secretValue: 's' });
  const r = await call({ subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Attend 1:1, Coffee, Lunch', count: 1 }], source: 'mylola' });
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'PAYWALL');
});

// Austen's ruling, 2026-08-30: a linked MyLola account is entitled here
// regardless of SWH plan -- the exact case MyLola LO flagged, a paying
// MyLola customer stuck behind SWH's own free-tier paywall.
test('a free SWH plan does NOT paywall a linked MyLola account', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'free' } };
  const call = makeHandler({ users, days: {}, activitiesDocs: {}, secretValue: 's', mylolaLinked: true });
  const r = await call({ subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Attend 1:1, Coffee, Lunch', count: 1 }], source: 'mylola' });
  assert.equal(r.status, 200);
});

test('an unlinked free SWH plan is still paywalled -- the ruling does not grant this to everyone', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'free' } };
  const call = makeHandler({ users, days: {}, activitiesDocs: {}, secretValue: 's', mylolaLinked: false });
  const r = await call({ subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Attend 1:1, Coffee, Lunch', count: 1 }], source: 'mylola' });
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'PAYWALL');
});

test('unknown activity name is rejected outright, not scored as zero', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'pro' } };
  const call = makeHandler({ users, days: {}, activitiesDocs: {}, secretValue: 's' });
  const r = await call({ subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Nonexistent Activity', count: 1 }], source: 'mylola' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unknown_activities');
  assert.deepEqual(r.body.activities, ['Nonexistent Activity']);
});

test('writes BOTH counts (index-keyed) and breakdown (name-keyed) on a fresh day -- the core Change 3 requirement', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'pro' } };
  const days = {};
  const call = makeHandler({ users, days, activitiesDocs: {}, secretValue: 's' });
  const coffeeIdx = SCORECARD_DEFAULT_ACTIVITIES.findIndex(a => a.name === 'Attend 1:1, Coffee, Lunch');
  const r = await call({ subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Attend 1:1, Coffee, Lunch', count: 1 }], source: 'mylola' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const saved = days.u1['2026-08-29'];
  assert.equal(saved.counts[coffeeIdx], 1, 'counts must be keyed by the real catalog index, not by name');
  assert.equal(saved.breakdown['Attend 1:1, Coffee, Lunch'].count, 1);
  assert.equal(saved.breakdown['Attend 1:1, Coffee, Lunch'].pts, 10);
  assert.equal(saved.totalPts, 10);
  assert.equal(saved.leadPts, 10);
  assert.equal(r.body.dayTotals.totalPts, 10);
});

test('a MyLola write does not clobber an existing SWH-native breakdown entry for the same activity/day -- adds alongside it', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'pro' } };
  const coffeeIdx = SCORECARD_DEFAULT_ACTIVITIES.findIndex(a => a.name === 'Attend 1:1, Coffee, Lunch');
  const days = { u1: { '2026-08-29': {
    counts: { [coffeeIdx]: 1 },
    breakdown: { 'Attend 1:1, Coffee, Lunch': { count: 1, pts: 10, icon: '☕', category: 'High-Value Meetings', lead: true } },
    totalPts: 10, leadPts: 10, lagPts: 0,
  } } };
  const call = makeHandler({ users, days, activitiesDocs: {}, secretValue: 's' });
  const r = await call({ subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Attend 1:1, Coffee, Lunch', count: 1 }], source: 'mylola' });
  assert.equal(r.status, 200);
  const saved = days.u1['2026-08-29'];
  assert.equal(saved.counts[coffeeIdx], 2, 'the pre-existing SWH-logged count must survive, not be replaced');
  assert.equal(saved.breakdown['Attend 1:1, Coffee, Lunch'].count, 2);
  assert.equal(saved.breakdown['Attend 1:1, Coffee, Lunch'].pts, 20);
});

test('a repeated clientEventId is skipped, not re-applied -- the double-tap guard', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'pro' } };
  const days = {};
  const call = makeHandler({ users, days, activitiesDocs: {}, secretValue: 's' });
  const body = { subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Attend 1:1, Coffee, Lunch', count: 1 }], source: 'mylola', clientEventId: 'evt-1' };
  const r1 = await call(body);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.skippedDuplicate, false);
  const r2 = await call(body); // exact same event, e.g. a network retry
  assert.equal(r2.status, 200);
  assert.equal(r2.body.skippedDuplicate, true);
  const coffeeIdx = SCORECARD_DEFAULT_ACTIVITIES.findIndex(a => a.name === 'Attend 1:1, Coffee, Lunch');
  assert.equal(days.u1['2026-08-29'].counts[coffeeIdx], 1, 'the retry must not double the count');
});

test('two DIFFERENT clientEventIds for the same activity both apply -- genuinely separate events accumulate', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'pro' } };
  const days = {};
  const call = makeHandler({ users, days, activitiesDocs: {}, secretValue: 's' });
  await call({ subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Attend 1:1, Coffee, Lunch', count: 1 }], source: 'mylola', clientEventId: 'evt-1' });
  await call({ subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Attend 1:1, Coffee, Lunch', count: 1 }], source: 'mylola', clientEventId: 'evt-2' });
  const coffeeIdx = SCORECARD_DEFAULT_ACTIVITIES.findIndex(a => a.name === 'Attend 1:1, Coffee, Lunch');
  assert.equal(days.u1['2026-08-29'].counts[coffeeIdx], 2);
});

test('resolves indices against a custom per-user catalog, not just the default', async () => {
  const users = { u1: { email: 'lo@example.com', plan: 'pro' } };
  const customCatalog = [
    { name: 'Custom Thing A', pts: 3, icon: '🅰️', cat: 'Custom' },
    { name: 'Custom Thing B', pts: 7, icon: '🅱️', cat: 'Custom' },
  ];
  const days = {};
  const call = makeHandler({ users, days, activitiesDocs: { u1: customCatalog }, secretValue: 's' });
  const r = await call({ subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Custom Thing B', count: 2 }], source: 'mylola' });
  assert.equal(r.status, 200);
  assert.equal(days.u1['2026-08-29'].counts[1], 2, 'must resolve against index 1 in the custom catalog, not the default array');
  assert.equal(days.u1['2026-08-29'].breakdown['Custom Thing B'].pts, 14);
});

test('plan-lookup failure fails CLOSED (402), not open -- the deliberate divergence from saveDay', async () => {
  const users = { u1: { email: 'lo@example.com', get plan() { throw new Error('boom'); } } };
  const call = makeHandler({ users, days: {}, activitiesDocs: {}, secretValue: 's' });
  const r = await call({ subjectEmail: 'lo@example.com', dateKey: '2026-08-29', entries: [{ name: 'Attend 1:1, Coffee, Lunch', count: 1 }], source: 'mylola' });
  assert.equal(r.status, 402, 'a plan-resolution error must deny, never silently grant a paid capability');
});
