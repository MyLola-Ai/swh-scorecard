/* ============================================================
 * SWH Scorecard · Nylas calendar UI (vanilla JS module)
 * ------------------------------------------------------------
 * Mirrors the spec's ConnectCalendar.tsx + CalendarWidget.tsx as plain JS,
 * because the Scorecard app is a single-file vanilla SPA (no React/build).
 *
 * Embed:
 *   <script src="nylas-calendar.js"></script>
 *   <div id="nylas-connect"></div>        // Settings
 *   <div id="nylas-upcoming"></div>       // Dashboard
 *   <script>
 *     SWHNylasCalendar.mountConnect(document.getElementById('nylas-connect'));
 *     SWHNylasCalendar.mountWidget(document.getElementById('nylas-upcoming'));
 *   </script>
 *
 * Talks to the Cloud Functions in functions/nylas.js. Grant IDs never reach
 * the browser; this only ever sends the Firebase ID token.
 * ============================================================ */
(function () {
  'use strict';

  var FN_BASE = window.FN_BASE || 'https://us-central1-swh-scoreboard.cloudfunctions.net';

  // Resolve a Firebase ID token. Host can override via SWHNylasCalendar.config.
  async function idToken() {
    if (config.getToken) return config.getToken();
    var u = (window.auth && window.auth.currentUser)
      || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser);
    if (!u) throw new Error('Not signed in');
    return u.getIdToken(false);
  }

  async function call(path, opts) {
    opts = opts || {};
    var token = await idToken();
    var res = await fetch(FN_BASE + '/' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      var err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      err.needsReconnect = !!(data && data.needsReconnect);
      throw err;
    }
    return data;
  }

  var config = { getToken: null };

  // ── ConnectCalendar ──
  // "Connect Google Calendar" button. On click, asks the backend for a hosted
  // Nylas OAuth URL (scope: calendar.events) and redirects the browser to it.
  async function mountConnect(el) {
    if (!el) return;
    el.innerHTML = renderConnectShell('Checking…', true);
    var status;
    try { status = await call('nylasStatus'); } catch (e) { status = { connected: false, error: e.message }; }

    if (status.connected && status.status === 'active') {
      el.innerHTML = renderConnected(status.email);
      wireDisconnect(el);
      return;
    }
    var prompt = status.needsReconnect ? 'Reconnect needed' : null;
    el.innerHTML = renderConnectShell(prompt);
    var btn = el.querySelector('[data-nylas-connect]');
    var provider = el.querySelector('[data-nylas-provider]');
    if (btn) btn.addEventListener('click', async function () {
      btn.disabled = true; btn.textContent = 'Opening…';
      try {
        var r = await call('getNylasAuthUrl', {
          method: 'POST',
          body: { product: 'scorecard', provider: provider ? provider.value : 'google' },
        });
        window.location.href = r.authUrl;
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Connect Google Calendar';
        el.querySelector('[data-nylas-msg]').textContent = e.message || 'Could not start connection.';
      }
    });
  }

  function wireDisconnect(el) {
    var dc = el.querySelector('[data-nylas-disconnect]');
    if (dc) dc.addEventListener('click', async function () {
      dc.disabled = true; dc.textContent = 'Disconnecting…';
      try { await call('nylasDisconnect', { method: 'POST' }); await mountConnect(el); }
      catch (e) { dc.disabled = false; dc.textContent = 'Disconnect'; }
    });
  }

  // ── CalendarWidget ──
  // Renders the next 7 days of events from getUpcomingEvents.
  async function mountWidget(el) {
    if (!el) return;
    el.innerHTML = '<div style="' + S.card + '"><div style="' + S.muted + '">Loading your week…</div></div>';
    try {
      var r = await call('getUpcomingEvents');
      var events = (r.events || []).slice().sort(function (a, b) {
        return startMs(a) - startMs(b);
      });
      if (!events.length) {
        el.innerHTML = '<div style="' + S.card + '"><div style="' + S.title + '">This week</div><div style="' + S.muted + '">Nothing on your calendar in the next 7 days.</div></div>';
        return;
      }
      el.innerHTML = '<div style="' + S.card + '"><div style="' + S.title + '">Next 7 days</div>' +
        events.map(renderEvent).join('') + '</div>';
    } catch (e) {
      if (e.needsReconnect) {
        el.innerHTML = '<div style="' + S.card + '"><div style="' + S.title + '">Calendar</div>' +
          '<div style="' + S.muted + '">Your calendar connection expired. Reconnect in Settings.</div></div>';
      } else {
        el.innerHTML = '<div style="' + S.card + '"><div style="' + S.muted + '">Could not load calendar.</div></div>';
      }
    }
  }

  function startMs(ev) {
    var w = ev.when || {};
    if (w.startTime) return w.startTime * 1000;
    if (w.date) return Date.parse(w.date);
    return 0;
  }
  function renderEvent(ev) {
    var w = ev.when || {};
    var when;
    if (w.startTime) {
      var d = new Date(w.startTime * 1000);
      when = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
        ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } else if (w.date) {
      when = new Date(w.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' · All day';
    } else { when = ''; }
    return '<div style="display:flex;gap:10px;padding:10px 0;border-top:1px solid rgba(255,255,255,0.06);">' +
      '<div style="width:3px;border-radius:3px;background:#A78BFA;"></div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:700;font-size:14px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(ev.title) + '</div>' +
        '<div style="' + S.muted + 'font-size:12px;">' + esc(when) + (ev.location ? ' · ' + esc(ev.location) : '') + '</div>' +
      '</div></div>';
  }

  // ── presentation ──
  var S = {
    card: 'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:18px;',
    title: 'font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#A78BFA;margin-bottom:10px;',
    muted: 'color:rgba(255,255,255,0.6);font-size:13px;',
    btn: 'display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,#5B5BD6,#A78BFA);color:#fff;border:none;padding:11px 18px;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;',
  };
  function renderConnectShell(badge, loading) {
    return '<div style="' + S.card + '">' +
      '<div style="' + S.title + '">Calendar</div>' +
      (badge ? '<div style="color:#FBBF24;font-size:12px;font-weight:700;margin-bottom:8px;">' + esc(badge) + '</div>' : '') +
      '<p style="' + S.muted + 'margin:0 0 14px;">Connect your calendar to see your week on the dashboard.</p>' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
        '<button data-nylas-connect ' + (loading ? 'disabled' : '') + ' style="' + S.btn + '">Connect Google Calendar</button>' +
        '<select data-nylas-provider style="background:#1a1d27;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px;font-size:13px;">' +
          '<option value="google">Google</option><option value="microsoft">Outlook</option></select>' +
      '</div>' +
      '<div data-nylas-msg style="color:#F87171;font-size:12px;margin-top:8px;"></div>' +
    '</div>';
  }
  function renderConnected(email) {
    return '<div style="' + S.card + '">' +
      '<div style="' + S.title + '">Calendar · Connected</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
        '<div style="color:#fff;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;">' + esc(email || '') + '</div>' +
        '<button data-nylas-disconnect style="background:transparent;color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.14);padding:7px 12px;border-radius:10px;font-size:12px;cursor:pointer;">Disconnect</button>' +
      '</div></div>';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  window.SWHNylasCalendar = { mountConnect: mountConnect, mountWidget: mountWidget, config: config };
})();
