// stripeWebhook + revenueCatWebhook — the real onRequest handlers, invoked
// directly (real Stripe signature verification, real RC auth-header check),
// not just their inner helpers. Scope per CTO split (docs/STABILIZATION.md
// row F6, stage 3): (a) lifecycle event-type coverage on both handlers,
// including redelivered non-purchase lifecycle events, (b) auth/rejection
// fails closed on both, (c) source-scoped merge never clobbers the other
// rail. Mobile owns resolvePlanFromRcEvent mapping + INITIAL_PURCHASE
// redelivery (test/rcMapping.test.js) — not duplicated here.
'use strict';
// Set BEFORE requiring index.js's handlers run any code path: this is the
// real CI-safety signal mirrorSubscriptionToUser checks before firing
// syncApptPlan's live cross-project call. A real CI runner invokes this
// suite the same way (NODE_ENV=test), so this line is what that guard is
// actually for, not just a convenience for one test below.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Stripe = require('stripe');
const mod = require('../index.js');
const { stripeWebhook, revenueCatWebhook, db, admin } = mod;

const STRIPE_SECRET = 'whsec_test_secret_for_suite';
const RC_SECRET = 'rc-shared-secret-for-suite';

// ── Fake Firestore: collection/doc/get/set/where (needed for
//    resolveUidFromCustomer's stripeCustomerId lookup) ──────────────────
function makeFakeDb(seedDocs) {
  const store = new Map();
  for (const [path, data] of Object.entries(seedDocs || {})) store.set(path, data);
  function docRef(name, id) { return { _path: `${name}/${id}`, _name: name, _id: id }; }
  return {
    collection(name) {
      return {
        doc(id) { return docRef(name, id); },
        where(field, op, value) {
          return {
            limit() { return this; },
            async get() {
              const docs = [];
              for (const [path, data] of store.entries()) {
                if (!path.startsWith(name + '/')) continue;
                if (op === '==' && data && data[field] === value) {
                  docs.push({ id: path.slice(name.length + 1), data: () => data });
                }
              }
              return { empty: docs.length === 0, docs };
            },
          };
        },
      };
    },
    async doc_get(ref) {
      const data = store.get(ref._path);
      return { exists: data !== undefined, data: () => data };
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
    _store: store,
  };
}
// db.collection(...).doc(...).get() and .set(...) are used directly (outside
// a transaction) by both webhook handlers for the legacy mirror fields.
// Patch doc refs with get/set bound to the fake store.
function wireDirectDocOps(fake) {
  const origCollection = fake.collection.bind(fake);
  fake.collection = (name) => {
    const c = origCollection(name);
    const origDoc = c.doc.bind(c);
    c.doc = (id) => {
      const ref = origDoc(id);
      ref.get = async () => fake.doc_get(ref);
      ref.set = async (data, opts) => {
        const existing = (opts && opts.merge) ? (fake._store.get(ref._path) || {}) : {};
        fake._store.set(ref._path, { ...existing, ...data });
      };
      return ref;
    };
    return c;
  };
  return fake;
}

async function withFakeDb(seedDocs, run) {
  const fake = wireDirectDocOps(makeFakeDb(seedDocs));
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

// ── Fake req/res for a Firebase v2 onRequest handler ────────────────────
function makeRes() {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(o) { this._json = o; this.emit('finish'); return this; },
    send(s) { this._sent = s; this.emit('finish'); return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
  });
}
function stripeReq(event, { badSig = false, noSig = false } = {}) {
  const payload = JSON.stringify(event);
  const headers = {};
  if (!noSig) {
    headers['stripe-signature'] = badSig
      ? 'garbled-not-a-real-signature'
      : Stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_SECRET });
  }
  return { method: 'POST', headers, rawBody: Buffer.from(payload), body: event };
}
// auth: omit the option entirely for the normal valid-secret header; pass
// `null` (not undefined -- default-parameter substitution would silently
// swap undefined back to RC_SECRET) to build a request with NO auth header.
function rcReq(event, opts) {
  const auth = (opts && 'auth' in opts) ? opts.auth : RC_SECRET;
  const headers = {};
  if (auth !== null) headers['authorization'] = auth;
  return { method: 'POST', headers, body: { event } };
}
async function callStripe(event, opts) {
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
  // getStripe() constructs a real Stripe client from STRIPE_SECRET_KEY before
  // signature verification even runs -- the SDK throws on an empty key, so
  // this must be set even though webhook verification itself never calls out.
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_suite';
  const res = makeRes();
  await stripeWebhook(stripeReq(event, opts), res);
  return res;
}
async function callRc(event, opts) {
  process.env.REVENUECAT_WEBHOOK_AUTH = RC_SECRET;
  const res = makeRes();
  await revenueCatWebhook(rcReq(event, opts), res);
  return res;
}

