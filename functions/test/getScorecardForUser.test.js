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
  assert.equal(data.plan, 'scorecard', 'MyLola-originated provisioning grants scorecard, not the full CRM tier (Austen, 2026-08-31)');
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

// ── weeklyStreak (2026-08-31, MyLola LO) ───────────────────────────────────
// MyLola's own streak implementation disagreed with SWH's displayed number
// on the same account, same day, because it measured a different thing
// under the same name (points-goal weeks vs. calcWeeklyStreak's >=3-logged-
// days weeks) and, separately, could not have matched even with the right
// definition -- the cross-product read was clamped to 90 days while SWH's
// own streak looks back 180. These tests use real dates computed relative
// to whatever "today" actually is when the suite runs (chicagoTodayKey is
// the real function here, unmocked), so they hold regardless of run date.
// LOCAL date methods throughout (getDay/setDate/getFullYear), matching the
// real getWeekStart/fmtDate exactly -- both parse dateKey + 'T12:00:00' with
// NO timezone suffix, so the JS engine reads it as local time. Using UTC
// methods here instead would silently disagree with the real function on
// any machine whose local timezone isn't UTC (confirmed: this one is
// America/Chicago), producing an off-by-one that looks like a bug in the
// server code when it's actually a mismatch in the test's own date math.
function mondayOnOrBefore(d) {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  const out = new Date(d);
  out.setDate(out.getDate() - diff);
  return out;
}
function fmt(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function weeksAgoMonday(n) {
  const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 12);
  const thisMonday = mondayOnOrBefore(today);
  const target = new Date(thisMonday);
  target.setDate(target.getDate() - n * 7);
  return target;
}
// Builds `count` logged day-docs (totalPts > 0) inside the week starting at
// `weekStartDate`, on its first `count` days (Mon, Tue, ... as needed).
function loggedDaysInWeek(weekStartDate, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(weekStartDate);
    d.setDate(d.getDate() + i);
    out.push({ dateKey: fmt(d), counts: {}, totalPts: 5, leadPts: 5, lagPts: 0, breakdown: {} });
  }
  return out;
}

test('weeklyStreak: 3 consecutive qualifying weeks (most recent one still counts even with 0 days so far this week)', () => {
  // Anchored entirely on completed past weeks -- week 0 (current) is left
  // at 0 days on purpose, so this is safe to run on any day of the week,
  // including the first day of a week (real dates only: loggedDaysInWeek
  // can't honestly claim 3 already-logged days in a week that has not yet
  // had 3 days happen). The algorithm doesn't special-case "current" vs
  // "past" week -- it's the same >=3 check either way -- so a fully-past
  // qualifying week exercises the identical code path as an in-progress
  // one that's already cleared 3.
  const dayDocsList = [
    ...loggedDaysInWeek(weeksAgoMonday(1), 4),
    ...loggedDaysInWeek(weeksAgoMonday(2), 3),
    ...loggedDaysInWeek(weeksAgoMonday(3), 3),
    ...loggedDaysInWeek(weeksAgoMonday(4), 1), // breaks the streak here
  ];
  return withFakes(
    { users: { 'lo@example.com': 'uid_streak1' }, dayDocs: { 'users/uid_streak1/days': dayDocsList } },
    async () => {
      const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
      await getScorecardForUser(req, res);
      assert.equal(res._json.weeklyStreak, 3);
    }
  )();
});

test('weeklyStreak: current week in progress (only 1 day so far) does not break the streak -- counts from last week', () => {
  const dayDocsList = [
    ...loggedDaysInWeek(weeksAgoMonday(0), 1), // in progress, not yet >=3
    ...loggedDaysInWeek(weeksAgoMonday(1), 3),
    ...loggedDaysInWeek(weeksAgoMonday(2), 3),
  ];
  return withFakes(
    { users: { 'lo@example.com': 'uid_streak2' }, dayDocs: { 'users/uid_streak2/days': dayDocsList } },
    async () => {
      const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
      await getScorecardForUser(req, res);
      assert.equal(res._json.weeklyStreak, 2, 'the in-progress current week must not zero out the streak from the two completed weeks before it');
    }
  )();
});

