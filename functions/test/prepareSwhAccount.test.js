// prepareSwhAccountForUser (2026-10-08): source-level checks, matching this
// suite's style for index.js (which can't be required without secrets).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const body = src.slice(src.indexOf('exports.prepareSwhAccountForUser'), src.indexOf('/** Mirror of public-crm/index.html'));

test('bearer secret is checked before anything is created', () => {
  assert.ok(body.indexOf("return res.status(401)") > 0);
  assert.ok(body.indexOf("return res.status(401)") < body.indexOf('getOrProvisionSwhUser('));
});

test('provisions as the fixed mylola-welcome via (a comped scorecard, never pro)', () => {
  assert.match(body, /getOrProvisionSwhUser\(email, PREPARE_VIA\)/);
  assert.match(src, /const PREPARE_VIA = 'mylola-welcome';/);
  assert.doesNotMatch(body, /rawVia|req\.body\.via|\bvia\b:/);
});

test('returns a link only: no custom token, and the link is never logged', () => {
  assert.doesNotMatch(body, /createCustomToken/);
  for (const line of body.split('\n').filter((l) => l.includes('console.'))) assert.doesNotMatch(line, /link/);
});

test('the link opens on app.stopwastinghandshakes.com with the same query', () => {
  const fnSrc = src.slice(src.indexOf('function swhBrandedResetLink'), src.indexOf('exports.prepareSwhAccountForUser'));
  const swhBrandedResetLink = new Function(`${fnSrc}; return swhBrandedResetLink;`)();
  assert.equal(
    swhBrandedResetLink('https://swh-scoreboard.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=Q%2B1&apiKey=k&lang=en'),
    'https://app.stopwastinghandshakes.com/__/auth/action?mode=resetPassword&oobCode=Q%2B1&apiKey=k&lang=en');
});