// ══════════════════════════ (a) RC LIFECYCLE EVENTS ══════════════════════

test('RC EXPIRATION: marks the apple rail expired; plan drops to free if apple was the only rail', async () => {
  await withFakeDb({ 'users/rc1': { apple: { status: 'active', tier: 'pro' } } }, async (fake) => {
    const res = await callRc({ type: 'EXPIRATION', app_user_id: 'rc1' });
    assert.equal(res.statusCode, 200);
    const u = fake._dump('users/rc1');
    assert.equal(u.apple.status, 'expired');
    assert.equal(u.plan, 'free');
  });
});

test('RC CANCELLATION: access continues (still active), only cancelAtPeriodEnd flips', async () => {
  await withFakeDb({ 'users/rc2': { apple: { status: 'active', tier: 'pro' } } }, async (fake) => {
    await callRc({ type: 'CANCELLATION', app_user_id: 'rc2' });
    const u = fake._dump('users/rc2');
    assert.equal(u.apple.status, 'active');
    assert.equal(u.apple.cancelAtPeriodEnd, true);
    assert.equal(u.plan, 'pro', 'canceling auto-renew must not revoke current access');
  });
});

test('RC PRODUCT_CHANGE: new tier lands via resolvePlanFromRcEvent', async () => {
  await withFakeDb({ 'users/rc3': { apple: { status: 'active', tier: 'scorecard' } } }, async (fake) => {
    await callRc({ type: 'PRODUCT_CHANGE', app_user_id: 'rc3', entitlement_ids: ['pro'] });
    const u = fake._dump('users/rc3');
    assert.equal(u.apple.tier, 'pro');
    assert.equal(u.plan, 'pro');
  });
});

test('RC BILLING_ISSUE: past_due, grace period keeps access', async () => {
  await withFakeDb({ 'users/rc4': { apple: { status: 'active', tier: 'scorecard' } } }, async (fake) => {
    await callRc({ type: 'BILLING_ISSUE', app_user_id: 'rc4' });
    const u = fake._dump('users/rc4');
    assert.equal(u.apple.status, 'past_due');
    assert.equal(u.plan, 'scorecard', 'past_due is still an ENTITLEMENT_ACTIVE status -- access must continue through the grace period');
  });
});

test('RC TRANSFER: treated as an active (re)purchase, same as PRODUCT_CHANGE/RENEWAL', async () => {
  await withFakeDb({ 'users/rc5': {} }, async (fake) => {
    await callRc({ type: 'TRANSFER', app_user_id: 'rc5', product_id: 'com.swh.scorecard.monthly' });
    const u = fake._dump('users/rc5');
    assert.equal(u.apple.status, 'active');
  });
});

test('RC redelivered EXPIRATION: processing the identical event twice converges, no double-transition', async () => {
  await withFakeDb({ 'users/rc6': { apple: { status: 'active', tier: 'pro' }, subscribedAt: '2026-01-01T00:00:00.000Z' } }, async (fake) => {
    const event = { type: 'EXPIRATION', app_user_id: 'rc6' };
    await callRc(event);
    const afterFirst = { ...fake._dump('users/rc6') };
    await callRc(event); // redelivery
    const afterSecond = fake._dump('users/rc6');
    assert.equal(afterSecond.apple.status, 'expired');
    assert.equal(afterSecond.plan, afterFirst.plan);
    assert.equal(afterSecond.subscribedAt, afterFirst.subscribedAt, 'a redelivered lifecycle event must not perturb an unrelated stamp');
  });
});