test('weeklyStreak: a zero-point day does not count as logged', () => {
  const wk = weeksAgoMonday(0);
  const thirdDay = new Date(wk);
  thirdDay.setDate(thirdDay.getDate() + 2);
  const dayDocsList = [
    ...loggedDaysInWeek(wk, 2), // two real logged days (Mon, Tue)
    { dateKey: fmt(thirdDay), counts: {}, totalPts: 0, leadPts: 0, lagPts: 0, breakdown: {} }, // has a doc, but totalPts:0 -- not "logged"
  ];
  return withFakes(
    { users: { 'lo@example.com': 'uid_streak3' }, dayDocs: { 'users/uid_streak3/days': dayDocsList } },
    async () => {
      const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
      await getScorecardForUser(req, res);
      assert.equal(res._json.weeklyStreak, 0, 'only 2 of the 3 day-docs are actually logged (totalPts>0), so this week never reached 3 and the streak is 0');
    }
  )();
});

test('weeklyStreak: unaffected by a caller-requested narrow days range -- the exact bug this field exists to fix', () => {
  // A streak long enough that it could NEVER fit inside a 90-day window --
  // 15 weeks is >= 105 days, matching the real screenshot discrepancy
  // MyLola LO described (15 vs 1). Starts at week 1, not week 0: the
  // current week can't honestly be given 3 already-logged days on any day
  // earlier than Wednesday (real dates only), so this is built entirely
  // from completed past weeks -- safe on any day of the week. Week 0
  // sits at 0 days, which the algorithm treats the same as "not yet
  // qualifying" and falls back to week 1, so the streak still comes out
  // to 15.
  const dayDocsList = [];
  for (let w = 1; w <= 15; w++) dayDocsList.push(...loggedDaysInWeek(weeksAgoMonday(w), 3));
  return withFakes(
    { users: { 'lo@example.com': 'uid_streak4' }, dayDocs: { 'users/uid_streak4/days': dayDocsList } },
    async () => {
      // Caller explicitly requests only the last 7 days for the `days` array
      // -- a real, legitimate ask for a short display window that must NOT
      // truncate the streak, which needs the full 180-day lookback regardless.
      // Computed the same way chicagoTodayKey() itself does (not plain
      // new Date(), and not UTC) -- the request is clamped server-side
      // against that exact value, so matching it here avoids an off-by-one
      // depending on what hour this test happens to run.
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const sevenDaysAgoDate = new Date();
      sevenDaysAgoDate.setDate(sevenDaysAgoDate.getDate() - 7);
      const sevenDaysAgo = sevenDaysAgoDate.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com', fromDateKey: sevenDaysAgo, toDateKey: today });
      await getScorecardForUser(req, res);
      assert.ok(res._json.days.length <= 8, 'the days array itself should honor the narrow requested range');
      assert.equal(res._json.weeklyStreak, 15, 'the streak must use its own fixed 180-day lookback, independent of whatever range was requested for days');
    }
  )();
});

test('weeklyStreak: zero history returns 0, not an error', withFakes(
  { users: { 'lo@example.com': 'uid_streak5' }, dayDocs: { 'users/uid_streak5/days': [] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._json.weeklyStreak, 0);
  }
));

// ── tier (2026-08-31, MyLola LO) ────────────────────────────────────────────
// Ported from public-scorecard/index.html exactly, not reimplemented from a
// description (see the tier block's own comment in index.js). Real getTier /
// getWeekStart / getNextTierServer run unmocked here, via the real handler --
// no hand-copied mirror of any of the three to fall out of sync, which is
// exactly the class of bug the weeklyStreak work above hit once already.
// One synthetic day-doc per test carries the whole week's totals; the
// qualifier sums breakdown counts across every matched day, so it doesn't
// matter whether a test spreads activity across multiple days or puts it
// all on one -- these put it on one for a smaller fixture.
function weekDay(weekStartDate, { leadPts = 0, lagPts = 0, breakdown = {}, categoryPts = {} } = {}) {
  return { dateKey: fmt(weekStartDate), counts: {}, totalPts: leadPts + lagPts, leadPts, lagPts, breakdown, categoryPts };
}
function act(count) { return { count, pts: 0, icon: '', category: 'Networking', lead: true }; }

