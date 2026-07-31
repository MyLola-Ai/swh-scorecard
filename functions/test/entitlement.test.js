// Entitlement/plan resolution — the core of the money paths. Pure functions,
// no mocking needed. See docs/STABILIZATION.md row F4 (test-coverage audit).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeEntitlement, isPaidState, TRIAL_TIER,
} = require('../index.js');

const future = () => new Date(Date.now() + 7 * 86400000).toISOString();
const past = () => new Date(Date.now() - 7 * 86400000).toISOString();

test('computeEntitlement: planOverride short-circuits everything else', () => {
  const { plan, entitlement } = computeEntitlement({ planOverride: 'pro', apple: { status: 'active' } });
  assert.equal(plan, 'pro');
  assert.equal(entitlement.source, 'override');
  assert.equal(entitlement.doubleBilling, false);
});

test('computeEntitlement: an unrecognized planOverride does NOT short-circuit', () => {
  const { plan, entitlement } = computeEntitlement({ planOverride: 'bogus-tier' });
  assert.equal(plan, 'free');
  assert.equal(entitlement.source, 'none');
});

test('computeEntitlement: legacy doc, no plan field at all -> free', () => {
  const { plan, entitlement } = computeEntitlement({});
  assert.equal(plan, 'free');
  assert.equal(entitlement.source, 'none');
});

test('computeEntitlement: legacy doc, active trial -> TRIAL_TIER', () => {
  const { plan, entitlement } = computeEntitlement({ plan: 'trial', trialEndsAt: future() });
  assert.equal(plan, TRIAL_TIER);
  assert.equal(entitlement.source, 'trial');
  assert.ok(entitlement.trialEndsAt);
});

test('computeEntitlement: legacy doc, EXPIRED trial -> free, not the trial tier', () => {
  const { plan, entitlement } = computeEntitlement({ plan: 'trial', trialEndsAt: past() });
  assert.equal(plan, 'free');
  assert.equal(entitlement.source, 'none');
  assert.equal(entitlement.trialEndsAt, null);
});

test('computeEntitlement: legacy doc, an arbitrary paid plan value -> passed through, source legacy', () => {
  const { plan, entitlement } = computeEntitlement({ plan: 'scorecard' });
  assert.equal(plan, 'scorecard');
  assert.equal(entitlement.source, 'legacy');
});

test('computeEntitlement: scoped, stripe active alone', () => {
  const { plan, entitlement } = computeEntitlement({ stripe: { status: 'active', tier: 'pro' } });
  assert.equal(plan, 'pro');
  assert.equal(entitlement.source, 'stripe');
  assert.equal(entitlement.doubleBilling, false);
});

test('computeEntitlement: scoped, apple active alone', () => {
  const { plan, entitlement } = computeEntitlement({ apple: { status: 'active', tier: 'scorecard' } });
  assert.equal(plan, 'scorecard');
  assert.equal(entitlement.source, 'apple');
  assert.equal(entitlement.doubleBilling, false);
});

test('computeEntitlement: BOTH apple and stripe active at once -> doubleBilling true, higher tier wins', () => {
  const { plan, entitlement } = computeEntitlement({
    apple: { status: 'active', tier: 'scorecard' },
    stripe: { status: 'active', tier: 'pro' },
  });
  assert.equal(plan, 'pro');
  assert.equal(entitlement.doubleBilling, true);
  assert.equal(entitlement.source, 'apple+stripe');
});

test('computeEntitlement: an inactive rail does not count toward doubleBilling', () => {
  const { plan, entitlement } = computeEntitlement({
    apple: { status: 'canceled', tier: 'scorecard' },
    stripe: { status: 'active', tier: 'pro' },
  });
  assert.equal(plan, 'pro');
  assert.equal(entitlement.doubleBilling, false);
  assert.equal(entitlement.source, 'stripe');
});

test('computeEntitlement: a live trial can outrank a lower-tier active paid rail', () => {
  // TRIAL_TIER is 'pro' (top rank) — a scorecard subscriber mid-trial still
  // reads as 'pro' access. Real, slightly non-obvious behavior worth pinning.
  const { plan, entitlement } = computeEntitlement({
    apple: { status: 'active', tier: 'scorecard' },
    trial: { endsAt: future() },
  });
  assert.equal(plan, 'pro');
  assert.equal(entitlement.source, 'apple+trial');
});

test('computeEntitlement: Apple "trialing" status counts as an active source here (unlike isPaidState)', () => {
  const { plan, entitlement } = computeEntitlement({ apple: { status: 'trialing', tier: 'scorecard' } });
  assert.equal(plan, 'scorecard');
  assert.equal(entitlement.source, 'apple');
});

test('computeEntitlement: scoped doc but nothing actually active -> free, source none', () => {
  const { plan, entitlement } = computeEntitlement({
    apple: { status: 'canceled', tier: 'scorecard' },
    stripe: { status: 'incomplete_expired', tier: 'pro' },
  });
  assert.equal(plan, 'free');
  assert.equal(entitlement.source, 'none');
});

// ── isPaidState — the CFO conversion signal. Deliberately narrower than
//    ENTITLEMENT_ACTIVE: 'trialing' grants product access but is NOT a sale. ──

test('isPaidState: no user -> false', () => {
  assert.equal(isPaidState(null), false);
  assert.equal(isPaidState(undefined), false);
});

test('isPaidState: empty user -> false', () => {
  assert.equal(isPaidState({}), false);
});

test('isPaidState: apple active -> true', () => {
  assert.equal(isPaidState({ apple: { status: 'active' } }), true);
});

test('isPaidState: apple past_due -> true (paid then failed still counts as a conversion)', () => {
  assert.equal(isPaidState({ apple: { status: 'past_due' } }), true);
});

test('isPaidState: apple trialing -> false (grants access, is NOT revenue)', () => {
  assert.equal(isPaidState({ apple: { status: 'trialing' } }), false);
});

test('isPaidState: stripe active -> true', () => {
  assert.equal(isPaidState({ stripe: { status: 'active' } }), true);
});

test('isPaidState: stripe past_due -> true', () => {
  assert.equal(isPaidState({ stripe: { status: 'past_due' } }), true);
});

test('isPaidState: stripe trialing -> false', () => {
  assert.equal(isPaidState({ stripe: { status: 'trialing' } }), false);
});

test('isPaidState: both rails present but neither in a paid status -> false', () => {
  assert.equal(isPaidState({ apple: { status: 'canceled' }, stripe: { status: 'trialing' } }), false);
});

test('isPaidState: one active, one canceled -> true (OR, not AND)', () => {
  assert.equal(isPaidState({ apple: { status: 'canceled' }, stripe: { status: 'active' } }), true);
});
