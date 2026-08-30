// hasLinkedMyLolaAccount -- the single named entitlement predicate behind
// Austen's 2026-08-30 ruling ("The SWH scorecard is available for all MyLola
// user but MyLola is not available for all SWH users"). Extraction test
// against the real shipped function: "linked" means
// users/{uid}/integrations/mylola has connectionStatus 'connected', stamped
// client-side (public-crm/index.html connectMyLola()) only after
// verifyMyLolaConnection confirms a real MyLola account exists. Any lookup
// failure must resolve false, never throw -- callers on both the read side
// (getScorecardForUser's canLog) and the write side (saveDayForUser's
// paywall) fold this into a fail-closed entitlement check, so a thrown
// error here would take down more than just this predicate.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const startMarker = 'async function hasLinkedMyLolaAccount(uid) {';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'hasLinkedMyLolaAccount not found');
const bodyStart = startIdx + startMarker.length;
const endIdx = src.indexOf('\n}', bodyStart);
assert.ok(endIdx !== -1, 'function end not found');
const bodySrc = src.slice(bodyStart, endIdx);

function makeFn({ integrationDoc, docThrows }) {
  const admin = {
    firestore: () => ({
      doc: (p) => {
        assert.match(p, /^users\/[^/]+\/integrations\/mylola$/, 'must read the mylola integration doc, not some other path');
        if (docThrows) throw new Error('firestore unavailable');
        return { get: async () => ({ exists: !!integrationDoc, data: () => integrationDoc }) };
      },
    }),
  };
  return new Function('admin', 'console', `return async (uid) => {${bodySrc}}`)(admin, console);
}

test('true when connectionStatus is connected', async () => {
  const fn = makeFn({ integrationDoc: { connectionStatus: 'connected', myLolaUserId: 'ml_1' } });
  assert.equal(await fn('u1'), true);
});

test('false when connectionStatus is disconnected', async () => {
  const fn = makeFn({ integrationDoc: { connectionStatus: 'disconnected' } });
  assert.equal(await fn('u1'), false);
});

test('false when there is no integration doc at all -- never connected', async () => {
  const fn = makeFn({ integrationDoc: null });
  assert.equal(await fn('u1'), false);
});

test('false, not thrown, when the lookup itself fails', async () => {
  const fn = makeFn({ integrationDoc: null, docThrows: true });
  await assert.doesNotReject(async () => {
    assert.equal(await fn('u1'), false);
  });
});
