#!/usr/bin/env node
// Evaluates firestore.rules with the Firebase Rules API (projects:test): the
// production rules engine, no emulator or Java, nothing deployed.
//
//   GOOGLE_ACCESS_TOKEN=$(...) node scripts/test-firestore-rules.mjs [--rules firestore.rules] [--project swh-scoreboard]
//
// Every case runs against the LIVE ruleset too. `live` is what production
// does today: the hole cases must read ALLOW there, otherwise this harness
// proves nothing. `fixed` is what the file under test must do.
import fs from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const PROJECT = arg('--project', 'swh-scoreboard');
const RULES_FILE = arg('--rules', 'firestore.rules');
const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
if (!TOKEN) { console.error('Set GOOGLE_ACCESS_TOKEN'); process.exit(2); }

const API = 'https://firebaserules.googleapis.com/v1';
const H = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const DOCS = '/databases/(default)/documents';

const anon = null;
const user = { uid: 'u1', token: { email: 'someone@example.com', email_verified: false } };
const verifiedUser = { uid: 'u3', token: { email: 'other@example.com', email_verified: true } };
const admin = { uid: 'a1', token: { email: 'austen@austensmith.com', email_verified: true } };
const unverifiedAdmin = { uid: 'a2', token: { email: 'austen@austensmith.com', email_verified: false } };
const mailDoc = { to: 'victim@example.com', message: { subject: 's', html: '<b>h</b>' } };
const tc = (id, desc, auth, method, path, fixed, live, data) =>
  ({ id, desc, auth, method, path: DOCS + path, fixed, live, data });

const CASES = [
  // R1: /mail create was `isSignedIn()`
  tc('R1-1', 'signed-in unverified user creates a mail doc', user, 'create', '/mail/x', 'DENY', 'ALLOW', mailDoc),
  tc('R1-2', 'signed-in verified non-admin creates a mail doc', verifiedUser, 'create', '/mail/x', 'DENY', 'ALLOW', mailDoc),
  tc('R1-3', 'anonymous creates a mail doc', anon, 'create', '/mail/x', 'DENY', 'DENY', mailDoc),
  tc('R1-4', 'admin creates a mail doc (announcement blast)', admin, 'create', '/mail/x', 'ALLOW', 'ALLOW', mailDoc),
  tc('R1-5', 'non-admin reads a mail doc', user, 'get', '/mail/x', 'DENY', 'DENY'),
  tc('R1-6', 'admin reads a mail doc', admin, 'get', '/mail/x', 'ALLOW', 'ALLOW'),
  tc('R1-7', 'admin updates a mail doc', admin, 'update', '/mail/x', 'DENY', 'DENY', mailDoc),
  tc('R1-8', 'admin deletes a mail doc', admin, 'delete', '/mail/x', 'DENY', 'DENY'),
  // R2: teamInvites was `allow read: if true` (get AND list)
  tc('R2-1', 'anonymous LISTS teamInvites', anon, 'list', '/teamInvites/anytoken', 'DENY', 'ALLOW'),
  tc('R2-2', 'signed-in user LISTS teamInvites', user, 'list', '/teamInvites/anytoken', 'DENY', 'ALLOW'),
  tc('R2-3', 'anonymous GETS one invite by token (no client reads this; functions use the Admin SDK)', anon, 'get', '/teamInvites/tok', 'DENY', 'ALLOW'),
  tc('R2-6', 'signed-in user GETS one invite by token', user, 'get', '/teamInvites/tok', 'DENY', 'ALLOW'),
  tc('R2-4', 'non-admin creates an invite', user, 'create', '/teamInvites/tok', 'DENY', 'DENY', { email: 'a@b.co' }),
  tc('R2-5', 'admin creates an invite', admin, 'create', '/teamInvites/tok', 'ALLOW', 'ALLOW', { email: 'a@b.co' }),
  // isAdmin() must require a verified email (live trusts the claimed address).
  tc('H-1', 'admin address with an UNVERIFIED token creates a mail doc', unverifiedAdmin, 'create', '/mail/x', 'DENY', 'ALLOW', mailDoc),
  tc('H-2', 'admin address with an UNVERIFIED token reads another user\'s doc', unverifiedAdmin, 'get', '/users/u9', 'DENY', 'ALLOW'),
  tc('H-3', 'admin address with a VERIFIED token reads another user\'s doc (not locked out)', admin, 'get', '/users/u9', 'ALLOW', 'ALLOW'),
  tc('H-4', 'verified admin can still create an invite', admin, 'create', '/teamInvites/tok2', 'ALLOW', 'ALLOW', { email: 'a@b.co' }),
  // Request data really reaches the engine: same path, outcome depends on the body.
  tc('R0-1', 'owner creates own users doc, plan free', user, 'create', '/users/u1', 'ALLOW', 'ALLOW', { plan: 'free' }),
  tc('R0-2', 'owner creates own users doc with planOverride', user, 'create', '/users/u1', 'DENY', 'DENY', { planOverride: 'pro' }),
  // Unrelated paths: the fix must not move any of them (fixed must equal live).
  tc('X-1', 'owner reads own users doc', user, 'get', '/users/u1', 'SAME', 'SAME'),
  tc('X-2', 'user reads someone else\'s users doc', user, 'get', '/users/u9', 'SAME', 'SAME'),
  tc('X-3', 'anonymous creates a waitlist entry', anon, 'create', '/waitlist/w', 'SAME', 'SAME', { email: 'a@b.co' }),
  tc('X-4', 'anonymous reads announcements', anon, 'get', '/announcements/a', 'SAME', 'SAME'),
  tc('X-5', 'user reads a team doc', user, 'get', '/teams/t1', 'SAME', 'SAME'),
  tc('X-6', 'user reads a system doc', user, 'get', '/system/s', 'SAME', 'SAME'),
  tc('X-7', 'anonymous reads a platform doc', anon, 'get', '/platform/p', 'SAME', 'SAME'),
];

