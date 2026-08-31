// runFollowThroughQueueBuild -- extraction test for the eligibility-selection
// block. Started as ADMIN_EMAILS only (one hardcoded account); Austen's
// 2026-08-30 ruling widened it to ADMIN_EMAILS UNION any uid with a linked
// MyLola account, and NOT every SWH user -- entitlement flows from MyLola
// down, not the other way. 2026-08-31 added a third, independent path: a
// uid manually flagged morningQueueEnabled=true via adminUpdateUser --
// Austen's controlled per-user rollout ahead of any broader eligibility
// rule (Tony Cubbage: pro SWH user, free-tier MyLola, not eligible under
// either existing path, needed a way in without widening the gate for
// everyone). This tests only the selection logic (who gets processed), not
// the drafting pass -- that would mean mocking Anthropic for a change that
// never touches it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const startMarker = "const adminUids = new Set();";
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'eligibility block start not found');
const endMarker = "const eligibleUids = [...new Set([...adminUids, ...linkedUids, ...manualUids])];";
const endIdx = src.indexOf(endMarker, startIdx);
assert.ok(endIdx !== -1, 'eligibility block end not found');
const blockSrc = src.slice(startIdx, endIdx) + endMarker;

function makeEligibilityFn({ adminEmails, adminUidByEmail, allUserIds, linkedUidSet, manualUidSet }) {
  const manual = manualUidSet || new Set();
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
        return {
          get: async () => ({
            docs: allUserIds.map((id) => ({ id, data: () => ({ morningQueueEnabled: manual.has(id) }) })),
          }),
        };
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

// The Tony Cubbage case: pro SWH user, connected to MyLola but on the free
// tier (not linked under hasLinkedMyLolaAccount's tier==='mylola' check),
// not an admin. Neither existing path reaches him -- only the manual flag.
test('a manually-flagged uid is eligible even with no MyLola link and no admin status', async () => {
  const eligible = await makeEligibilityFn({
    adminUidByEmail: { 'austen@austensmith.com': 'uid_admin' },
    allUserIds: ['uid_admin', 'uid_manual', 'uid_neither'],
    linkedUidSet: new Set(),
    manualUidSet: new Set(['uid_manual']),
  })();
  assert.deepEqual(eligible.sort(), ['uid_admin', 'uid_manual'].sort());
  assert.ok(!eligible.includes('uid_neither'), 'a uid with morningQueueEnabled unset must not become eligible by default');
});

test('a uid that is both MyLola-linked and manually-flagged is not processed twice', async () => {
  const eligible = await makeEligibilityFn({
    adminUidByEmail: { 'austen@austensmith.com': 'uid_admin' },
    allUserIds: ['uid_admin', 'uid_both'],
    linkedUidSet: new Set(['uid_both']),
    manualUidSet: new Set(['uid_both']),
  })();
  assert.deepEqual(eligible.sort(), ['uid_admin', 'uid_both'].sort());
});

test('the manual flag does not make an admin uid appear twice', async () => {
  const eligible = await makeEligibilityFn({
    adminUidByEmail: { 'austen@austensmith.com': 'uid_admin' },
    allUserIds: ['uid_admin'],
    linkedUidSet: new Set(),
    manualUidSet: new Set(['uid_admin']),
  })();
  assert.deepEqual(eligible, ['uid_admin']);
});
