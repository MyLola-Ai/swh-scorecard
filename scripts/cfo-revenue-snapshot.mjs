#!/usr/bin/env node
// CFO revenue snapshot — spec'd by the CFO thread 2026-07-19.
// Reads Firestore (swh-scoreboard) via the local firebase-tools session and
// prints a markdown report. Sections: (1) subscribers by plan×status×rail,
// (2) trial cohorts by source + 7-day conversion, (3) ATX100 redemptions,
// (4) team seats. Run: node scripts/cfo-revenue-snapshot.mjs [--weekly]
import { readFileSync } from 'fs';
import { homedir } from 'os';

const WEEKLY = process.argv.includes('--weekly');
const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, 'utf8'));
const tokRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cfg.tokens.refresh_token,
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
  }),
});
// A failed token exchange must be FATAL, not silently become an empty scan
// (2026-07-27 incident: an auth failure here previously produced a clean
// "0 users" report instead of a crash — nothing downstream checked status).
if (!tokRes.ok) {
  const body = await tokRes.text().catch(() => '(unreadable body)');
  throw new Error(`token exchange failed: HTTP ${tokRes.status} — ${body}`);
}
const AT = (await tokRes.json()).access_token;
if (!AT) throw new Error('token exchange succeeded but returned no access_token');
const FS = 'https://firestore.googleapis.com/v1/projects/swh-scoreboard/databases/(default)/documents';

