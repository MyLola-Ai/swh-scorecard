// gmail-sync migration guard (2026-08-13, found via a PM audit of the Nylas
// purge). runGmailIncrementalSync's guard used to check for an active
// `integrations/nylas` doc to decide when to pause the legacy direct-Gmail
// sync -- stale after Nylas' removal, so the condition could never be true
// again and the pause silently stopped firing. gmailOauthInitiate still has
// a live frontend caller, so a user connected to both Gmail-direct and Lola
// Connect would get every inbound/outbound email double-logged onto their
// contact timelines. Fixed to check real Lola Connect connection status
// instead, computed once per cron run via lola-connect.js's
// lcConnectedUidSet() and passed through.
//
// Extraction test: pulls the REAL guard block and the REAL cron handler body
// out of the shipped functions/index.js and runs them against fakes, not a
// reimplementation of the logic. Covers the two things the PM/CTO review
// specifically asked to see tested before this ships: (1) the guard itself
// actually pauses/doesn't-pause correctly, and (2) if the Lola Connect
// lookup fails, the fix fails CLOSED (skips the run) rather than open
// (empty Set -> guard never fires -> exactly the bug this exists to fix).
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

const guardFnSrc = extractBetween(
  'async function runGmailIncrementalSync(uid, lcConnectedUids) {',
  '\n// ============================================================\n// EMAIL INTEGRATION — Outlook OAuth'
);
// Stop at the guard's own return -- don't need the real Gmail-API body past
// it (mocking gmailGetMessage/parseGmailMessage/etc. would buy nothing,
// since the guard already returns before reaching them).
const guardOnlySrc = guardFnSrc.slice(0, guardFnSrc.indexOf('if (!integration.lastHistoryId)'))
  + 'return "PAST_GUARD"; }';

function makeGuardFn(fakeDoc) {
  const db = { doc: () => ({ get: async () => fakeDoc }) };
  // guardOnlySrc is already a complete "async function runGmailIncrementalSync(...) {...}"
  // -- declare it as-is and hand back the reference.
  return new Function('db', `${guardOnlySrc}\nreturn runGmailIncrementalSync;`)(db);
}

const cronBodyFull = extractBetween(
  '}, async () => {\n  // Find all users with active Gmail integrations',
  '\n\n// ── Incremental sync via Gmail history API'
);
// Strip the leftover config-object close at the front and the arrow-fn/call
// close at the back, leaving pure body statements safe to wrap fresh.
const cronBodySrc = cronBodyFull
  .replace(/^\}, async \(\) => \{/, '')
  .replace(/\}\);\s*$/, '');

test('guard: connected uid, not yet migrated -> pauses legacy sync, stamps migrated once', async () => {
  const setCalls = [];
  const fakeDoc = {
    exists: true,
    data: () => ({ status: 'connected' }),
    ref: { set: async (data, opts) => setCalls.push({ data, opts }) },
  };
  const result = await makeGuardFn(fakeDoc)('uid-a', new Set(['uid-a']));
  assert.notEqual(result, 'PAST_GUARD');
  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].data.status, 'migrated');
  assert.equal(setCalls[0].opts.merge, true, 'must merge, never blind-overwrite the integration doc');
});

test('guard: already migrated -> pauses again but does not re-write', async () => {
  const setCalls = [];
  const fakeDoc = {
    exists: true,
    data: () => ({ status: 'migrated' }),
    ref: { set: async (data, opts) => setCalls.push({ data, opts }) },
  };
  const result = await makeGuardFn(fakeDoc)('uid-b', new Set(['uid-b']));
  assert.notEqual(result, 'PAST_GUARD');
  assert.equal(setCalls.length, 0, 'idempotent -- must not re-write an already-migrated doc');
});

test('guard: uid not connected to Lola Connect -> does not fire, legacy sync proceeds', async () => {
  const fakeDoc = { exists: true, data: () => ({ status: 'connected' }), ref: { set: async () => {} } };
  const result = await makeGuardFn(fakeDoc)('uid-c', new Set(['some-other-uid']));
  assert.equal(result, 'PAST_GUARD');
});

test('cron: Lola Connect lookup fails -> fails CLOSED (legacy sync never runs that cycle), logged loudly', async () => {
  let runGmailIncrementalSyncCalled = false;
  let loggedError = null;
  const fakeIntegrationsSnap = { docs: [{ ref: { path: 'users/uid-x/integrations/gmail' } }] };
  const db = {
    collectionGroup: () => ({
      where: () => ({ where: () => ({ get: async () => fakeIntegrationsSnap }) }),
    }),
  };
  const _gmailSyncLolaConnect = {
    lcConnectedUidSet: async () => { throw new Error('gateway timeout'); },
  };
  const runGmailIncrementalSync = async () => { runGmailIncrementalSyncCalled = true; };
  const fakeConsole = {
    log: () => {},
    error: (...args) => { loggedError = args.join(' '); },
  };
  const cronFn = new Function(
    'db', '_gmailSyncLolaConnect', 'runGmailIncrementalSync', 'console',
    `return (async () => { ${cronBodySrc} })();`
  );
  await cronFn(db, _gmailSyncLolaConnect, runGmailIncrementalSync, fakeConsole);
  assert.equal(runGmailIncrementalSyncCalled, false, 'must fail closed: legacy sync must never run without the migration guard in place');
  assert.ok(loggedError && loggedError.includes('gateway timeout'), 'failure must be logged loudly (console.error), not silently swallowed');
});
