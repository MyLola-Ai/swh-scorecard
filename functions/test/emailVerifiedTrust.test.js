// Security Eng findings F1/F1b/F2/F3 (2026-09-10, unverified-email trust).
// Password sign-up sets no emailVerified check, and SWH has no verification
// sender (see the lockout note at the bottom) -- so before this fix, an
// account registered under someone else's address let the caller read that
// person's loaniq/myappointment-ai data, or mint a "verified" comped SWH
// account behind the shared MYLOLA_INTEGRATION_SECRET.
//
// Every block below is extracted VERBATIM from index.js by source-text
// slice, not reimplemented -- a fake that merely returns the right answer
// proves nothing about the actual code. Each finding gets a firing negative
// control: the fake dependency an attacker's path WOULD have to reach is a
// spy, and the control asserts it was never called, not just that the
// returned value happened to be safe.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function sliceBetween(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  assert.ok(s !== -1, label + ': start marker not found');
  const e = src.indexOf(endMarker, s + startMarker.length);
  assert.ok(e !== -1, label + ': end marker not found');
  return src.slice(s, e + endMarker.length);
}

// ── F1b: getApptData native phase ───────────────────────────────────────────
const f1bSrc = sliceBetween(
  "let apptUid = swhUid;",
  "catch (e) { if (e.code !== 'auth/user-not-found') console.warn('[getApptData] appt email lookup:', e.message); }\n    }",
  'F1b',
);
function runF1b({ email, emailVerified, swhUid, apptAuth }) {
  const fn = new Function('email', 'emailVerified', 'swhUid', 'apptAuth',
    `return (async () => { ${f1bSrc}\nreturn apptUid; })();`);
  return fn(email, emailVerified, swhUid, apptAuth);
}

test('F1b negative control: unverified email never reaches getUserByEmail, apptUid stays swhUid', async () => {
  let called = false;
  const apptAuth = { getUserByEmail: async () => { called = true; return { uid: 'VICTIM_APPT_UID' }; } };
  const result = await runF1b({ email: 'victim@example.com', emailVerified: false, swhUid: 'attacker-uid', apptAuth });
  assert.equal(called, false, 'getUserByEmail must never be called for an unverified email');
  assert.equal(result, 'attacker-uid', 'apptUid must stay the caller\'s own swhUid');
});

test('F1b positive: verified email still resolves the matching appt account', async () => {
  let called = false;
  const apptAuth = { getUserByEmail: async (e) => { called = true; assert.equal(e, 'real@example.com'); return { uid: 'REAL_APPT_UID' }; } };
  const result = await runF1b({ email: 'real@example.com', emailVerified: true, swhUid: 'attacker-uid', apptAuth });
  assert.equal(called, true, 'a verified caller\'s own real match must still work');
  assert.equal(result, 'REAL_APPT_UID');
});

test('F1b: no email at all behaves the same as before (unaffected baseline)', async () => {
  let called = false;
  const apptAuth = { getUserByEmail: async () => { called = true; return { uid: 'x' }; } };
  const result = await runF1b({ email: null, emailVerified: false, swhUid: 'attacker-uid', apptAuth });
  assert.equal(called, false);
  assert.equal(result, 'attacker-uid');
});

// ── F1: getApptData Phase 1 (loaniq-75a20 email lookup) ─────────────────────
const f1Src = sliceBetween(
  "if (!resolvedUid && email && emailVerified) {",
  "else console.log(`[getApptData] no loaniq-75a20 account for ${email}`);\n    }\n  }",
  'F1',
);
function runF1({ email, emailVerified, lqAuth }) {
  const admin = { auth: () => lqAuth };
  const getLoaniqAdminApp = () => 'loaniq-app';
  return (new Function('email', 'emailVerified', 'admin', 'getLoaniqAdminApp',
    `return (async () => { let resolvedUid = null; ${f1Src}\nreturn resolvedUid; })();`
  ))(email, emailVerified, admin, getLoaniqAdminApp);
}

test('F1 negative control: unverified email never reaches loaniq getUserByEmail, resolvedUid stays null', async () => {
  let called = false;
  const lqAuth = { getUserByEmail: async () => { called = true; return { uid: 'VICTIM_LQ_UID' }; } };
  const result = await runF1({ email: 'victim@example.com', emailVerified: false, lqAuth });
  assert.equal(called, false, 'the loaniq-75a20 lookup must never fire for an unverified email');
  assert.equal(result, null, 'resolvedUid must stay null, so Phase 2 / the empty-result path runs next, not a cache write');
});

test('F1 positive: verified email still resolves the real loaniq account (no regression)', async () => {
  let called = false;
  const lqAuth = { getUserByEmail: async (e) => { called = true; assert.equal(e, 'real@example.com'); return { uid: 'REAL_LQ_UID' }; } };
  const result = await runF1({ email: 'real@example.com', emailVerified: true, lqAuth });
  assert.equal(called, true);
  assert.equal(result, 'REAL_LQ_UID');
});

