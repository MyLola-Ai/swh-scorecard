// getScorecardForUser -- extraction test for weekStartDay.
//
// WHY THIS EXISTS: MyLola draws its own weekly streak from this endpoint and
// needs to bucket days into weeks the same way SWH does for the same user.
// weekStartDay already exists as a per-user setting (saveSettings writes a
// lowercase day name to users/{uid}/config/settings; getWeekStart/getMe read
// it the same way), but getScorecardForUser never exposed it -- so MyLola's
// only option was to assume Monday, which silently disagrees with any user
// who set something else. Same shape as the weeklyGoal bug in this file:
// a real per-user value, sitting one field short of being readable.
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

function makeHandler({ userDoc, settingsDoc, activitiesList, plan, secretValue }) {
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
  const resolveEffectivePlan = async () => plan || 'free';
  const hasLinkedMyLolaAccount = async () => false;
  const getOrProvisionSwhUser = async () => ({ uid: 'u1', provisioned: false });
  const chicagoTodayKey = () => '2026-08-29';
  const SCORECARD_READ_MAX_DAYS = 90;
  const SCORECARD_STREAK_LOOKBACK_DAYS = 180;
  // Not under test here (see getScorecardForUser.weeklyStreak.test.js) --
  // the mocked collection() call always returns empty docs, so the real
  // function would return 0 anyway; this fake just satisfies the reference.
  const calcWeeklyStreakServer = () => 0;
  const SCORECARD_DEFAULT_ACTIVITIES = [{ cat: 'Networking', name: 'Coffee', pts: 5 }];

  let statusCode = 200, jsonBody = null;
  const fakeRes = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  const fn = new Function(
    'admin', 'MYLOLA_INTEGRATION_SECRET', 'resolveEffectivePlan', 'hasLinkedMyLolaAccount', 'getOrProvisionSwhUser', 'chicagoTodayKey',
    'SCORECARD_READ_MAX_DAYS', 'SCORECARD_STREAK_LOOKBACK_DAYS', 'calcWeeklyStreakServer', 'SCORECARD_DEFAULT_ACTIVITIES',
    `return async (req, res) => {${handlerOnlySrc}}`,
  )(admin, MYLOLA_INTEGRATION_SECRET, resolveEffectivePlan, hasLinkedMyLolaAccount, getOrProvisionSwhUser, chicagoTodayKey,
    SCORECARD_READ_MAX_DAYS, SCORECARD_STREAK_LOOKBACK_DAYS, calcWeeklyStreakServer, SCORECARD_DEFAULT_ACTIVITIES);

  return async (body) => {
    await fn({ method: 'POST', headers: { authorization: 'Bearer ' + secretValue }, body }, fakeRes);
    return { statusCode, body: jsonBody };
  };
}

const BASE = { activitiesList: null, plan: 'pro', secretValue: 's3cret', userDoc: { plan: 'pro' } };

test('weekStartDay comes from config/settings when the user has set one', async () => {
  const call = makeHandler({ ...BASE, settingsDoc: { weekStartDay: 'sunday' } });
  const { body } = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(body.found, true);
  assert.equal(body.weekStartDay, 'sunday');
});

test('weekStartDay defaults to monday when the settings doc exists but the field is unset', async () => {
  const call = makeHandler({ ...BASE, settingsDoc: { weeklyGoal: 300 } });
  const { body } = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(body.weekStartDay, 'monday');
});

test('weekStartDay defaults to monday when there is no settings doc at all', async () => {
  const call = makeHandler({ ...BASE, settingsDoc: null });
  const { body } = await call({ subjectEmail: 'lo@example.com' });
  assert.equal(body.weekStartDay, 'monday');
});