// Every Firestore call funnels through here so a bad status always throws —
// the historical bug was each call site parsing .json() directly and never
// checking res.ok, so an auth/quota error silently became "zero rows."
async function firestoreRunQuery(body) {
  const res = await fetch(`${FS.replace(/\/documents$/, '')}/documents:runQuery`, {
    method: 'POST', headers: { Authorization: `Bearer ${AT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '(unreadable body)');
    throw new Error(`Firestore runQuery failed: HTTP ${res.status} — ${errBody}`);
  }
  const parsed = await res.json();
  if (!Array.isArray(parsed)) {
    throw new Error(`Firestore runQuery returned a non-array body (likely an error payload): ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

async function runQuery(collection, pageToken) {
  // Paginated structuredQuery scan of a whole collection.
  const body = { structuredQuery: { from: [{ collectionId: collection }], limit: 300 } };
  if (pageToken) body.structuredQuery.startAt = pageToken;
  return firestoreRunQuery(body);
}

const val = (f, k) => {
  const v = f && f[k];
  if (!v) return undefined;
  return v.stringValue ?? v.booleanValue ?? (v.integerValue !== undefined ? Number(v.integerValue) : undefined) ?? v.doubleValue;
};

// Full scan with cursor pagination (fine at current scale; revisit >10k users).
async function scanAll(collection) {
  const docs = [];
  let last = null;
  for (;;) {
    const body = { structuredQuery: { from: [{ collectionId: collection }], orderBy: [{ field: { fieldPath: '__name__' } }], limit: 300 } };
    if (last) body.structuredQuery.startAt = { values: [{ referenceValue: last }], before: false };
    const parsed = await firestoreRunQuery(body);
    const rows = parsed.filter(r => r.document);
    if (!rows.length) break;
    rows.forEach(r => docs.push(r.document));
    last = rows[rows.length - 1].document.name;
    if (rows.length < 300) break;
  }
  return docs;
}

const now = new Date();
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const weekAgo = new Date(now.getTime() - 7 * 864e5);
const inMonth = (iso) => iso && new Date(iso) >= monthStart && new Date(iso) <= now;
const CONVERSION_WINDOW_DAYS = 7;

const usersAll = await scanAll('users');
const teams = await scanAll('teams');

// Apple-review demo accounts: manually granted, excluded from ALL counts
// (standing rule: never touched by migrations, never inflate the table).
const DEMO_EMAILS = new Set(['appreview@stopwastinghandshakes.com', 'appreview-expired@stopwastinghandshakes.com']);
const users = usersAll.filter(d => !DEMO_EMAILS.has(val(d.fields || {}, 'email')));
const demoExcluded = usersAll.length - users.length;

// Read a source-scoped map subfield (post-reconciliation apple.*/stripe.*).
const mapVal = (f, m, k) => f && f[m] && f[m].mapValue && val(f[m].mapValue.fields, k);

// Rail classification, derived at read time (SWH guidance 2026-07-19):
// planOverride = deliberate comp; paid plan with no rail evidence and no
// override = legacy/manual grant. Different categories, never conflated.
function railOf(f, plan) {
  const bs = val(f, 'billingSource');
  if (bs) return bs;
  if (mapVal(f, 'apple', 'status')) return 'apple';
  if (mapVal(f, 'stripe', 'status') || val(f, 'stripeSubscriptionId')) return 'stripe';
  if (plan === 'trial') return (val(f, 'trialSource') || 'web') + '-trial';
  if (val(f, 'planOverride')) return 'comp(override)';
  return 'legacy-grant';
}

// ── 1. Subscribers: plan × status × rail ─────────────────────────────────
const subs = {};
for (const d of users) {
  const f = d.fields || {};
  const plan = val(f, 'plan') || 'free';
  if (plan === 'free') continue;
  const status = val(f, 'subscriptionStatus') || (plan === 'trial' ? 'trialing' : (val(f, 'planOverride') ? 'comp' : 'granted'));
  const rail = railOf(f, plan);
  const key = `${plan} | ${status} | ${rail}`;
  subs[key] = (subs[key] || 0) + 1;
}

// ── 2. Trial cohorts by source ───────────────────────────────────────────
const trials = { started: {}, active: {}, ended: {}, converted7d: {} };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
for (const d of users) {
  const f = d.fields || {};
  const ts = val(f, 'trialStartedAt'); if (!ts) continue;
  const te = val(f, 'trialEndsAt');
  const src = val(f, 'trialSource') || 'web';
  if (WEEKLY ? new Date(ts) >= weekAgo : inMonth(ts)) bump(trials.started, src);
  if (te && new Date(te) > now) bump(trials.active, src);
  if (te && (WEEKLY ? (new Date(te) >= weekAgo && new Date(te) <= now) : inMonth(te))) {
    bump(trials.ended, src);
    // Conversion: paid rail present. Timing: prefer subscribedAt (stamped
    // by the webhooks post-deploy, first paid transition only — trialing
    // never stamps, historical subs stay unstamped BY DESIGN); fall back to
    // the updatedAt approximation for pre-stamp subs. Absence of
    // subscribedAt is NEVER read as absence of conversion.
    const paid = val(f, 'billingSource') || val(f, 'stripeSubscriptionId') || mapVal(f, 'apple', 'status') || mapVal(f, 'stripe', 'status');
    const when = val(f, 'subscribedAt') || val(f, 'updatedAt');
    const within = when && te && (new Date(when) - new Date(te)) <= CONVERSION_WINDOW_DAYS * 864e5 && (new Date(when) - new Date(te)) >= -CONVERSION_WINDOW_DAYS * 864e5;
    if (paid && (within || !when)) bump(trials.converted7d, src);
  }
}

// ── 3. ATX100 ────────────────────────────────────────────────────────────
let atxCum = 0, atxMonth = 0, atxInstrumented = false;
for (const d of users) {
  const f = d.fields || {};
  const oc = val(f, 'appleOfferCode') || (f.apple && f.apple.mapValue && val(f.apple.mapValue.fields, 'offerCode'));
  if (oc !== undefined) atxInstrumented = true;
  if (oc === 'ATX100') { atxCum++; if (inMonth(val(f, 'updatedAt'))) atxMonth++; }
}

// ── 4. Team seats ────────────────────────────────────────────────────────
const teamAgg = {};
for (const d of teams) {
  const f = d.fields || {};
  const plan = val(f, 'plan') || 'team_scorecard';
  const seats = val(f, 'seats') || 0;
  const active = val(f, 'active') === true || ['active', 'trialing', 'comp'].includes(val(f, 'subscriptionStatus'));
  if (!teamAgg[plan]) teamAgg[plan] = { teams: 0, seats: 0, activeTeams: 0 };
  teamAgg[plan].teams++; teamAgg[plan].seats += seats; if (active) teamAgg[plan].activeTeams++;
}

// ── Render ───────────────────────────────────────────────────────────────
const L = [];
L.push(`# SWH Revenue Snapshot — ${WEEKLY ? 'WEEKLY (trial cohorts)' : 'MONTHLY'} — ${now.toISOString().slice(0, 10)}`);
L.push(`Generated ${now.toISOString()} · users scanned: ${users.length} (+${demoExcluded} App-Review demo accounts excluded) · teams: ${teams.length}`);
if (!WEEKLY) {
  L.push('', '## 1. Subscribers (plan | status | rail)');
  const keys = Object.keys(subs).sort();
  if (!keys.length) L.push('- none yet');
  keys.forEach(k => L.push(`- ${k}: ${subs[k]}`));
}
L.push('', `## ${WEEKLY ? '' : '2. '}Trial cohorts (${WEEKLY ? 'last 7 days' : 'this month'}, by source)`);
const srcs = [...new Set([...Object.keys(trials.started), ...Object.keys(trials.active), ...Object.keys(trials.ended)])].sort();
if (!srcs.length) L.push('- no trial activity in window');
srcs.forEach(s => {
  const st = trials.started[s] || 0, ac = trials.active[s] || 0, en = trials.ended[s] || 0, cv = trials.converted7d[s] || 0;
  L.push(`- ${s}: started ${st} · currently active ${ac} · ended ${en} · converted≤${CONVERSION_WINDOW_DAYS}d ${cv}${en ? ` (${Math.round(cv / en * 100)}%)` : ''}`);
});
if (!WEEKLY) {
  L.push('', '## 3. ATX100 redemptions');
  L.push(atxInstrumented
    ? `- this month: ${atxMonth} · cumulative: ${atxCum}`
    : '- NOT YET INSTRUMENTED: webhook does not persist offer codes; change requested from SWH thread (persist event.offer_code → apple.offerCode). Counting starts when it lands.');
  L.push('', '## 4. Team seats');
  const tks = Object.keys(teamAgg).sort();
  if (!tks.length) L.push('- no teams yet');
  tks.forEach(k => L.push(`- ${k}: ${teamAgg[k].teams} teams (${teamAgg[k].activeTeams} active) · ${teamAgg[k].seats} seats`));
  L.push('', '_Methodology: conversion timing approximated from webhook updatedAt until subscribedAt stamping lands; deletion-reset trial leak noted as bounded/monitor._');
}
console.log(L.join('\n'));
