// swhApptWelcome (2026-10-09): source-level checks, matching this suite's style.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const body = src.slice(src.indexOf('exports.swhApptWelcome'), src.indexOf('/** Mirror of public-crm/index.html'));
const helpers = src.slice(src.indexOf('const APPT_WELCOME'), src.indexOf('exports.swhApptWelcome'));

test('bearer secret checked before anything else', () => {
  assert.ok(body.indexOf("return res.status(401)") > 0);
  for (const a of ["action === 'one'", "action === 'mark'", 'swhAllUsers()']) assert.ok(body.indexOf("return res.status(401)") < body.indexOf(a), a);
});
test('a link is only issued for an account whose email IS the SWH user\'s email', () => {
  assert.match(helpers, /if \(\(acct\.email \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== email\) return null;/);
  assert.ok(helpers.indexOf('!== email) return null;') < helpers.indexOf('generatePasswordResetLink(el.email)'));
});
test('skips test identities and accounts provisioned for MyLola/MyClosings (except a test to the operator)', () => {
  assert.match(helpers, /if \(isNonMailableAccount\(email\)\) return \{ ok: false, reason: 'test-account' \};/);
  assert.match(helpers, /if \(!forTest && doc\.exists && doc\.data\(\)\.provisionedVia\)/);
});
test('links are never logged; no custom token', () => {
  assert.doesNotMatch(body + helpers, /createCustomToken/);
  for (const line of (body + helpers).split('\n').filter((l) => l.includes('console.'))) assert.doesNotMatch(line, /link/i);
});
test('the branded link keeps only the one-time code, on myappointment.ai', () => {
  const fnSrc = helpers.slice(helpers.indexOf('function apptBrandedResetLink'), helpers.indexOf('async function swhApptEligible'));
  const f = new Function(`${fnSrc}; return apptBrandedResetLink;`)();
  assert.equal(f('https://myappointment-ai-8756e.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=Q%2B1&apiKey=k'), 'https://myappointment.ai/auth/action?mode=resetPassword&oobCode=Q%2B1');
});
test('next reserves before returning, so two runs cannot double-send', () => {
  const next = body.slice(body.indexOf("if (action === 'next')"));
  assert.ok(next.indexOf('reservedAt: now') < next.indexOf('items.push(it)'));
});
