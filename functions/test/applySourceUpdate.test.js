// applySourceUpdate — the webhook-side transactional merge that stamps a
// user's first paid conversion (subscribedAt) for the CFO's metrics. Tested
// against a lightweight in-memory Firestore double, not a real emulator:
// the value here is pinning applySourceUpdate's OWN guard/merge logic, not
// re-proving Firestore's transaction semantics. See docs/STABILIZATION.md
// row F6 (test-coverage audit), stage 2 of the PM-approved scoping.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../index.js');
const { applySourceUpdate, db } = mod;

// Minimal double for the exact surface applySourceUpdate touches:
// db.collection(name).doc(id) -> ref; db.runTransaction(fn) -> fn({get, set}).
// tx.set(ref, data, {merge:true}) shallow-merges onto whatever is already
// stored for that ref, matching real Firestore transaction.set-with-merge.
function makeFakeDb(seedDocs) {
  const store = new Map(); // ref path -> doc data
  for (const [path, data] of Object.entries(seedDocs || {})) store.set(path, data);
  return {
    collection(name) {
      return {
        doc(id) {
          const path = `${name}/${id}`;
          return { _path: path };
        },
      };
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

// Swap the module's real db for a fake one for the duration of one test,
// then restore it — never touches real Firestore, and the real client is
// always back in place before the next test runs, even on assertion failure.
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

test('applySourceUpdate: first paid transition stamps subscribedAt', async () => {
  await withFakeDb({ 'users/u1': { stripe: { status: 'incomplete' } } }, async (fake) => {
    await applySourceUpdate('u1', 'stripe', { status: 'active', tier: 'pro' });
    const written = fake._dump('users/u1');
    assert.equal(written.plan, 'pro');
    assert.ok(written.subscribedAt, 'expected subscribedAt to be stamped on first paid transition');
    assert.equal(written.doubleBilling, false);
  });
});

test('applySourceUpdate: already-paid user getting a renewal does NOT re-stamp subscribedAt', async () => {
  const original = '2026-01-01T00:00:00.000Z';
  await withFakeDb({
    'users/u2': { stripe: { status: 'active', tier: 'pro' }, subscribedAt: original },
  }, async (fake) => {
    await applySourceUpdate('u2', 'stripe', { status: 'active', tier: 'pro', currentPeriodEnd: '2026-09-01' });
    const written = fake._dump('users/u2');
    // The guard must not fire (already paid before this update), so `write`
    // carries no subscribedAt key at all -- merge:true then leaves the
    // EXISTING stamp exactly as it was, it does not blank it out.
    assert.equal(written.subscribedAt, original, 'the original stamp must survive untouched, not get erased or replaced');
  });
});

test('applySourceUpdate: historical subscriber (already paid, never stamped) stays UNSTAMPED — by design', async () => {
  // The exact case the guard comment calls out: a missing value beats a
  // wrong one, so a pre-existing paid user with no subscribedAt field must
  // NOT get back-stamped with today's date on a later webhook write.
  await withFakeDb({ 'users/u3': { apple: { status: 'active', tier: 'scorecard' } } }, async (fake) => {
    await applySourceUpdate('u3', 'apple', { status: 'active', tier: 'scorecard', currentPeriodEnd: '2026-10-01' });
    const written = fake._dump('users/u3');
    assert.equal(written.subscribedAt, undefined, 'a user already paid before this update must never get back-stamped');
  });
});

test('applySourceUpdate: a transition that does not cross into paid never stamps', async () => {
  await withFakeDb({ 'users/u4': {} }, async (fake) => {
    await applySourceUpdate('u4', 'stripe', { status: 'trialing', tier: 'pro' });
    const written = fake._dump('users/u4');
    assert.equal(written.plan, 'pro'); // trialing grants access...
    assert.equal(written.subscribedAt, undefined); // ...but is not a sale
  });
});

test('applySourceUpdate: both rails active after this update -> doubleBilling true', async () => {
  await withFakeDb({ 'users/u5': { apple: { status: 'active', tier: 'scorecard' } } }, async (fake) => {
    await applySourceUpdate('u5', 'stripe', { status: 'active', tier: 'pro' });
    const written = fake._dump('users/u5');
    assert.equal(written.doubleBilling, true);
    assert.equal(written.plan, 'pro');
  });
});

test('applySourceUpdate: source merge preserves untouched fields on the same rail', async () => {
  await withFakeDb({
    'users/u6': { stripe: { status: 'active', tier: 'scorecard', customerId: 'cus_123' } },
  }, async (fake) => {
    await applySourceUpdate('u6', 'stripe', { status: 'active', tier: 'pro' });
    const written = fake._dump('users/u6');
    assert.equal(written.stripe.customerId, 'cus_123', 'a field not present in the patch must survive the merge');
    assert.equal(written.stripe.tier, 'pro');
  });
});

test('applySourceUpdate: brand-new user document (no prior doc at all)', async () => {
  await withFakeDb({}, async (fake) => {
    await applySourceUpdate('u7', 'apple', { status: 'active', tier: 'scorecard' });
    const written = fake._dump('users/u7');
    assert.equal(written.plan, 'scorecard');
    assert.ok(written.subscribedAt);
  });
});