// ═══════════════════════ (a) STRIPE LIFECYCLE EVENTS ══════════════════════

test('Stripe customer.subscription.deleted (EXPIRATION-equivalent): stripe rail canceled, plan drops if it was the only rail', async () => {
  await withFakeDb({ 'users/sw1': { stripe: { status: 'active', tier: 'pro' } } }, async (fake) => {
    const res = await callStripe({
      id: 'evt_1', type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_1', metadata: { firebaseUid: 'sw1' } } },
    });
    assert.equal(res.statusCode, 200);
    const u = fake._dump('users/sw1');
    assert.equal(u.stripe.status, 'canceled');
    assert.equal(u.plan, 'free');
  });
});

test('Stripe customer.subscription.updated with cancel_at_period_end (CANCELLATION-equivalent): access continues', async () => {
  await withFakeDb({ 'users/sw2': {} }, async (fake) => {
    await callStripe({
      id: 'evt_2', type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_2', customer: 'cus_2', status: 'active', cancel_at_period_end: true,
        metadata: { firebaseUid: 'sw2' }, items: { data: [{ price: { id: 'price_scorecard' } }] },
      } },
    });
    const u = fake._dump('users/sw2');
    assert.equal(u.stripe.status, 'active');
    assert.equal(u.stripe.cancelAtPeriodEnd, true);
  });
});

test('Stripe customer.subscription.updated with a new price (PRODUCT_CHANGE-equivalent): tier follows the price map', async () => {
  // Deliberately asserts a DOWNGRADE (pro -> scorecard), not an upgrade to
  // pro, as defense-in-depth alongside the production NODE_ENV guard added
  // below: mirrorSubscriptionToUser fire-and-forgets a REAL cross-project
  // call (syncApptPlan -> admin.auth().getUser + a live fetch to
  // loaniq-75a20) whenever the resulting tier is 'pro' and status is
  // active/trialing. Downgrading proves the exact same price->tier mapping
  // mechanism without ever producing 'pro' as the output, so the
  // side-effect branch is never entered even if the guard below regressed.
  const swPriceToPlan = mod.STRIPE_PRICE_TO_PLAN;
  const scorecardPriceId = Object.keys(swPriceToPlan).find((k) => swPriceToPlan[k] === 'scorecard');
  await withFakeDb({ 'users/sw3': { plan: 'pro', stripe: { status: 'active', tier: 'pro' } } }, async (fake) => {
    await callStripe({
      id: 'evt_3', type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_3', customer: 'cus_3', status: 'active', cancel_at_period_end: false,
        metadata: { firebaseUid: 'sw3' }, items: { data: [{ price: { id: scorecardPriceId } }] },
      } },
    });
    const u = fake._dump('users/sw3');
    assert.equal(u.stripe.tier, 'scorecard');
    assert.equal(u.plan, 'scorecard');
  });
});

