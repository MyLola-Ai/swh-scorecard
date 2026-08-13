// outlook-sync migration guard (2026-08-13, found via the same PM/CTO audit
// that caught the Gmail guard bug -- identical failure class, this path
// never had a guard at all). runOutlookIncrementalSync had no check against
// Lola Connect status, so anyone connected to both Outlook-direct and Lola
// Connect double-logs every inbound/outbound email under two doc keys
// right now. Fixed the same way as Gmail: check real Lola Connect
// connection status via lola-connect.js's lcConnectedUidSet(), computed
// once per cron run and passed through, failing CLOSED (skip the whole
// run, log loudly) if the lookup fails.
//
// Extraction test: pulls the REAL guard block and the REAL cron handler
// body out of the shipped functions/index.js, same technique as
// gmailSyncMigrationGuard.test.js -- not a reimplementation, and not
// copy-pasted assertions against a copy-pasted fix. Covers the same two
// things CTO required for the Gmail fix before it shipped: (1) the guard
// itself actually pauses/doesn't-pause correctly, and (2) fail-closed on
// lookup failure, with the failure actually logged, not just skipped.
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
  'async function runOutlookIncrementalSync(uid, lcConnectedUids) {',
  'const deltaLinks = integration.deltaLinks'
);
// The extracted slice ends right before the real Graph-API body starts --
// same reasoning as the Gmail test: mocking graphDeltaMessages/
// parseGraphMessage/etc. would buy nothing, since the guard already
// returns before reaching them. Close the function here.
const guardOnlySrc = guardFnSrc + 'return "PAST_GUARD"; }';

function makeGuardFn(fakeDoc) {
  const db = { doc: () => ({ get: async () => fakeDoc }) };
  return new Function('db', `${guardOnlySrc}\nreturn runOutlookIncrementalSync;`)(db);
}

const cronBodyFull = extractBetween(
  '}, async () => {\n  const integrationsSnap = await db.collectionGroup(\'integrations\')\n    .where(\'provider\', \'==\', \'outlook\')',
  '\n\n// ── Incremental sync via Graph delta query'
);
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
  let runOutlookIncrementalSyncCalled = false;
  let loggedError = null;
  const fakeIntegrationsSnap = { docs: [{ ref: { path: 'users/uid-x/integrations/outlook' } }] };
  const db = {
    collectionGroup: () => ({
      where: () => ({ where: () => ({ get: async () => fakeIntegrationsSnap }) }),
    }),
  };
  const _outlookSyncLolaConnect = {
    lcConnectedUidSet: async () => { throw new Error('gateway timeout'); },
  };
  const runOutlookIncrementalSync = async () => { runOutlookIncrementalSyncCalled = true; };
  const fakeConsole = {
    log: () => {},
    error: (...args) => { loggedError = args.join(' '); },
  };
  const cronFn = new Function(
    'db', '_outlookSyncLolaConnect', 'runOutlookIncrementalSync', 'console',
    `return (async () => { ${cronBodySrc} })();`
  );
  await cronFn(db, _outlookSyncLolaConnect, runOutlookIncrementalSync, fakeConsole);
  assert.equal(runOutlookIncrementalSyncCalled, false, 'must fail closed: legacy sync must never run without the migration guard in place');
  assert.ok(loggedError && loggedError.includes('gateway timeout'), 'failure must be logged loudly (console.error), not silently swallowed');
});
