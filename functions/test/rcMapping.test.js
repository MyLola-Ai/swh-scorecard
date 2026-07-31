// RevenueCat event -> internal plan mapping (F4 hardening). Pure function,
// no mocking needed. Companion to entitlement.test.js (computeEntitlement,
// isPaidState) and applySourceUpdate.test.js — this file covers the one
// piece those don't: turning an RC webhook event into a plan value.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../index.js');
const {
  resolvePlanFromRcEvent, REVENUECAT_ENTITLEMENTS, REVENUECAT_PRODUCTS,
  applySourceUpdate, db,
} = mod;

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

// ── Redelivery / idempotency, scoped to the INITIAL_PURCHASE mapping path
//    (F4 register condition, CTO-ruled split: this axis is mine; lifecycle
//    event-type redelivery — CANCELLATION/EXPIRATION/etc — is SWH's, in
//    applySourceUpdate.test.js). A minimal local fake-db, not shared with
//    theirs — each file owns its own fixtures per the "clean axes, no
//    overlap" ruling. db.collection/db.runTransaction are swapped for the
//    duration of one test and restored even on failure. ──

function makeFakeDb(seedDocs) {
  const store = new Map();
  for (const [path, data] of Object.entries(seedDocs || {})) store.set(path, data);
  return {
    collection(name) {
      return { doc(id) { return { _path: `${name}/${id}` }; } };
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          const data = store.get(ref._path);
          return { exists: data !== undefined, data: () => data };
        },
        set(ref, data, opts) {
          const existing = (opts && opts.merge) ? (store.get(ref._path) || {}) : {};
          store.set(ref._path, { ...existing, ...data });
        },
      };
      return fn(tx);
    },
    _dump(path) { return store.get(path); },
  };
}

async function withFakeDb(seedDocs, run) {
  const fake = makeFakeDb(seedDocs);
  const realCollection = db.collection;
  const realRunTransaction = db.runTransaction;
  db.collection = fake.collection;
  db.runTransaction = fake.runTransaction.bind(fake);
  try {
    await run(fake);
  } finally {
    db.collection = realCollection;
    db.runTransaction = realRunTransaction;
  }
}

// Mirrors exactly what revenueCatWebhook's INITIAL_PURCHASE case builds
// (functions/index.js, exports.revenueCatWebhook) — the patch this test
// exercises is the real shape, not a stand-in.
function buildInitialPurchaseApplePatch(event) {
  const periodEndSec = event.expiration_at_ms ? Math.floor(event.expiration_at_ms / 1000) : null;
  const patch = {
    status: 'active',
    tier: resolvePlanFromRcEvent(event),
    productId: event.product_id || null,
    originalTransactionId: event.original_transaction_id || null,
    currentPeriodEnd: periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null,
    cancelAtPeriodEnd: false,
  };
  if (event.offer_code) patch.offerCode = event.offer_code;
  return patch;
}

test('INITIAL_PURCHASE redelivery: same RC event applied twice does not re-stamp subscribedAt', async () => {
  const event = {
    entitlement_ids: ['scorecard'],
    product_id: 'com.impactleadershipgroup.swh.scorecard.monthly',
    original_transaction_id: 'txn-123',
    expiration_at_ms: Date.parse('2026-09-01T00:00:00.000Z'),
  };
  await withFakeDb({ 'users/u1': {} }, async (fake) => {
    await applySourceUpdate('u1', 'apple', buildInitialPurchaseApplePatch(event));
    const afterFirst = fake._dump('users/u1');
    assert.ok(afterFirst.subscribedAt, 'expected subscribedAt to be stamped on the real first delivery');
    assert.equal(afterFirst.plan, 'scorecard');

    // RC redelivers the IDENTICAL event (retry after our 200 got lost, e.g.).
    await applySourceUpdate('u1', 'apple', buildInitialPurchaseApplePatch(event));
    const afterRedelivery = fake._dump('users/u1');

    assert.equal(afterRedelivery.subscribedAt, afterFirst.subscribedAt, 'redelivery must NOT move subscribedAt');
    assert.equal(afterRedelivery.plan, afterFirst.plan, 'plan must stay converged across redelivery');
    assert.equal(afterRedelivery.doubleBilling, afterFirst.doubleBilling, 'doubleBilling must stay converged across redelivery');
    assert.equal(afterRedelivery.apple.originalTransactionId, 'txn-123');
  });
});

test('INITIAL_PURCHASE redelivery: a genuinely later event (new expiration) still does not re-stamp subscribedAt', async () => {
  // Distinguishes "redelivery of the same event" from "a real subsequent
  // event on the same source" — only the FIRST paid transition ever stamps.
  const first = {
    entitlement_ids: ['scorecard'], product_id: 'com.impactleadershipgroup.swh.scorecard.monthly',
    original_transaction_id: 'txn-456', expiration_at_ms: Date.parse('2026-09-01T00:00:00.000Z'),
  };
  const renewal = { ...first, expiration_at_ms: Date.parse('2026-10-01T00:00:00.000Z') };
  await withFakeDb({ 'users/u2': {} }, async (fake) => {
    await applySourceUpdate('u2', 'apple', buildInitialPurchaseApplePatch(first));
    const stampedAt = fake._dump('users/u2').subscribedAt;

    await applySourceUpdate('u2', 'apple', buildInitialPurchaseApplePatch(renewal));
    const after = fake._dump('users/u2');

    assert.equal(after.subscribedAt, stampedAt, 'a later renewal must not move the original stamp');
    assert.equal(after.apple.currentPeriodEnd, new Date(renewal.expiration_at_ms).toISOString(), 'the period end itself SHOULD update');
  });
});