test('tier reflects only the CURRENT week\'s lead points, not a prior week\'s', withFakes(
  {
    users: { 'lo@example.com': 'uid_tier1' },
    dayDocs: {
      'users/uid_tier1/days': [
        weekDay(weeksAgoMonday(1), { leadPts: 300 }), // prior week -- would be Master Networker if wrongly included
        weekDay(weeksAgoMonday(0), { leadPts: 60 }),  // this week -- Active Networker band (50-99)
      ],
    },
  },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    assert.equal(res._json.tier.pts, 60, 'tier.pts must be this week\'s lead points only');
    assert.equal(res._json.tier.name, 'Active Networker', 'a prior week\'s points must not leak into this week\'s tier');
  }
));

test('tier at the top band has no next tier to report', withFakes(
  { users: { 'lo@example.com': 'uid_tier2' }, dayDocs: { 'users/uid_tier2/days': [weekDay(weeksAgoMonday(0), { leadPts: 250 })] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const { tier } = res._json;
    assert.equal(tier.name, 'Master Networker');
    assert.equal(tier.nextName, null);
    assert.equal(tier.nextAt, null);
    assert.equal(tier.ptsToNext, null);
  }
));

test('nextName/nextAt/ptsToNext are correct mid-band', withFakes(
  { users: { 'lo@example.com': 'uid_tier3' }, dayDocs: { 'users/uid_tier3/days': [weekDay(weeksAgoMonday(0), { leadPts: 120 })] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const { tier } = res._json;
    assert.equal(tier.name, 'Consistent Connector');
    assert.equal(tier.nextName, 'Professional Networker');
    assert.equal(tier.nextAt, 150);
    assert.equal(tier.ptsToNext, 30);
  }
));

test('master qualifier: true when all four thresholds are met, split across both alternate activity names per bucket', withFakes(
  {
    users: { 'lo@example.com': 'uid_tier4' },
    dayDocs: {
      'users/uid_tier4/days': [weekDay(weeksAgoMonday(0), {
        leadPts: 200,
        breakdown: {
          'In-Person Meeting (coffee, lunch, etc.)': act(1),
          'Deeper Conversation (strategy, collaboration)': act(1), // 2 meetings total
          'Simple Follow Through (text, email)': act(4),
          'Personalized Follow Through (video, voice)': act(3),
          'Light Touch (comment, like, engagement)': act(3), // 10 follow-throughs total
          'Introduce Two People': act(1),
          'Strategic Introduction': act(1), // 2 intros total
        },
      })],
    },
  },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const { tier } = res._json;
    assert.equal(tier.qualified, true);
    assert.equal(tier.shortfall, null);
  }
));

test('master qualifier: false when short on exactly one bucket (intros), shortfall reports only the real gap', withFakes(
  {
    users: { 'lo@example.com': 'uid_tier5' },
    dayDocs: {
      'users/uid_tier5/days': [weekDay(weeksAgoMonday(0), {
        leadPts: 200,
        breakdown: {
          'In-Person Meeting (coffee, lunch, etc.)': act(2),
          'Simple Follow Through (text, email)': act(10),
          'Introduce Two People': act(1), // only 1 of the required 2
        },
      })],
    },
  },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const { tier } = res._json;
    assert.equal(tier.qualified, false);
    assert.ok(tier.shortfall, 'expected a shortfall at 200 lead points');
    assert.equal(tier.shortfall.intros, 1);
    assert.equal(tier.shortfall.meetings, 0, 'meetings already met -- must not report a false gap');
    assert.equal(tier.shortfall.followThroughs, 0, 'follow-throughs already met -- must not report a false gap');
  }
));

