// getScorecardForUser -- extraction test for weeklyGoal + canLog.
//
// WHY THIS EXISTS: on 2026-08-29 `weeklyGoal` was read from the USER document
// (`userData.weeklyGoal`) while the only writer, saveSettings, puts it in
// `users/{uid}/config/settings`. The endpoint therefore returned the 150
// default for EVERY user, including those who had deliberately set a goal.
// Nothing threw and 150 is plausible, so it was invisible -- and the full
// 90-test suite passed with the bug in place, because nothing exercised the
// field. MyLola consumes this value to draw a weekly streak, so a silent
// default binds a user-facing streak to a constant.
//
// The first assertion below is the one that matters: a user whose goal is set
// ONLY in config/settings (which is the only place it is ever written) must
// get that value back, not the default.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

const startMarker = 'exports.getScorecardForUser = onRequest(';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'getScorecardForUser not found');
const bodyStart = src.indexOf('async (req, res) => {', startIdx);
assert.ok(bodyStart !== -1, 'handler arrow not found');
const openBrace = bodyStart + 'async (req, res) => {'.length;
const endIdx = src.indexOf('\n  }\n);', openBrace);
assert.ok(endIdx !== -1, 'handler end not found');
const handlerOnlySrc = src.slice(openBrace, endIdx);

