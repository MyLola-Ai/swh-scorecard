// voiceProfileFor -- the AI email-drafting system prompt, extracted.
//
// THE BUG (found live, 2026-08-31, Tony Cubbage): this prompt was written
// as a plain constant hardcoding "Austen Smith" -- the framing line ("AS
// Austen Smith"), the sign-off rotation, and all three worked examples all
// ended "Thanks, / Austen" verbatim. It went unnoticed because Austen was
// the only real user for months, and every caller's OWN fallback (now also
// fixed) was ALSO literally 'Austen' -- so the two bugs canceled out during
// all prior testing. The moment a second real user's account (correctly
// resolving displayName to "Tony Cubbage" from all three of Firestore's
// root doc, config/settings, AND the Firebase Auth record itself) hit this
// prompt, the model did exactly what the SYSTEM prompt told it: sign the
// email "Thanks, Austen" -- overriding the much weaker "My name: Tony" line
// buried in the user message. Tony's own words: "Your name is on my eighth
// step process."
//
// These tests exist to make sure a future edit to this prompt can't
// silently reintroduce a hardcoded name anywhere in it -- the "no literal
// Austen anywhere" test is the one that actually catches the original bug;
// everything else is supporting detail.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const startMarker = 'function voiceProfileFor(userFirstName, userFullName) {';
const startIdx = src.indexOf(startMarker);
assert.ok(startIdx !== -1, 'voiceProfileFor not found');
const bodyStart = startIdx + startMarker.length;
const endIdx = src.indexOf('\n}', bodyStart);
assert.ok(endIdx !== -1, 'function end not found');
const bodySrc = src.slice(bodyStart, endIdx);
const voiceProfileFor = new Function('userFirstName', 'userFullName', bodySrc);

test('the framing line names the actual caller, not a fixed identity', () => {
  const p = voiceProfileFor('Tony', 'Tony Cubbage');
  assert.ok(p.includes('AS Tony Cubbage'), 'must frame the draft as being written by the real user');
  assert.ok(p.includes('like Tony personally typed it'), 'must reference the real first name in the "read like X typed it" line');
});

test('the sign-off rotation offers the real first name in every variant, including the bare-name option', () => {
  const p = voiceProfileFor('Tony', 'Tony Cubbage');
  assert.ok(p.includes('"Thanks, Tony"'));
  assert.ok(p.includes('"Chat soon, Tony"'));
  assert.ok(p.includes('"Talk soon, Tony"'));
  assert.ok(p.includes('just "Tony."'), 'the bare-name sign-off option must also use the real name');
  assert.ok(p.includes('"Thanks, Tony Cubbage."'), 'the formal first-touch variant needs the real full name, not just the first');
});

test('all three worked examples sign off with the real name, not a fixed one', () => {
  const p = voiceProfileFor('Tony', 'Tony Cubbage');
  const signoffCount = (p.match(/\nTony\b/g) || []).length;
  assert.equal(signoffCount, 3, 'expected exactly the three worked-example sign-offs to carry the real name');
});

// THE test. Everything above could pass while a stray hardcoded "Austen"
// still lingers somewhere else in the prompt (a fourth example added later,
// a stray reference in the guidance prose) -- this is what actually
// guarantees the fix is complete, not just partially applied.
test('the generated prompt never contains the literal name "Austen" when drafting for someone else', () => {
  const p = voiceProfileFor('Tony', 'Tony Cubbage');
  assert.ok(!p.includes('Austen'), 'a prompt drafted for Tony must not mention Austen anywhere, including in the sign-off examples');
});

test('still produces a correct, working prompt when the caller genuinely is Austen', () => {
  const p = voiceProfileFor('Austen', 'Austen Smith');
  assert.ok(p.includes('AS Austen Smith'));
  assert.ok(p.includes('"Thanks, Austen"'));
  const signoffCount = (p.match(/\nAusten\b/g) || []).length;
  assert.equal(signoffCount, 3);
});

test('falls back to a neutral, non-identifying placeholder rather than a specific wrong name when no name is available', () => {
  const p = voiceProfileFor('there', 'there');
  assert.ok(!p.includes('Austen'), 'an unresolvable name must never fall back to a specific real person\'s name');
  assert.ok(p.includes('AS there') || p.includes('like there personally typed'), 'sanity check that the fallback value actually flows through');
});

// Mutation check: prove the "no Austen" test is load-bearing, not
// vacuously passing. Re-run the exact bug (one hardcoded sign-off
// reintroduced) and confirm the dedicated test above would have caught it.
test('mutation check: reintroducing a single hardcoded "Austen" sign-off is caught', () => {
  const mutatedSrc = bodySrc.replace(
    'Thanks,\n${userFirstName}\n\nEXAMPLE (value, no ask):',
    'Thanks,\nAusten\n\nEXAMPLE (value, no ask):'
  );
  assert.notEqual(mutatedSrc, bodySrc, 'the replacement target must actually exist in the source, or this proves nothing');
  const mutatedFn = new Function('userFirstName', 'userFullName', mutatedSrc);
  const p = mutatedFn('Tony', 'Tony Cubbage');
  assert.ok(p.includes('Austen'), 'sanity check that the mutation actually reintroduced the bug');
});
