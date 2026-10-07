// Every functions-side admin gate is keyed on the Auth uid, not an email claim (F4 class).
// Runs the real shipped source. A verified token on the admin ADDRESS but another uid must be
// refused everywhere; the admin uid must pass with no email claim at all.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const helperSrc = src.match(/const ADMIN_UIDS = [^\n]*\nconst isAdminUid = [^\n]*\n/)[0];
const { ADMIN_UID, isAdminUid } = new Function(helperSrc + 'return { ADMIN_UID: ADMIN_UIDS[0], isAdminUid };')();

const EXPECTED_GATES = ['approveWaitlistUser', 'backfillOnboardingDrip', 'checkMailQueue', 'createTestUser',
  'deleteUser', 'requireAdmin', 'sendSampleRecap'];

function owner(idx) {
  const before = src.slice(0, idx);
  const e = [...before.matchAll(/^exports\.(\w+) = on\w+/gm)].pop();
  const f = [...before.matchAll(/^(?:async )?function (\w+)\(/gm)].pop();
  return (f && (!e || f.index > e.index)) ? f[1] : e[1];
}

test('no admin gate is still keyed on ADMIN_EMAILS, and the uid check sits in exactly the expected gates', () => {
  assert.equal((src.match(/ADMIN_EMAILS\.includes\(/g) || []).length, 0, 'an email-keyed admin gate remains');
  const sites = [...src.matchAll(/isAdminUid\(/g)].map((m) => m.index).filter((i) => !/const isAdminUid/.test(src.slice(i - 20, i + 14)));
  assert.deepEqual([...new Set(sites.map(owner))].sort(), EXPECTED_GATES);
  assert.equal(sites.length, EXPECTED_GATES.length);
});

test('the helper itself: only the admin uid passes; address-like strings, empties and non-strings do not', () => {
  assert.equal(isAdminUid(ADMIN_UID), true);
  for (const bad of ['austen@austensmith.com', '', undefined, null, 0, {}, ADMIN_UID + 'x']) assert.equal(isAdminUid(bad), false);
});

const imposters = [
  { label: 'no auth', auth: null },
  { label: 'ordinary user', auth: { uid: 'u1', token: { email: 'u@example.com', email_verified: true } } },
  { label: 'admin address, unverified, other uid', auth: { uid: 'x1', token: { email: 'austen@austensmith.com', email_verified: false } } },
  { label: 'admin address, VERIFIED, other uid', auth: { uid: 'x2', token: { email: 'austen@austensmith.com', email_verified: true } } },
];
const adminNoEmail = { uid: ADMIN_UID, token: {} };

function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a !== -1, 'not found: ' + startMarker);
  const bodyStart = a + startMarker.length;
  return src.slice(bodyStart, src.indexOf(endMarker, bodyStart));
}

for (const name of ['approveWaitlistUser', 'createTestUser', 'deleteUser', 'sendSampleRecap']) {
  test(`${name}: refuses every impostor before any work, admits the admin uid`, async () => {
    const body = slice(`exports.${name} = onCall({ cors: true }, async (request) => {`, '\n});');
    const fn = new Function('isAdminUid', `return async (request) => {${body}};`)(isAdminUid);
    for (const i of imposters) {
      await assert.rejects(() => fn({ auth: i.auth, data: {} }), /admin only/, `${name} let through: ${i.label}`);
    }
    await fn({ auth: adminNoEmail, data: {} }).then(() => {}, (e) => assert.ok(!/admin only/.test(e.message), `${name} refused the admin uid`));
  });
}

test('requireAdmin (the helper behind the admin* endpoints): 403 for impostors, passes the admin uid', async () => {
  const body = slice('async function requireAdmin(req) {', '\n}\n');
  const make = (decoded) => new Function('requireAuth', 'isAdminUid', `return async (req) => {${body}};`)(async () => decoded, isAdminUid);
  for (const i of imposters.filter((x) => x.auth)) {
    await assert.rejects(() => make({ uid: i.auth.uid, ...i.auth.token })({}), (e) => e.statusCode === 403, `let through: ${i.label}`);
  }
  const ok = await make({ uid: ADMIN_UID })({});
  assert.equal(ok.uid, ADMIN_UID);
});

for (const name of ['checkMailQueue', 'backfillOnboardingDrip']) {
  test(`${name}: 403 for impostors, not for the admin uid`, async () => {
    const body = slice(`exports.${name} = onRequest({ cors: true }, async (req, res) => {`, '\n});');
    const run = async (decoded) => {
      const res = { code: null, status(c) { this.code = c; return this; }, json() { return this; }, send() { return this; } };
      const sendErr = (r, e) => r.status(500).json({ error: e.message });
      const fn = new Function('requireAuth', 'isAdminUid', 'db', 'sendErr', `return async (req, res) => {${body}};`)(async () => decoded, isAdminUid, {}, sendErr);
      await fn({ method: 'POST', query: {}, body: {} }, res);
      return res.code;
    };
    for (const i of imposters.filter((x) => x.auth)) assert.equal(await run({ uid: i.auth.uid, ...i.auth.token }), 403, `${name} let through: ${i.label}`);
    assert.notEqual(await run({ uid: ADMIN_UID }), 403, `${name} refused the admin uid`);
  });
}

test('mutation check: with the shared helper reverted to the email check, a verified impostor DOES get through', async () => {
  const body = slice('async function requireAdmin(req) {', '\n}\n');
  const mutated = body.replace('!isAdminUid(decoded.uid)', "!ADMIN_EMAILS.includes((decoded.email || '').toLowerCase())");
  assert.notEqual(mutated, body, 'mutation did not apply');
  const gate = new Function('requireAuth', 'ADMIN_EMAILS', `return async (req) => {${mutated}};`)(
    async () => ({ uid: 'x2', email: 'austen@austensmith.com', email_verified: true }), ['austen@austensmith.com']);
  await gate({});
});
