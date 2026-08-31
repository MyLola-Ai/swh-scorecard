// hasLinkedMyLolaAccount -- the single named entitlement predicate behind
// Austen's ruling on which MyLola tier actually counts (tightened
// 2026-08-31): the MyLola CRM tier specifically ('mylola', the $150 plan),
// checked LIVE against loaniq's verifyMyLolaAccount on every call, never
// cached. The original version only checked "does a MyLola account exist
// at this email at all" (connectionStatus === 'connected'), which handed
// SWH's own paid features to any free MyLola login -- caught and reported
// by MyLola LO, who shipped the loaniq-side tier field this depends on.
// Extraction test against the real shipped function; fetch and
// admin.auth().getUser are both injected so no real network call is made.
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

function makeFn({ email, fetchResult, fetchThrows, fetchOk = true, getUserThrows }) {
  const admin = {
    auth: () => ({
      getUser: async (uid) => {
        if (getUserThrows) throw new Error('no such user');
        return { uid, email };
      },
    }),
  };
  let lastFetchCall = null;
  const fetch = async (url, opts) => {
    lastFetchCall = { url, opts };
    if (fetchThrows) throw new Error('network unreachable');
    return {
      ok: fetchOk,
      json: async () => fetchResult,
    };
  };
  const MYLOLA_VERIFY_ACCOUNT_URL = 'https://us-central1-loaniq-75a20.cloudfunctions.net/verifyMyLolaAccount';
  const MYLOLA_INTEGRATION_SECRET = { value: () => 'test-secret' };
  const fn = new Function(
    'admin', 'fetch', 'MYLOLA_VERIFY_ACCOUNT_URL', 'MYLOLA_INTEGRATION_SECRET', 'console',
    `return async (uid) => {${bodySrc}}`,
  )(admin, fetch, MYLOLA_VERIFY_ACCOUNT_URL, MYLOLA_INTEGRATION_SECRET, console);
  return { fn, getLastFetchCall: () => lastFetchCall };
}

test('true when the live tier is exactly "mylola"', async () => {
  const { fn } = makeFn({ email: 'lo@example.com', fetchResult: { ok: true, connected: true, tier: 'mylola' } });
  assert.equal(await fn('u1'), true);
});

test('false for a free MyLola account -- this is the exact over-grant the tightening fixes', async () => {
  const { fn } = makeFn({ email: 'lo@example.com', fetchResult: { ok: true, connected: true, tier: 'free' } });
  assert.equal(await fn('u1'), false);
});

test('false for the "swh" tier too -- only "mylola" qualifies', async () => {
  const { fn } = makeFn({ email: 'lo@example.com', fetchResult: { ok: true, connected: true, tier: 'swh' } });
  assert.equal(await fn('u1'), false);
});

test('false when there is no MyLola account at all (connected: false, no tier)', async () => {
  const { fn } = makeFn({ email: 'nobody@example.com', fetchResult: { ok: true, connected: false } });
  assert.equal(await fn('u1'), false);
});

test('false, not thrown, when the SWH auth user lookup fails', async () => {
  const { fn } = makeFn({ getUserThrows: true, fetchResult: { tier: 'mylola' } });
  await assert.doesNotReject(async () => {
    assert.equal(await fn('u1'), false);
  });
});

test('false when the user has no email on file', async () => {
  const { fn } = makeFn({ email: null, fetchResult: { tier: 'mylola' } });
  assert.equal(await fn('u1'), false);
});

test('false, not thrown, when loaniq returns a non-OK HTTP status', async () => {
  const { fn } = makeFn({ email: 'lo@example.com', fetchResult: { error: 'internal' }, fetchOk: false });
  assert.equal(await fn('u1'), false);
});

test('false, not thrown, when the network call itself fails', async () => {
  const { fn } = makeFn({ email: 'lo@example.com', fetchThrows: true });
  await assert.doesNotReject(async () => {
    assert.equal(await fn('u1'), false);
  });
});

test('never cached: calls the live endpoint with the resolved email, authenticated with the shared secret', async () => {
  const { fn, getLastFetchCall } = makeFn({ email: 'lo@example.com', fetchResult: { tier: 'mylola' } });
  await fn('u1');
  const call = getLastFetchCall();
  assert.ok(call, 'expected a live fetch call, not a cache read');
  assert.match(call.url, /verifyMyLolaAccount$/);
  assert.equal(call.opts.headers.Authorization, 'Bearer test-secret');
  assert.equal(JSON.parse(call.opts.body).email, 'lo@example.com');
});