test('Stripe upgrade to pro+active under a test env: the live-infra guard actually prevents syncApptPlan, not just avoided by test design', async () => {
  // This deliberately lands on the exact stripeTier:'pro' + status:'active'
  // combination the PRODUCT_CHANGE test above avoids -- proving the
  // production NODE_ENV guard itself works, not merely that this suite is
  // careful not to trigger it. syncApptPlan's first operation is
  // admin.auth().getUser(uid); if the guard failed, that call would fire
  // for real. Spying on admin.auth (a property lookup on a shared object,
  // interceptable the same way db.collection is) proves it never does --
  // syncApptPlan itself is a bare-identifier call inside the module and
  // can't be spied on directly from outside.
  assert.equal(process.env.NODE_ENV, 'test', 'sanity check: the guard this test proves depends on this exact signal');
  const swPriceToPlan = mod.STRIPE_PRICE_TO_PLAN;
  const proPriceId = Object.keys(swPriceToPlan).find((k) => swPriceToPlan[k] === 'pro');
  await withFakeDb({ 'users/sw9': { plan: 'scorecard', stripe: { status: 'active', tier: 'scorecard' } } }, async (fake) => {
    // admin.auth is inherited from FirebaseNamespace's prototype as a
    // getter-only accessor, not a plain own/writable property -- a direct
    // assignment throws in strict mode, and there is no OWN descriptor to
    // capture (getOwnPropertyDescriptor on the instance returns undefined).
    // Object.defineProperty here adds an own property that shadows the
    // inherited getter; deleting it afterward correctly reveals the
    // original inherited behavior again.
    let authWasCalled = false;
    Object.defineProperty(admin, 'auth', {
      configurable: true,
      value: () => {
        authWasCalled = true;
        // If the guard regressed and this actually gets reached, fail loud
        // and immediately rather than let a stray promise dangle unobserved.
        throw new Error('admin.auth() was called -- the NODE_ENV test guard failed to prevent syncApptPlan');
      },
    });
    try {
      const res = await callStripe({
        id: 'evt_9', type: 'customer.subscription.updated',
        data: { object: {
          id: 'sub_9', customer: 'cus_9', status: 'active', cancel_at_period_end: false,
          metadata: { firebaseUid: 'sw9' }, items: { data: [{ price: { id: proPriceId } }] },
        } },
      });
      assert.equal(res.statusCode, 200, 'the webhook itself must still succeed -- only the side effect is skipped');
      assert.equal(authWasCalled, false, 'syncApptPlan (and its admin.auth() call) must never fire under a test env');
      const u = fake._dump('users/sw9');
      assert.equal(u.stripe.tier, 'pro', 'the guard must skip ONLY the fire-and-forget side effect, not the actual entitlement write');
      assert.equal(u.plan, 'pro');
    } finally {
      delete admin.auth;
    }
  });
});

test('Stripe invoice.payment_failed (BILLING_ISSUE-"equivalent"): pins the ACTUAL current asymmetry -- entitlement is untouched by this event alone', async () => {
  // FINDING, not asserted-as-bug: unlike RC's BILLING_ISSUE (which calls
  // applySourceUpdate and flips stripe.status -> 'past_due', keeping access
  // via ENTITLEMENT_ACTIVE), this handler only writes a top-level
  // subscriptionStatus display field. It never touches stripe.status, which
  // is the field computeEntitlement/isPaidState actually read. In production
  // this likely relies on Stripe ALSO firing a companion
  // customer.subscription.updated event to move the real entitlement state --
  // this test pins today's real behavior so that reliance is visible and
  // deliberate, not silently assumed.
  // plan:'pro' seeded explicitly -- it's only ever written by applySourceUpdate,
  // which this event never calls, so realistically it would already be set
  // from an earlier webhook. Omitting it here would test against nothing.
  await withFakeDb({ 'users/sw4': { plan: 'pro', stripe: { status: 'active', tier: 'pro' }, stripeCustomerId: 'cus_4' } }, async (fake) => {
    await callStripe({
      id: 'evt_4', type: 'invoice.payment_failed',
      data: { object: { id: 'in_4', customer: 'cus_4' } },
    });
    const u = fake._dump('users/sw4');
    assert.equal(u.subscriptionStatus, 'past_due', 'the display field IS updated');
    assert.equal(u.stripe.status, 'active', 'but stripe.status -- what entitlement actually reads -- is untouched by this event alone');
    assert.equal(u.plan, 'pro', 'so entitlement does not reflect the failed payment from this event by itself');
  });
});

// ═══════════════════════ (b) AUTH / REJECTION, FAIL CLOSED ═══════════════

