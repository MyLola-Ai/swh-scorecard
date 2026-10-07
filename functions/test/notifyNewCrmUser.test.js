// notifyNewCrmUser: restores the "New SWH CRM User" email to Austen that the CRM
// client used to write to /mail itself (now denied by firestore.rules). Runs the
// real shipped source slice. Covers: parity (CRM first-login shape only, same
// recipient), escaping of every user-supplied field, single-send on retry, and a
// mutation check proving the escaping test can fail.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const START = '// ── New CRM user notice ──';
const END = '// ── end New CRM user notice ──';
const a = src.indexOf(START), b = src.indexOf(END);
assert.ok(a !== -1 && b > a, 'notice block not found');
const slice = src.slice(a, b);

function load(code = slice) {
  const mailDocs = {};
  const calls = { create: 0 };
  let failWith = null;
  const db = {
    collection: (name) => {
      assert.equal(name, 'mail', 'the notice may only write to /mail');
      return {
        doc: (id) => ({
          create: async (data) => {
            calls.create++;
            if (failWith) throw failWith;
            if (mailDocs[id]) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; }
            mailDocs[id] = data;
          },
        }),
      };
    },
  };
  const exportsObj = {};
  new Function('db', 'exports', 'onDocumentCreated', code)(db, exportsObj, (p, h) => h);
  return { handler: exportsObj.notifyNewCrmUser, mailDocs, calls, setFail: (e) => { failWith = e; } };
}

const crmDoc = (over = {}) => ({
  displayName: 'Dana Agent', email: 'dana@example.com', phone: '555-0100', company: 'Acme Realty',
  industry: 'Real Estate', plan: 'free', planStatus: 'beta', weeklyGoal: 150, createdAt: '2026-10-07T00:00:00Z', ...over,
});
const ev = (uid, data) => ({ params: { uid }, data: { data: () => data } });

test('CRM first-login doc sends one notice to Austen, same subject and fields as the old client write', async () => {
  const { handler, mailDocs } = load();
  await handler(ev('u1', crmDoc()));
  assert.deepEqual(Object.keys(mailDocs), ['newCrmUser_u1']);
  const m = mailDocs.newCrmUser_u1;
  assert.equal(m.to, 'austen@austensmith.com');
  assert.equal(m.message.subject, '🎉 New SWH CRM User: Dana Agent');
  for (const s of ['Dana Agent', 'dana@example.com', '555-0100', 'Acme Realty', 'Real Estate', 'New SWH CRM Sign Up']) {
    assert.ok(m.message.html.includes(s), 'missing ' + s);
  }
  assert.deepEqual(Object.keys(m), ['to', 'message'], 'no cc, bcc, from or other fields: parity only');
});

test('parity: only the CRM first-login shape sends (Scorecard signup, server-made doc, other plan status do not)', async () => {
  const { handler, mailDocs } = load();
  await handler(ev('s1', { email: 'x@example.com', plan: 'free', createdAt: '2026-10-07T00:00:00Z' })); // Scorecard signup doc
  await handler(ev('s2', { plan: 'scorecard', status: 'approved', email: 'w@example.com' }));          // approveWaitlistUser-style
  await handler(ev('s3', crmDoc({ planStatus: 'active' })));
  await handler(ev('s4', crmDoc({ weeklyGoal: '150' })));
  await handler(ev('s5', undefined));
  assert.deepEqual(mailDocs, {});
});

test('every user-supplied field is escaped; no raw markup reaches the email to Austen', async () => {
  const { handler, mailDocs } = load();
  await handler(ev('u2', crmDoc({
    displayName: '<img src=x onerror=alert(1)>"Bob"\r\nBcc: evil@example.com',
    email: 'a"><script>alert(2)</script>@example.com',
    phone: '<b>1</b>', company: "<a href='https://evil.example'>Click</a>", industry: '</td><td>injected',
  })));
  const m = mailDocs.newCrmUser_u2.message;
  assert.ok(!/<img|<script|<a href='https:\/\/evil|<\/td><td>injected|<b>1/.test(m.html), 'raw markup leaked: ' + m.html);
  assert.ok(m.html.includes('&lt;img src=x onerror=alert(1)&gt;') && m.html.includes('&lt;script&gt;'));
  assert.ok(!/[\r\n]/.test(m.subject), 'subject must be a single line');
});

test('mutation check: with escaping removed, the injection payload DOES reach the html (the test above can fail)', async () => {
  const mutated = slice.replace(/const _escNoticeHtml = [\s\S]*?\n(?=const _noticeField)/, 'const _escNoticeHtml = (v) => String(v == null ? "" : v);\n');
  assert.notEqual(mutated, slice, 'mutation did not apply');
  const { handler, mailDocs } = load(mutated);
  await handler(ev('u3', crmDoc({ displayName: '<img src=x onerror=alert(1)>' })));
  assert.ok(/<img src=x/.test(mailDocs.newCrmUser_u3.message.html));
});

test('fields are clipped and empty fields show a dash', async () => {
  const { handler, mailDocs } = load();
  await handler(ev('u4', crmDoc({ company: 'C'.repeat(10000), phone: '', industry: '' })));
  const html = mailDocs.newCrmUser_u4.message.html;
  assert.ok(html.length < 4000, 'html unbounded: ' + html.length);
  assert.ok((html.match(/<td style="padding:8px;">—<\/td>/g) || []).length === 2);
});

test('a retried event sends once: second create hits ALREADY_EXISTS and is swallowed', async () => {
  const { handler, mailDocs, calls } = load();
  await handler(ev('u5', crmDoc()));
  await handler(ev('u5', crmDoc()));
  assert.equal(calls.create, 2);
  assert.equal(Object.keys(mailDocs).length, 1);
});

test('an unexpected write error is logged, not thrown (a failed notice must not fail the event)', async () => {
  const { handler, setFail } = load();
  setFail(new Error('boom'));
  const orig = console.error; console.error = () => {};
  try { await handler(ev('u6', crmDoc())); } finally { console.error = orig; }
});