// ── F3: mintApptCustomToken legacy fallback ──────────────────────────────────
const f3Src = sliceBetween(
  "targetUid = swhUid;\n\n   // F3:",
  "        throw e;\n      }\n    }\n  }",
  'F3',
);
function runF3({ email, emailVerified, name, swhUid, apptAuth }) {
  const fn = new Function('email', 'emailVerified', 'name', 'swhUid', 'apptAuth',
    `return (async () => { let targetUid = null; ${f3Src}\nreturn targetUid; })();`);
  return fn(email, emailVerified, name, swhUid, apptAuth);
}

test('F3 negative control: unverified email never reaches getUserByEmail, provisions uid-only', async () => {
  let getByEmailCalled = false;
  const apptAuth = {
    getUserByEmail: async () => { getByEmailCalled = true; return { uid: 'VICTIM_APPT_UID' }; },
    getUser: async (uid) => ({ uid }), // pretend the swhUid-keyed account already exists
    createUser: async () => { throw new Error('should not need to create in this test'); },
  };
  const result = await runF3({ email: 'victim@example.com', emailVerified: false, name: 'Attacker', swhUid: 'attacker-uid', apptAuth });
  assert.equal(getByEmailCalled, false, 'getUserByEmail must never fire for an unverified email');
  assert.equal(result, 'attacker-uid', 'must fall to uid-only provisioning, never the victim\'s account');
});

test('F3 positive: verified email still links the existing myappointment-ai account (no regression)', async () => {
  let getByEmailCalled = false;
  const apptAuth = {
    getUserByEmail: async (e) => { getByEmailCalled = true; assert.equal(e, 'real@example.com'); return { uid: 'REAL_APPT_UID' }; },
  };
  const result = await runF3({ email: 'real@example.com', emailVerified: true, name: 'Real User', swhUid: 'real-uid', apptAuth });
  assert.equal(getByEmailCalled, true);
  assert.equal(result, 'REAL_APPT_UID');
});

// ── F2: getOrProvisionSwhUser ─────────────────────────────────────────────
const f2Src = sliceBetween(
  'async function getOrProvisionSwhUser(email, via) {',
  '\n  return { uid, provisioned: true };\n}',
  'F2',
);
function makeGetOrProvisionSwhUser({ authStore, firestoreDocs }) {
  const admin = {
    auth: () => ({
      getUserByEmail: async (email) => {
        const found = authStore.find(u => u.email === email);
        if (!found) { const e = new Error('not found'); e.code = 'auth/user-not-found'; throw e; }
        return found;
      },
      createUser: async ({ email, emailVerified }) => {
        if (authStore.find(u => u.email === email)) { const e = new Error('exists'); e.code = 'auth/email-already-exists'; throw e; }
        const rec = { uid: 'new-' + (authStore.length + 1), email, emailVerified };
        authStore.push(rec);
        return rec;
      },
    }),
    firestore: () => ({
      doc: (path) => ({
        set: async (data) => { firestoreDocs[path] = { ...(firestoreDocs[path] || {}), ...data }; },
      }),
    }),
  };
  const swhCompPlanFieldsFor = (via) => (via === 'myclosings' ? { plan: 'pro' } : { plan: 'scorecard' });
  const fnBody = f2Src.slice(f2Src.indexOf('{') + 1, f2Src.lastIndexOf('}'));
  return new Function('admin', 'swhCompPlanFieldsFor', 'email', 'via',
    `return (async () => { ${fnBody} })();`
  ).bind(null, admin, swhCompPlanFieldsFor);
}

test('F2: a freshly provisioned SWH account is NOT marked emailVerified', async () => {
  const authStore = [];
  const firestoreDocs = {};
  const getOrProvisionSwhUser = makeGetOrProvisionSwhUser({ authStore, firestoreDocs });
  const result = await getOrProvisionSwhUser('new-user@example.com', 'mylola-session-mint');
  assert.equal(result.provisioned, true);
  const created = authStore.find(u => u.uid === result.uid);
  assert.equal(created.emailVerified, false, 'must never hardcode true for an address this endpoint did not verify');
});

test('F2: an already-existing account is resolved as-is (unaffected baseline, no regression)', async () => {
  const authStore = [{ uid: 'existing-1', email: 'already@example.com', emailVerified: true }];
  const firestoreDocs = {};
  const getOrProvisionSwhUser = makeGetOrProvisionSwhUser({ authStore, firestoreDocs });
  const result = await getOrProvisionSwhUser('already@example.com', 'myclosings');
  assert.equal(result.uid, 'existing-1');
  assert.equal(result.provisioned, false);
});

// ── Lockout note (not a test, a record of the code-derived answer) ─────────
// Sign-in paths in public-crm/index.html + public-scorecard/index.html:
// Google OAuth, Microsoft OAuth (Firebase marks both email_verified:true
// automatically), and password (createUserWithEmailAndPassword -- grepped
// the whole repo, sendEmailVerification does not exist anywhere, so these
// users can never self-verify). approveWaitlistUser also creates accounts
// without setting emailVerified, despite being a real, human-vetted (Austen
// personally approves) onboarding path -- flagged to CTO/Austen separately,
// not touched here since it's adjacent to these four findings, not one of
// them. This is why F1/F1b/F3 only skip the CROSS-PROJECT link when
// unverified rather than refusing the whole endpoint -- a hard gate would
// strand every password and waitlist-approved user from their own data.