test('stripeWebhook: invalid signature is rejected, 400, no write occurs', async () => {
  await withFakeDb({}, async (fake) => {
    const res = await callStripe(
      { id: 'evt_bad', type: 'customer.subscription.deleted', data: { object: { id: 'sub_x', customer: 'cus_x', metadata: { firebaseUid: 'badsig1' } } } },
      { badSig: true }
    );
    assert.equal(res.statusCode, 400);
    assert.equal(fake._dump('users/badsig1'), undefined, 'a bad signature must never reach the event handler');
  });
});

test('stripeWebhook: missing signature header entirely is rejected, 400, no write occurs', async () => {
  await withFakeDb({}, async (fake) => {
    const res = await callStripe(
      { id: 'evt_nosig', type: 'customer.subscription.deleted', data: { object: { id: 'sub_y', customer: 'cus_y', metadata: { firebaseUid: 'nosig1' } } } },
      { noSig: true }
    );
    assert.equal(res.statusCode, 400);
    assert.equal(fake._dump('users/nosig1'), undefined);
  });
});

test('revenueCatWebhook: wrong auth header is rejected, 401, no write occurs', async () => {
  await withFakeDb({}, async (fake) => {
    const res = await callRc({ type: 'EXPIRATION', app_user_id: 'rcauth1' }, { auth: 'totally-wrong-secret' });
    assert.equal(res.statusCode, 401);
    assert.equal(fake._dump('users/rcauth1'), undefined);
  });
});

test('revenueCatWebhook: missing auth header entirely is rejected, 401, no write occurs', async () => {
  await withFakeDb({}, async (fake) => {
    const res = await callRc({ type: 'EXPIRATION', app_user_id: 'rcauth2' }, { auth: null });
    assert.equal(res.statusCode, 401);
    assert.equal(fake._dump('users/rcauth2'), undefined);
  });
});

test('revenueCatWebhook: an UNSET shared secret fails closed even against an empty auth header (misconfiguration must not accidentally open the gate)', async () => {
  await withFakeDb({}, async (fake) => {
    delete process.env.REVENUECAT_WEBHOOK_AUTH; // simulate the secret never having been configured
    const res = makeRes();
    await revenueCatWebhook({ method: 'POST', headers: { authorization: '' }, body: { event: { type: 'EXPIRATION', app_user_id: 'rcauth3' } } }, res);
    assert.equal(res.statusCode, 401, 'empty-equals-empty must not be treated as a match');
    assert.equal(fake._dump('users/rcauth3'), undefined);
  });
});

// ═══════════════════ (c) SOURCE-SCOPED MERGE, AT THE HANDLER LEVEL ═══════

test('RC event for the apple rail never clobbers an existing stripe rail (and doubleBilling flips true)', async () => {
  await withFakeDb({
    'users/x1': { stripe: { status: 'active', tier: 'scorecard', customerId: 'cus_keep_me' } },
  }, async (fake) => {
    await callRc({ type: 'RENEWAL', app_user_id: 'x1', entitlement_ids: ['pro'] });
    const u = fake._dump('users/x1');
    assert.equal(u.stripe.customerId, 'cus_keep_me', 'the stripe rail must survive an apple-rail webhook untouched');
    assert.equal(u.stripe.tier, 'scorecard');
    assert.equal(u.apple.status, 'active');
    assert.equal(u.doubleBilling, true);
  });
});

test('Stripe event for the stripe rail never clobbers an existing apple rail', async () => {
  await withFakeDb({
    'users/x2': { apple: { status: 'active', tier: 'scorecard', originalTransactionId: 'txn_keep_me' } },
  }, async (fake) => {
    await callStripe({
      id: 'evt_x2', type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_x2', customer: 'cus_x2', status: 'active', cancel_at_period_end: false,
        metadata: { firebaseUid: 'x2' }, items: { data: [{ price: { id: 'price_scorecard' } }] },
      } },
    });
    const u = fake._dump('users/x2');
    assert.equal(u.apple.originalTransactionId, 'txn_keep_me', 'the apple rail must survive a stripe-rail webhook untouched');
    assert.equal(u.apple.status, 'active');
    assert.equal(u.stripe.status, 'active');
    assert.equal(u.doubleBilling, true);
  });
});
