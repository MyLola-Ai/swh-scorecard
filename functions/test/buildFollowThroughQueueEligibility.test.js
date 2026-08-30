// runFollowThroughQueueBuild -- extraction test for the eligibility-selection
// block added by Austen's 2026-08-30 ruling. Before this, the builder looped
// ADMIN_EMAILS directly (one hardcoded account); it now processes ADMIN_EMAILS
// UNION any uid with a linked MyLola account, and NOT every SWH user --
// Austen was explicit that entitlement flows from MyLola down, not the other
// way. This tests only the selection logic (who gets processed), not the
// drafting pass -- that would mean mocking Anthropic for a change that never
// touches it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const startMarker = "const adminUids = new Set();";
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'eligibility block start not found');
const endMarker = "const eligibleUids = [...adminUids, ...linkedUids];";
const endIdx = src.indexOf(endMarker, startIdx);
assert.ok(endIdx !== -1, 'eligibility block end not found');
const blockSrc = src.slice(startIdx, endIdx) + endMarker;

function makeEligibilityFn({ adminEmails, adminUidByEmail, allUserIds, linkedUidSet }) {
  const admin = {
    auth: () => ({
      getUserByEmail: async (email) => {
        const uid = adminUidByEmail[email];
        if (!uid) throw new Error('no auth user for ' + email);
        return { uid };
      },
    }),
    firestore: () => ({
      collection: (name) => {
        assert.equal(name, 'users');
        return { get: async () => ({ docs: allUserIds.map((id) => ({ id })) }) };
      },
    }),
  };
  const ADMIN_EMAILS = adminEmails || Object.keys(adminUidByEmail);
  const hasLinkedMyLolaAccount = async (uid) => linkedUidSet.has(uid);
  const fn = new Function(
    'admin', 'ADMIN_EMAILS', 'hasLinkedMyLolaAccount', 'console',
    `return async () => {${blockSrc}\nreturn eligibleUids;}`,
  )(admin, ADMIN_EMAILS, hasLinkedMyLolaAccount, console);
  return fn;
}

test('the admin bootstrap account is always eligible, linked or not', async () => {
  const eligible = await makeEligibilityFn({
    adminUidByEmail: { 'austen@austensmith.com': 'uid_admin' },
    allUserIds: ['uid_admin'],
    linkedUidSet: new Set(),
  })();
  assert.deepEqual(eligible, ['uid_admin']);
});

test('a non-admin uid with a linked MyLola account is eligible', async () => {
  const eligible = await makeEligibilityFn({
    adminUidByEmail: { 'austen@austensmith.com': 'uid_admin' },
    allUserIds: ['uid_admin', 'uid_linked', 'uid_unlinked'],
    linkedUidSet: new Set(['uid_linked']),
  })();
  assert.deepEqual(eligible.sort(), ['uid_admin', 'uid_linked'].sort());
  assert.ok(!eligible.includes('uid_unlinked'), 'an unlinked, non-admin SWH user must NOT be eligible -- entitlement flows from MyLola down, not to every SWH user');
});

test('an admin who also happens to be MyLola-linked is not processed twice', async () => {
  const eligible = await makeEligibilityFn({
    adminUidByEmail: { 'austen@austensmith.com': 'uid_admin' },
    allUserIds: ['uid_admin'],
    linkedUidSet: new Set(['uid_admin']),
  })();
  assert.deepEqual(eligible, ['uid_admin']);
});

test('an unresolvable admin email does not crash the scan -- the linked population is still found', async () => {
  const eligible = await makeEligibilityFn({
    adminEmails: ['austen@austensmith.com'],
    adminUidByEmail: {}, // getUserByEmail throws for every ADMIN_EMAILS entry
    allUserIds: ['uid_linked'],
    linkedUidSet: new Set(['uid_linked']),
  })();
  assert.deepEqual(eligible, ['uid_linked']);
});