async function evalRuleset(source, label) {
  const out = {};
  for (const c of CASES) {
    const req = { path: c.path, method: c.method };
    if (c.auth) req.auth = c.auth;
    if (c.data) req.resource = { data: c.data };
    const ask = async (expectation) => {
      const body = { source: { files: [{ name: 'firestore.rules', content: source }] },
        testSuite: { testCases: [{ expectation, request: req, pathEncoding: 'PLAIN' }] } };
      const r = await fetch(`${API}/projects/${PROJECT}:test`, { method: 'POST', headers: H, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.error) throw new Error(`${label} ${c.id}: ${j.error.message}`);
      if (j.issues && j.issues.length) throw new Error(`${label} ${c.id}: rules did not compile: ${JSON.stringify(j.issues)}`);
      return j.testResults[0].state;
    };
    // Ask with ALLOW; if that fails the engine said DENY. Evaluation errors read as DENY.
    out[c.id] = (await ask('ALLOW')) === 'SUCCESS' ? 'ALLOW' : 'DENY';
  }
  return out;
}

const fixedSrc = fs.readFileSync(RULES_FILE, 'utf8');
const rel = await (await fetch(`${API}/projects/${PROJECT}/releases/cloud.firestore`, { headers: H })).json();
if (!rel.rulesetName) throw new Error('could not read live release: ' + JSON.stringify(rel));
const liveSrc = (await (await fetch(`${API}/${rel.rulesetName}`, { headers: H })).json()).source.files[0].content;

const live = await evalRuleset(liveSrc, 'live');
const fixed = await evalRuleset(fixedSrc, 'fixed');

let bad = 0;
const pad = (s, n) => String(s).padEnd(n);
console.log(`live ruleset: ${rel.rulesetName.split('/').pop()}   file under test: ${RULES_FILE}`);
console.log(pad('case', 6), pad('live(want)', 16), pad('fixed(want)', 16), 'description');
for (const c of CASES) {
  const wantLive = c.live === 'SAME' ? live[c.id] : c.live;
  const wantFixed = c.fixed === 'SAME' ? live[c.id] : c.fixed;
  const okLive = live[c.id] === wantLive, okFixed = fixed[c.id] === wantFixed;
  if (!okLive || !okFixed) bad++;
  console.log(pad(c.id, 6), pad(`${live[c.id]}(${wantLive})${okLive ? '' : ' !!'}`, 16),
    pad(`${fixed[c.id]}(${wantFixed})${okFixed ? '' : ' !!'}`, 16), c.desc);
}
console.log(bad ? `\n${bad} case(s) did not match` : `\nall ${CASES.length} cases match`);
process.exit(bad ? 1 : 0);
