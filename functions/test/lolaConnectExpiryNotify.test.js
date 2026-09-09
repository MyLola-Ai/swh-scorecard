// lolaConnectExpiryNotify -- extraction tests for the two pure decision
// helpers behind the "email Danny (or anyone) when Lola Connect expires"
// sweep (Austen, 2026-09-02): _lcProviderLabel and _lcExpiryNotifyDecision.
// The sweep itself (Firestore reads/mail.add) is exercised by syntax-check
// and live verification after deploy, same as its siblings sendFollowThroughDigest
// and the onboarding drip -- none of which get a dedicated test file either,
// since they're thin orchestration over the module-level db const. What's
// worth pinning down here is the re-notify decision: send on a fresh expiry,
// stay quiet on a repeat check inside the cooldown, and try again once the
// cooldown has elapsed -- get any of those three wrong and Danny either
// never hears about it or gets emailed every single day.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function extractBody(marker, label) {
  const startIdx = src.indexOf(marker);
  assert.ok(startIdx !== -1, label + ' not found');
  const bodyStart = startIdx + marker.length;
  const endIdx = src.indexOf('\n}', bodyStart);
  assert.ok(endIdx !== -1, label + ' end not found');
  return src.slice(bodyStart, endIdx);
}

const providerLabelSrc = extractBody('function _lcProviderLabel(provider) {', '_lcProviderLabel');
const _lcProviderLabel = new Function('provider', providerLabelSrc);

const renotifyMatch = src.match(/const _LC_EXPIRY_RENOTIFY_MS = ([^;]+);/);
assert.ok(renotifyMatch, '_LC_EXPIRY_RENOTIFY_MS declaration not found');
const _LC_EXPIRY_RENOTIFY_MS = new Function(`return (${renotifyMatch[1]});`)();
assert.equal(_LC_EXPIRY_RENOTIFY_MS, 7 * 24 * 60 * 60 * 1000, 'sanity check on the extracted cooldown constant');

const decisionSrc = extractBody(
  'function _lcExpiryNotifyDecision(email, alreadyNotified, connectionId, nowMs) {',
  '_lcExpiryNotifyDecision',
);
// isNonMailableAccount is a real, separately-relied-upon dependency, not
// something this change introduces -- faked here (like hasLinkedMyLolaAccount
// is faked in buildFollowThroughQueueEligibility.test.js) so these tests
// isolate the re-notify branching this change actually adds.
function makeDecisionFn(isNonMailableAccountImpl) {
  const fn = new Function(
    'isNonMailableAccount', '_LC_EXPIRY_RENOTIFY_MS', 'email', 'alreadyNotified', 'connectionId', 'nowMs',
    decisionSrc,
  );
  return (email, alreadyNotified, connectionId, nowMs) =>
    fn(isNonMailableAccountImpl, _LC_EXPIRY_RENOTIFY_MS, email, alreadyNotified, connectionId, nowMs);
}

const NOW = Date.parse('2026-09-02T18:00:00.000Z');
const decision = makeDecisionFn(() => false); // "not a test account" by default
const decisionTestAccount = makeDecisionFn(() => true);

test('_lcProviderLabel maps known providers, falls back for anything else', () => {
  assert.equal(_lcProviderLabel('microsoft'), 'Outlook');
  assert.equal(_lcProviderLabel('google'), 'Google');
  assert.equal(_lcProviderLabel('imap'), 'email');
  assert.equal(_lcProviderLabel(undefined), 'email');
  assert.equal(_lcProviderLabel('something-new'), 'email');
});

test('no SWH account email on file -> never sends', () => {
  assert.equal(decision('', {}, 'conn1', NOW), 'skip_no_email');
  assert.equal(decision(null, {}, 'conn1', NOW), 'skip_no_email');
  assert.equal(decision(undefined, {}, 'conn1', NOW), 'skip_no_email');
});

test('fresh expiry, never notified before -> sends', () => {
  assert.equal(decision('danny@dannylsmith.com', {}, 'conn1', NOW), 'send');
});

test('a record for a DIFFERENT connection id does not suppress this one', () => {
  const already = { conn_other: new Date(NOW).toISOString() };
  assert.equal(decision('danny@dannylsmith.com', already, 'conn1', NOW), 'send');
});

test('notified 1 hour ago -> stays quiet (inside the 7-day cooldown)', () => {
  const already = { conn1: new Date(NOW - 60 * 60 * 1000).toISOString() };
  assert.equal(decision('danny@dannylsmith.com', already, 'conn1', NOW), 'skip_recently_notified');
});

test('notified exactly 7 days ago -> the cooldown has fully elapsed, sends', () => {
  const already = { conn1: new Date(NOW - _LC_EXPIRY_RENOTIFY_MS).toISOString() };
  assert.equal(decision('danny@dannylsmith.com', already, 'conn1', NOW), 'send');
});

test('notified 1ms under 7 days ago -> still quiet, one millisecond shy', () => {
  const already = { conn1: new Date(NOW - _LC_EXPIRY_RENOTIFY_MS + 1).toISOString() };
  assert.equal(decision('danny@dannylsmith.com', already, 'conn1', NOW), 'skip_recently_notified');
});

test('a skipped_test sentinel is never mistaken for a recent real send', () => {
  const already = { conn1: 'skipped_test' };
  assert.equal(decisionTestAccount('qa+e2e@stopwastinghandshakes.com', already, 'conn1', NOW), 'skip_test_account');
});

test('non-mailable (e2e/test) accounts are marked skip_test_account, never sent to', () => {
  assert.equal(decisionTestAccount('qa+e2e@stopwastinghandshakes.com', {}, 'conn1', NOW), 'skip_test_account');
});
