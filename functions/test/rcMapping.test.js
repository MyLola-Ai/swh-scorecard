// RevenueCat event -> internal plan mapping (F4 hardening). Pure function,
// no mocking needed. Companion to entitlement.test.js (computeEntitlement,
// isPaidState) and applySourceUpdate.test.js — this file covers the one
// piece those don't: turning an RC webhook event into a plan value.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePlanFromRcEvent, REVENUECAT_ENTITLEMENTS, REVENUECAT_PRODUCTS,
} = require('../index.js');

test('resolvePlanFromRcEvent: entitlement_ids preferred over product_id when both present', () => {
  const plan = resolvePlanFromRcEvent({
    entitlement_ids: ['crm'],
    product_id: 'com.impactleadershipgroup.swh.scorecard.monthly',
  });
  assert.equal(plan, 'pro');
});

test('resolvePlanFromRcEvent: single entitlement_id string form is also read', () => {
  const plan = resolvePlanFromRcEvent({ entitlement_id: 'scorecard' });
  assert.equal(plan, 'scorecard');
});

test('resolvePlanFromRcEvent: falls back to product_id when entitlement_ids is empty', () => {
  const plan = resolvePlanFromRcEvent({
    entitlement_ids: [],
    product_id: 'com.impactleadershipgroup.swh.crm.monthly',
  });
  assert.equal(plan, 'pro');
});

test('resolvePlanFromRcEvent: falls back to product_id when entitlement_ids is absent entirely', () => {
  const plan = resolvePlanFromRcEvent({ product_id: 'com.impactleadershipgroup.swh.scorecard.monthly' });
  assert.equal(plan, 'scorecard');
});

test('resolvePlanFromRcEvent: unrecognized entitlement + unrecognized product -> default lower tier, never higher', () => {
  // Fail-safe direction matters: an unmapped event must never accidentally
  // grant the more expensive tier.
  assert.equal(resolvePlanFromRcEvent({ entitlement_ids: ['something_new'], product_id: 'unknown.product' }), 'scorecard');
});

test('resolvePlanFromRcEvent: completely empty event -> default lower tier', () => {
  assert.equal(resolvePlanFromRcEvent({}), 'scorecard');
});

test('REVENUECAT_ENTITLEMENTS: both "crm" and "pro" entitlement IDs map to the pro plan', () => {
  // RC dashboard naming has drifted between "crm" and "pro" historically —
  // this pins that both spellings resolve identically, not just one.
  assert.equal(REVENUECAT_ENTITLEMENTS.crm, 'pro');
  assert.equal(REVENUECAT_ENTITLEMENTS.pro, 'pro');
  assert.equal(REVENUECAT_ENTITLEMENTS.scorecard, 'scorecard');
});

test('REVENUECAT_PRODUCTS: known App Store Connect product IDs map to the right tier', () => {
  assert.equal(REVENUECAT_PRODUCTS['com.impactleadershipgroup.swh.scorecard.monthly'], 'scorecard');
  assert.equal(REVENUECAT_PRODUCTS['com.impactleadershipgroup.swh.crm.monthly'], 'pro');
});