function makeHandler({ userDoc, settingsDoc, activitiesList, plan, planThrows, secretValue, mylolaLinked }) {
  const admin = {
    auth: () => ({
      getUserByEmail: async () => ({ uid: 'u1' }),
    }),
    firestore: () => ({
      doc: (p) => {
        if (/^users\/[^/]+$/.test(p)) {
          return { get: async () => ({ exists: !!userDoc, data: () => userDoc }) };
        }
        if (/^users\/[^/]+\/config\/activities$/.test(p)) {
          return { get: async () => ({ exists: !!activitiesList, data: () => ({ list: activitiesList }) }) };
        }
        if (/^users\/[^/]+\/config\/settings$/.test(p)) {
          return { get: async () => ({ exists: !!settingsDoc, data: () => settingsDoc }) };
        }
        throw new Error('unexpected doc path: ' + p);
      },
      collection: () => ({
        where: function () { return this; },
        get: async () => ({ docs: [] }),
      }),
    }),
  };

  const MYLOLA_INTEGRATION_SECRET = { value: () => secretValue };
  const resolveEffectivePlan = async () => {
    if (planThrows) throw new Error('billing lookup exploded');
    return plan || 'free';
  };
  const chicagoTodayKey = () => '2026-08-29';
  const SCORECARD_READ_MAX_DAYS = 90;
  const SCORECARD_STREAK_LOOKBACK_DAYS = 180;
  // Not under test here (see getScorecardForUser.test.js's weeklyStreak/tier
  // cases) -- the mocked collection() call always returns empty docs, so
  // these fakes just satisfy the references with the real, cheap-to-mirror
  // logic rather than stubbing them to constants that could mask a real
  // reference error elsewhere in the handler.
  const calcWeeklyStreakServer = () => 0;
  const getWeekStart = (dateKey, wsd) => {
    const DAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const startIdx = DAY_INDEX[(wsd || 'monday').toLowerCase()] ?? 1;
    const d = new Date(dateKey + 'T12:00:00');
    let diff = d.getDay() - startIdx;
    if (diff < 0) diff += 7;
    d.setDate(d.getDate() - diff);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const getTier = () => ({ name: 'Getting Started', emoji: '🟢', color: '#16A34A', msg: 'x' });
  const getNextTierServer = () => null;
  const SCORECARD_DEFAULT_ACTIVITIES = [{ cat: 'Networking', name: 'Coffee', pts: 5 }];
  // Never throws in the real implementation (own internal try/catch) -- the
  // fake mirrors that contract rather than a scenario that can't happen.
  const hasLinkedMyLolaAccount = async () => !!mylolaLinked;
  // This file's userDoc is always present (uid 'u1') -- provisioning's
  // "not found" branch isn't what these tests are about, so the fake just
  // mirrors the fixed-uid lookup it replaced.
  const getOrProvisionSwhUser = async () => ({ uid: 'u1', provisioned: false });

  let statusCode = 200, jsonBody = null;
  const fakeRes = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  const fn = new Function(
    'admin', 'MYLOLA_INTEGRATION_SECRET', 'resolveEffectivePlan', 'hasLinkedMyLolaAccount', 'getOrProvisionSwhUser', 'chicagoTodayKey',
    'SCORECARD_READ_MAX_DAYS', 'SCORECARD_STREAK_LOOKBACK_DAYS', 'calcWeeklyStreakServer', 'getWeekStart', 'getTier', 'getNextTierServer', 'SCORECARD_DEFAULT_ACTIVITIES',
    `return async (req, res) => {${handlerOnlySrc}}`,
  )(admin, MYLOLA_INTEGRATION_SECRET, resolveEffectivePlan, hasLinkedMyLolaAccount, getOrProvisionSwhUser, chicagoTodayKey,
    SCORECARD_READ_MAX_DAYS, SCORECARD_STREAK_LOOKBACK_DAYS, calcWeeklyStreakServer, getWeekStart, getTier, getNextTierServer, SCORECARD_DEFAULT_ACTIVITIES);

  return async (body) => {
    await fn({ method: 'POST', headers: { authorization: 'Bearer ' + secretValue }, body }, fakeRes);
    return { statusCode, body: jsonBody };
  };
}

const BASE = { activitiesList: null, plan: 'pro', secretValue: 's3cret' };

test('weeklyGoal comes from config/settings, the only place it is ever written', async () => {
  const call = makeHandler({ ...BASE, userDoc: { plan: 'pro' }, settingsDoc: { weeklyGoal: 300 } });
  const { body } = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(body.found, true);
  // Reading userData.weeklyGoal instead would silently yield 150 here.
  assert.equal(body.weeklyGoal, 300, 'must read the user\'s real goal, not the default');
});

test('a weeklyGoal on the USER doc is NOT the source (it is never written there)', async () => {
  const call = makeHandler({ ...BASE, userDoc: { plan: 'pro', weeklyGoal: 999 }, settingsDoc: {} });
  const { body } = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(body.weeklyGoal, 150, 'a stray value on the user doc must not be trusted');
});

test('weeklyGoal falls back to 150 when unset', async () => {
  const call = makeHandler({ ...BASE, userDoc: { plan: 'pro' }, settingsDoc: {} });
  const { body } = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(body.weeklyGoal, 150);
});

test('canLog is true for a paid plan, false for free', async () => {
  const paid = makeHandler({ ...BASE, userDoc: { plan: 'pro' }, settingsDoc: {}, plan: 'pro' });
  assert.equal((await paid({ subjectEmail: 'a@b.c' })).body.canLog, true);
  const free = makeHandler({ ...BASE, userDoc: { plan: 'free' }, settingsDoc: {}, plan: 'free' });
  assert.equal((await free({ subjectEmail: 'a@b.c' })).body.canLog, false);
});

// Austen's ruling, 2026-08-30: a linked MyLola account is entitled
// regardless of SWH plan.
test('canLog is true on a free SWH plan when the account is linked to MyLola', async () => {
  const call = makeHandler({ ...BASE, userDoc: { plan: 'free' }, settingsDoc: {}, plan: 'free', mylolaLinked: true });
  assert.equal((await call({ subjectEmail: 'a@b.c' })).body.canLog, true);
});

test('a billing-lookup failure yields canLog:false and STILL RETURNS THE SCORECARD', async () => {
  // The regression this guards: an unguarded await here sits inside the outer
  // try whose catch returns 500, so a transient billing fault would hide the
  // user's entire scorecard behind "could not load".
  const call = makeHandler({ ...BASE, userDoc: { plan: 'pro' }, settingsDoc: { weeklyGoal: 200 }, planThrows: true });
  const { statusCode, body } = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(statusCode, 200, 'the read must survive a plan-lookup failure');
  assert.equal(body.found, true);
  assert.equal(body.canLog, false, 'fail closed on the capability');
  assert.equal(body.weeklyGoal, 200, 'the rest of the payload is unaffected');
});