test('shortfall stays null below the 150-point warning threshold, even when not qualified', withFakes(
  { users: { 'lo@example.com': 'uid_tier6' }, dayDocs: { 'users/uid_tier6/days': [weekDay(weeksAgoMonday(0), { leadPts: 140 })] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const { tier } = res._json;
    assert.equal(tier.qualified, false);
    assert.equal(tier.shortfall, null, 'below 150 the client shows no warning at all -- shortfall must match that, not just "not qualified"');
  }
));

test('an activity name outside the exact qualifier catalog earns no credit toward any bucket', withFakes(
  {
    users: { 'lo@example.com': 'uid_tier7' },
    dayDocs: {
      'users/uid_tier7/days': [weekDay(weeksAgoMonday(0), {
        leadPts: 200,
        breakdown: { 'Some Legacy Activity Name': act(50) }, // high count, wrong name entirely
      })],
    },
  },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const { tier } = res._json;
    assert.equal(tier.qualified, false);
    assert.deepEqual(tier.shortfall, { meetings: 2, followThroughs: 10, intros: 2 }, 'zero credit from an unrecognized name -- the full requirement is still outstanding');
  }
));

// ===== categoryPts / growth / results / insights / coaching =====
// Built 2026-08-31 for MyLola's Scoreboard port (Austen: "Do this").
// insights/coaching were deliberately held until the category-name fix
// landed (public-scorecard/index.html: three lookups referencing names
// that don't exist in the real catalog, live for months as a silent 0
// across four duplicated blocks) -- these tests exist specifically to
// prove the FIXED names are what the server actually reads, not just that
// the endpoint returns something plausible.

