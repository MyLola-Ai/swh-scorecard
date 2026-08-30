// enrollOnboardingDripForUid -- extraction test for the CTO ruling,
// 2026-08-30: suppress the onboarding drip for any cross-product-provisioned
// account (same reasoning as the sendFollowThroughDigest ruling an hour
// earlier -- a MyLola/MyClosings user did not sign up for SWH, so "welcome
// to Stop Wasting Handshakes" misreads who they are). Gated on
// provisionedVia, written only by getOrProvisionSwhUser -- an organic SWH
// signup has no such field.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const startMarker = 'async function enrollOnboardingDripForUid(uid, email) {';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'enrollOnboardingDripForUid not found');
const bodyStart = startIdx + startMarker.length;
const endIdx = src.indexOf('\n}', bodyStart);
assert.ok(endIdx !== -1, 'function end not found');
const bodySrc = src.slice(bodyStart, endIdx);

function makeFn({ existingDripDoc, userDoc, settingsDoc }) {
  const writes = { onboardingDrip: null };
  const db = {
    collection: (name) => {
      assert.equal(name, 'onboardingDrip');
      return {
        doc: (uid) => ({
          get: async () => ({ exists: !!existingDripDoc, data: () => existingDripDoc }),
          set: async (data) => { writes.onboardingDrip = { uid, data }; },
        }),
      };
    },
    doc: (p) => {
      if (/^users\/[^/]+$/.test(p)) {
        return { get: async () => ({ exists: !!userDoc, data: () => userDoc }) };
      }
      if (/^users\/[^/]+\/config\/settings$/.test(p)) {
        return { get: async () => ({ exists: !!settingsDoc, data: () => settingsDoc }) };
      }
      throw new Error('unexpected doc path: ' + p);
    },
  };
  const fn = new Function(
    'db', 'console',
    `return async (uid, email) => {${bodySrc}}`,
  )(db, console);
  return { fn, writes };
}

test('an organic SWH signup (no provisionedVia) enrolls normally', async () => {
  const { fn, writes } = makeFn({
    existingDripDoc: null,
    userDoc: { plan: 'pro' }, // no provisionedVia field
    settingsDoc: { displayName: 'Jamie Rivera' },
  });
  await fn('uid_organic', 'jamie@example.com');
  assert.ok(writes.onboardingDrip, 'expected an enrollment write');
  assert.equal(writes.onboardingDrip.data.email, 'jamie@example.com');
  assert.equal(writes.onboardingDrip.data.firstName, 'Jamie');
});

test('a MyLola-provisioned account is suppressed, not enrolled', async () => {
  const { fn, writes } = makeFn({
    existingDripDoc: null,
    userDoc: { plan: 'pro', subscriptionStatus: 'comp', provisionedVia: 'mylola-scorecard-read' },
    settingsDoc: {},
  });
  await fn('uid_mylola', 'lo@example.com');
  assert.equal(writes.onboardingDrip, null, 'must not enroll a MyLola-provisioned account');
});

test('a MyClosings-provisioned account is suppressed too -- same reasoning applies', async () => {
  const { fn, writes } = makeFn({
    existingDripDoc: null,
    userDoc: { plan: 'pro', subscriptionStatus: 'comp', provisionedVia: 'myclosings' },
    settingsDoc: {},
  });
  await fn('uid_myclosings', 'agent@example.com');
  assert.equal(writes.onboardingDrip, null, 'a MyClosings user also did not sign up for SWH directly');
});

test('an already-enrolled uid stays idempotent regardless of provisionedVia', async () => {
  const { fn, writes } = makeFn({
    existingDripDoc: { uid: 'uid_x', dripIndex: 3 },
    userDoc: { plan: 'free' },
    settingsDoc: {},
  });
  await fn('uid_x', 'x@example.com');
  assert.equal(writes.onboardingDrip, null, 'must not re-write an existing enrollment');
});
