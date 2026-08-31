// computeUserWeeklyStats -- extraction test for the lead-vs-total tier fix
// (MyLola LO / Austen, 2026-08-31: "fix the lead vs total tier mismatch").
// The Scoreboard has always driven its tier off LEAD points specifically
// (public-scorecard/index.html's own attributed comment: "driven by LEAD
// points (Danny's coaching: lead = future business)"); this function, which
// feeds the weekly recap email, used totalPts (lead+lag) instead -- so a
// user with lag points could see a HIGHER tier in their inbox than on the
// Scoreboard they check daily. Confirmed live on Austen's own account
// before this fix (774 lead vs 126 lag). Only the tier changes here --
// goalPct/goalHit legitimately stay on totalPts, since the weekly point
// GOAL is about total effort, not just lead.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const startMarker = 'async function computeUserWeeklyStats(uid) {';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'computeUserWeeklyStats not found');
const bodyStart = startIdx + startMarker.length;
const endIdx = src.indexOf('\n}', bodyStart);
assert.ok(endIdx !== -1, 'function end not found');
const bodySrc = src.slice(bodyStart, endIdx);

const DAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
function getWeekStart(dateKey, weekStartDay) {
  const startIdx = DAY_INDEX[(weekStartDay || 'monday').toLowerCase()] ?? 1;
  const d = new Date(dateKey + 'T12:00:00');
  let diff = d.getDay() - startIdx;
  if (diff < 0) diff += 7;
  d.setDate(d.getDate() - diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateKey, days) {
  const d = new Date(dateKey + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getTier(pts) {
  if (pts >= 200) return { name: 'Master Networker' };
  if (pts >= 150) return { name: 'Professional Networker' };
  if (pts >= 100) return { name: 'Consistent Connector' };
  if (pts >= 50) return { name: 'Active Networker' };
  return { name: 'Getting Started' };
}

function makeFn({ userDoc, settingsDoc, thisWeekDays }) {
  const db = {
    collection: (path) => {
      const m = path.match(/^users\/([^/]+)\/days$/);
      assert.ok(m || path === 'users', 'unexpected collection: ' + path);
      if (path === 'users') {
        return { doc: () => ({ get: async () => ({ exists: !!userDoc, data: () => userDoc }) }) };
      }
      const filters = [];
      const api = {
        where(field, op, value) { filters.push({ field, op, value }); return api; },
        get: async () => {
          const rows = (filters.length && filters[0].value <= (thisWeekDays[0] && thisWeekDays[0].dateKey))
            ? thisWeekDays
            : thisWeekDays; // single window in this test -- prior week is always empty via doc() below
          return { forEach: (fn) => rows.forEach((r) => fn({ data: () => r })) };
        },
      };
      return api;
    },
    doc: (path) => {
      if (/\/config\/settings$/.test(path)) return { get: async () => ({ exists: !!settingsDoc, data: () => settingsDoc }) };
      throw new Error('unexpected doc: ' + path);
    },
  };
  // Call order inside computeUserWeeklyStats is: (1) db.collection('users')
  // for the user doc, (2) db.collection(.../days) for THIS week (daysSnap),
  // (3) db.collection(.../days) for the PRIOR week (priorSnap). Only the
  // third call should come back empty -- the first days-query must return
  // the fixture, or daysLogged stays 0 and the function returns null before
  // ever computing a tier.
  let collectionCalls = 0;
  const realCollection = db.collection;
  db.collection = (path) => {
    collectionCalls++;
    if (collectionCalls === 3) {
      return { where: function () { return this; }, get: async () => ({ forEach: () => {} }) };
    }
    return realCollection(path);
  };
  // Coaching-copy generation is unrelated to the tier fix under test here --
  // stubbed the same way sibling extraction tests stub unrelated helpers
  // (see getScorecardForUser.weeklyGoal.test.js's calcWeeklyStreakServer).
  const buildCoachingBlocks = () => ({});
  const fn = new Function(
    'db', 'getWeekStart', 'addDays', 'getTier', 'DAY_SHORT', 'DAY_LONG', 'buildCoachingBlocks',
    `return async (uid) => {${bodySrc}}`,
  )(db, getWeekStart, addDays, getTier, ['SUN','MON','TUE','WED','THU','FRI','SAT'], ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], buildCoachingBlocks);
  return fn;
}

test('tier is driven by leadPts, not totalPts -- the exact mismatch this fix closes', async () => {
  // Matches the shape of the live discrepancy: high total (lead+lag) but
  // lead alone is in a LOWER tier band. totalPts would read Master
  // Networker (>=200); leadPts alone should read Active Networker (50-99).
  const fn = makeFn({
    userDoc: { email: 'lo@example.com' },
    settingsDoc: {},
    thisWeekDays: [
      { dateKey: '2026-08-24', totalPts: 220, leadPts: 70, lagPts: 150, breakdown: {}, categoryPts: {} },
    ],
  });
  const stats = await fn('u1');
  assert.ok(stats, 'expected non-null stats for a week with logged activity');
  assert.equal(stats.totalPts, 220);
  assert.equal(stats.leadPts, 70);
  assert.equal(stats.tier.name, 'Active Networker', 'tier must reflect leadPts (70), not totalPts (220)');
});

test('goalPct/goalHit stay on totalPts -- only the tier changes', async () => {
  const fn = makeFn({
    userDoc: { email: 'lo@example.com' },
    settingsDoc: { weeklyGoal: 100 },
    thisWeekDays: [
      { dateKey: '2026-08-24', totalPts: 220, leadPts: 70, lagPts: 150, breakdown: {}, categoryPts: {} },
    ],
  });
  const stats = await fn('u1');
  assert.equal(stats.goalHit, true, 'the weekly point GOAL is legitimately about total effort, unaffected by this fix');
  assert.equal(stats.goalPct, 220);
});

test('a lead-heavy, no-lag week is unaffected -- tier already agreed with totalPts', async () => {
  const fn = makeFn({
    userDoc: { email: 'lo@example.com' },
    settingsDoc: {},
    thisWeekDays: [
      { dateKey: '2026-08-24', totalPts: 205, leadPts: 205, lagPts: 0, breakdown: {}, categoryPts: {} },
    ],
  });
  const stats = await fn('u1');
  assert.equal(stats.tier.name, 'Master Networker');
});