test('categoryPts flows through to the days array unchanged', withFakes(
  { users: { 'lo@example.com': 'uid_cat1' }, dayDocs: { 'users/uid_cat1/days': [
    weekDay(weeksAgoMonday(0), { leadPts: 10, categoryPts: { 'Follow Through': 10 } }),
  ] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    assert.deepEqual(res._json.days[0].categoryPts, { 'Follow Through': 10 });
  }
));

test('a day with no categoryPts at all defaults to an empty object, not undefined', withFakes(
  { users: { 'lo@example.com': 'uid_cat2' }, dayDocs: { 'users/uid_cat2/days': [
    { dateKey: fmt(weeksAgoMonday(0)), counts: {}, totalPts: 5, leadPts: 5, lagPts: 0, breakdown: {} },
  ] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    assert.deepEqual(res._json.days[0].categoryPts, {});
  }
));

test('growth ratio uses the same fuzzy first-word match as renderGrowthCard, not a reimplementation', withFakes(
  { users: { 'lo@example.com': 'uid_growth1' }, dayDocs: { 'users/uid_growth1/days': [
    weekDay(weeksAgoMonday(0), { leadPts: 100, breakdown: { 'Speak or Present': { count: 1, pts: 20 } } }),
  ] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const { growth } = res._json;
    assert.equal(growth.ratio, 20, '20 growth pts / 100 total pts');
    assert.equal(growth.status, 'Healthy Growth');
    assert.equal(growth.color, '#5A8A6A');
  }
));

test('growth status buckets correctly at the Low Growth band', withFakes(
  { users: { 'lo@example.com': 'uid_growth2' }, dayDocs: { 'users/uid_growth2/days': [
    weekDay(weeksAgoMonday(0), { leadPts: 100, breakdown: { 'Speak or Present': { count: 1, pts: 8 } } }),
  ] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    assert.equal(res._json.growth.status, 'Low Growth');
  }
));

test('the high-activity-low-growth override message fires without changing the status bucket', withFakes(
  { users: { 'lo@example.com': 'uid_growth3' }, dayDocs: { 'users/uid_growth3/days': [
    weekDay(weeksAgoMonday(0), { leadPts: 150, breakdown: { 'Speak or Present': { count: 1, pts: 5 } } }),
  ] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const { growth } = res._json;
    assert.match(growth.msg, /producing, but not developing/);
    assert.equal(growth.status, 'No Growth', 'the override changes the message only, not the status bucket underneath it');
  }
));

test('results: opportunities come from the current week only, referrals from breakdown counts', withFakes(
  {
    users: { 'lo@example.com': 'uid_results1' },
    dayDocs: {
      'users/uid_results1/days': [
        weekDay(weeksAgoMonday(0), { leadPts: 50, breakdown: {
          'Give a Referral': { count: 2, pts: 0 },
          'Receive a Referral': { count: 1, pts: 0 },
        } }),
      ],
      'users/uid_results1/lag': [
        { dateKey: fmt(weeksAgoMonday(0)), opportunities: 3 },
        { dateKey: fmt(weeksAgoMonday(1)), opportunities: 100 }, // prior week -- must not count
      ],
    },
  },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    assert.deepEqual(res._json.results, { opportunities: 3, referralsGiven: 2, referralsReceived: 1 });
  }
));

test('insights: an empty week gets the single neutral placeholder, not a crash', withFakes(
  { users: { 'lo@example.com': 'uid_ins1' }, dayDocs: { 'users/uid_ins1/days': [] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    assert.deepEqual(res._json.insights, [{ icon: '👋', text: 'Start logging activities to unlock coaching insights.', type: 'neutral' }]);
  }
));

// The regression test that actually matters for the category-name fix:
// proves meetPct is reading 'High-Value Meetings' (the real catalog name),
// not the old 'High-Value Conversations' that always read 0.
test('insights: the meeting-activity strength branch reads the FIXED category name', withFakes(
  { users: { 'lo@example.com': 'uid_ins2' }, dayDocs: { 'users/uid_ins2/days': [
    weekDay(weeksAgoMonday(0), { leadPts: 80, categoryPts: { 'High-Value Meetings': 30, 'Follow Through': 10 } }),
  ] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const strength = res._json.insights.find(i => i.text.startsWith('Strength'));
    assert.match(strength.text, /High-value conversation activity is strong/, 'meetPct (30/40=75%) must clear the >25% threshold read from the real category name');
  }
));

// Same shape, proving the introPct (Referrals & Results) fix independently
// of the meetPct one above.
test('insights: the introduction recommendation reads the FIXED category name (Referrals & Results)', withFakes(
  {
    users: { 'lo@example.com': 'uid_ins3' },
    // The recommendation branch needs thisWeekDocs.length > 3. Four distinct
    // calendar dates this week can't be constructed safely on every day of
    // the week (see the Monday-only fixture bug fixed earlier tonight) --
    // four entries dated to the one date that's always safe (today) get the
    // same length without risking a future dateKey.
    dayDocs: { 'users/uid_ins3/days': Array.from({ length: 4 }, () =>
      weekDay(weeksAgoMonday(0), { leadPts: 20, categoryPts: { 'Referrals & Results': 1, 'Follow Through': 24 } })
    ) },
  },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const rec = res._json.insights.find(i => i.text.startsWith('Recommendation'));
    // introPct = 4/100 = 4%, under 5 -> the intro-recommendation branch
    assert.match(rec.text, /Look for 2–3 introductions/);
  }
));

test('coaching: strength is driven by LEAD points, not total -- the renderCoachingTab bug fixed alongside this port', withFakes(
  { users: { 'lo@example.com': 'uid_coach1' }, dayDocs: { 'users/uid_coach1/days': [
    weekDay(weeksAgoMonday(0), { leadPts: 60, lagPts: 150 }), // total=210 (would read Master); lead=60
  ] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const strength = res._json.coaching.find(c => c.label === 'Strength');
    assert.match(strength.text, /You showed up/, 'total (210) would read Master Networker level; lead (60) correctly falls to the lowest strength branch');
  }
));

test('coaching always includes the Identity card, toned separately from good/warn/neutral', withFakes(
  { users: { 'lo@example.com': 'uid_coach2' }, dayDocs: { 'users/uid_coach2/days': [
    weekDay(weeksAgoMonday(0), { leadPts: 10 }),
  ] } },
  async () => {
    const { req, res } = fakeReqRes({ subjectEmail: 'lo@example.com' });
    await getScorecardForUser(req, res);
    const identity = res._json.coaching.find(c => c.label === "This Week's Identity");
    assert.ok(identity);
    assert.equal(identity.tone, 'tier');
  }
));
