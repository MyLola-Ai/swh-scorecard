/* ============================================================
 * SWH CRM · Nylas email + calendar UI (vanilla JS module)
 * ------------------------------------------------------------
 * Mirrors the spec's ConnectAccounts.tsx + ContactEmailPanel.tsx +
 * CalendarPanel.tsx as plain JS (the CRM is a single-file vanilla SPA).
 *
 * This file lives in public-crm/, which serves the web CRM and is bundled
 * directly into the native CRM iOS app (single source of truth).
 *
 * Embed:
 *   <script src="nylas-email.js"></script>
 *   SWHNylasEmail.mountConnect(el)                 // Settings → Integrations
 *   SWHNylasEmail.mountContactPanel(el, email)     // inside a contact record
 *   SWHNylasEmail.mountCalendar(el)                // dashboard
 *
 * Product 'crm' requests email.metadata + calendar.events + contacts at once.
 * Grant IDs stay server-side; the browser only sends the Firebase ID token.
 * ============================================================ */
(function () {
  'use strict';

  var FN_BASE = window.CRM_FN_BASE || window.FN_BASE || 'https://us-central1-swh-scoreboard.cloudfunctions.net';
  var config = { getToken: null };

  async function idToken() {
    if (config.getToken) return config.getToken();
    var u = (window.currentUser)
      || (window.auth && window.auth.currentUser)
      || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser);
    if (!u) throw new Error('Not signed in');
    return u.getIdToken(false);
  }

  async function call(path, opts) {
    opts = opts || {};
    var token = await idToken();
    var res = await fetch(FN_BASE + '/' + path + (opts.query ? '?' + opts.query : ''), {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = null; try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      var err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status; err.needsReconnect = !!(data && data.needsReconnect);
      throw err;
    }
    return data;
  }

  // ── ConnectAccounts: single "Connect Google Account" (all 3 scopes) ──
  async function mountConnect(el) {
    if (!el) return;
    el.innerHTML = shell(null, '<div style="' + S.muted + '">Checking…</div>');
    var status; try { status = await call('nylasStatus'); } catch (e) { status = { connected: false }; }
    window.__nylasConnected = !!(status && status.connected && status.status === 'active');

    if (status.connected && status.status === 'active') {
      el.innerHTML = '<div style="' + S.card + '">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
          '<div style="min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:7px;">' +
              '<span style="width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0;"></span>' +
              '<span style="font-weight:700;font-size:14px;' + S.text + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(status.email) + '</span></div>' +
            '<div style="' + S.muted + 'font-size:12px;margin-top:3px;">Auto-logs email, syncs your calendar, and powers contact sync.</div>' +
          '</div>' +
          '<button data-dc style="' + S.ghost + '">Disconnect</button></div>' +
        '<div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
          '<button data-sync style="' + S.btn + '">Push my network to Contacts</button>' +
          '<span data-sync-msg style="' + S.muted + 'font-size:12px;"></span></div></div>';
      var dc = el.querySelector('[data-dc]');
      dc.addEventListener('click', async function () { dc.disabled = true; dc.textContent = '…'; try { await call('nylasDisconnect', { method: 'POST' }); mountConnect(el); } catch (_) { dc.disabled = false; dc.textContent = 'Disconnect'; } });
      var sync = el.querySelector('[data-sync]');
      var syncMsg = el.querySelector('[data-sync-msg]');
      sync.addEventListener('click', async function () {
        sync.disabled = true; sync.textContent = 'Pushing…'; syncMsg.textContent = '';
        try {
          var r = await call('nylasSyncContacts', { method: 'POST' });
          syncMsg.textContent = 'Pushed ' + (r.pushed || 0) + (r.bypassed ? ', ' + r.bypassed + ' already in Contacts' : '') + (r.failed ? ', ' + r.failed + ' failed' : '') + '.';
        } catch (e) { syncMsg.textContent = e.message || 'Sync failed.'; }
        sync.disabled = false; sync.textContent = 'Push my network to Contacts';
      });
      return;
    }

    // Honest interim state (2026-08-05, Nylas EOL): the old Connect buttons
    // called getNylasAuthUrl, which started a Nylas OAuth flow that can no
    // longer complete. Rather than leave a dead-end button live or hide the
    // card outright (both tried before -- hiding it stranded new users on
    // 2026-07-19), show plainly that this is mid-upgrade. No action a user
    // could take here would currently succeed, so none is offered.
    el.innerHTML = shell(null,
      '<p style="' + S.muted + 'margin:0 0 6px;">Email connection is being upgraded. Check back soon.</p>' +
      '<p style="' + S.muted + 'margin:0;">Nothing about your contacts or follow-through changes while we finish it.</p>');
  }

  // ── ContactEmailPanel: thread history inside a contact record ──
  async function mountContactPanel(el, contactEmail) {
    if (!el) return;
    if (!contactEmail) { el.innerHTML = ''; return; }
    el.innerHTML = '<div style="' + S.muted + 'padding:8px 0;">Loading email history…</div>';
    try {
      var r = await call('getContactThreads', { query: 'email=' + encodeURIComponent(contactEmail) });
      var threads = r.threads || [];
      if (!threads.length) { el.innerHTML = '<div style="' + S.muted + 'padding:8px 0;">No emails with this contact yet.</div>'; return; }
      el.innerHTML = threads.map(function (t) {
        var when = t.lastMessageAt ? new Date(t.lastMessageAt * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        return '<div style="padding:10px 0;border-top:1px solid rgba(255,255,255,0.06);">' +
          '<div style="display:flex;justify-content:space-between;gap:10px;">' +
            '<div style="font-weight:700;font-size:14px;color:#fff;' + (t.unread ? '' : 'opacity:.85;') + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              (t.unread ? '<span style="color:#A78BFA;">● </span>' : '') + esc(t.subject) + '</div>' +
            '<div style="' + S.muted + 'font-size:12px;white-space:nowrap;">' + esc(when) + '</div></div>' +
          '<div style="' + S.muted + 'font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(t.snippet) + '</div></div>';
      }).join('');
    } catch (e) {
      el.innerHTML = e.needsReconnect
        ? '<div style="' + S.muted + 'padding:8px 0;">Email connection expired. Reconnect in Settings.</div>'
        : '<div style="' + S.muted + 'padding:8px 0;">Could not load email history.</div>';
    }
  }

  // ── CalendarPanel: upcoming events on the dashboard ──
  async function mountCalendar(el) {
    if (!el) return;
    el.innerHTML = shell('Next 7 days', '<div style="' + S.muted + '">Loading…</div>');
    try {
      var r = await call('getUpcomingEvents');
      var events = (r.events || []).slice().sort(function (a, b) { return ms(a) - ms(b); });
      var body = events.length ? events.map(evtRow).join('') : '<div style="' + S.muted + '">Nothing scheduled this week.</div>';
      el.innerHTML = shell('Next 7 days', body);
    } catch (e) {
      el.innerHTML = shell('Calendar', '<div style="' + S.muted + '">' + (e.needsReconnect ? 'Connection expired. Reconnect in Settings.' : 'Could not load calendar.') + '</div>');
    }
  }
  function ms(ev) { var w = ev.when || {}; return w.startTime ? w.startTime * 1000 : (w.date ? Date.parse(w.date) : 0); }
  function evtRow(ev) {
    var w = ev.when || {}, when;
    if (w.startTime) { var d = new Date(w.startTime * 1000); when = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    else if (w.date) { when = new Date(w.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' · All day'; }
    else { when = ''; }
    return '<div style="display:flex;gap:10px;padding:9px 0;border-top:1px solid rgba(255,255,255,0.06);">' +
      '<div style="width:3px;border-radius:3px;background:#A78BFA;"></div>' +
      '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:14px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(ev.title) + '</div>' +
      '<div style="' + S.muted + 'font-size:12px;">' + esc(when) + (ev.location ? ' · ' + esc(ev.location) : '') + '</div></div></div>';
  }

  // ── presentation (light theme — matches the CRM settings cards) ──
  var S = {
    card: 'background:var(--card,#fff);border:1.5px solid var(--border,#e9eaee);border-radius:var(--radius,16px);padding:16px;',
    muted: 'color:var(--muted,#6b7280);font-size:13px;',
    text: 'color:var(--navy,#1f2937);',
    btn: 'background:linear-gradient(135deg,#5B5BD6,#A78BFA);color:#fff;border:none;padding:10px 16px;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;',
    ghost: 'background:transparent;color:var(--muted,#6b7280);border:1px solid var(--border,#e9eaee);padding:7px 12px;border-radius:10px;font-size:12px;cursor:pointer;',
  };
  function shell(title, inner) {
    return '<div style="' + S.card + '">' +
      (title ? '<div style="font-size:13px;font-weight:800;' + S.text + 'margin-bottom:10px;">' + esc(title) + '</div>' : '') + inner + '</div>';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  window.SWHNylasEmail = { mountConnect: mountConnect, mountContactPanel: mountContactPanel, mountCalendar: mountCalendar, config: config };
})();
