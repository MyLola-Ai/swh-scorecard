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
  //
  // NEUTRALIZED (2026-08-05, Nylas EOL): this whole legacy widget -- Connect,
  // Disconnect, Push-network-to-Contacts, calendar, thread history -- called
  // Nylas, which ended service 8/2 and can never succeed again. Rather than
  // leave some buttons dead-ending into a broken OAuth flow, some silently
  // failing on click, and some hiding the card outright (tried before --
  // hiding it stranded new users on 2026-07-19), every mount function here
  // now shows one honest "being upgraded" state. Nothing a user could click
  // in this widget would currently work regardless of connection status, so
  // nothing is offered. The permanent replacement (a working connect flow
  // through Lola Connect) rides that rollout's global-enable decision, not
  // this file.
  async function mountConnect(el) {
    if (!el) return;
    el.innerHTML = shell(null, '<div style="' + S.muted + '">Checking…</div>');
    // Still checked (not rendered on) so window.__nylasConnected -- read
    // elsewhere (public-crm/index.html's hasGmail) -- keeps working exactly
    // as before. nylasStatus itself no longer calls Nylas (probe removed).
    var status; try { status = await call('nylasStatus'); } catch (e) { status = { connected: false }; }
    window.__nylasConnected = !!(status && status.connected && status.status === 'active');

    el.innerHTML = shell(null,
      '<p style="' + S.muted + 'margin:0 0 6px;">Email connection is being upgraded. Check back soon.</p>' +
      '<p style="' + S.muted + 'margin:0;">Nothing about your contacts or follow-through changes while we finish it.</p>');
  }

  // ── ContactEmailPanel: thread history inside a contact record ──
  async function mountContactPanel(el, contactEmail) {
    if (!el) return;
    if (!contactEmail) { el.innerHTML = ''; return; }
    el.innerHTML = '<div style="' + S.muted + 'padding:8px 0;">Email history is being upgraded. Check back soon.</div>';
  }

  // ── CalendarPanel: upcoming events on the dashboard ──
  async function mountCalendar(el) {
    if (!el) return;
    el.innerHTML = shell('Calendar', '<div style="' + S.muted + '">Calendar is being upgraded. Check back soon.</div>');
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
