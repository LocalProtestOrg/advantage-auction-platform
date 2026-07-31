/*
 * ADVANTAGE.BID — Railway-session-aware public header + unified login/logout handoff
 * (Brilliant Directories sitewide script). PLACE IN THE HEADER (before </head>) so the login-page
 * handoff runs before BD's obsolete native login form can paint.
 *
 * This one script does three things, all restricted to the EXACT public BD login/logout paths so BD
 * admin and every other page are untouched:
 *
 *  1. UNIFIED LOGOUT — BD's native "Log Out" ends BD's session and lands the browser on
 *     /login?action=loggedout. We immediately hand off (top-level) to the Railway logout endpoint,
 *     which clears the aap_session cookie AND the localStorage token on bid.advantage.bid, then lands
 *     on the canonical Railway login page. Result: both sessions end together — no stale Railway
 *     session, no "My Account → Session Expired" loop.
 *
 *  2. RETIRED BD LOGIN FORM — an ordinary visit to /login or /login/ is handed off to the Railway
 *     login page so members never see or use BD's old email/password form. (BD admin backend login is
 *     a different path and is NOT matched.)
 *
 *  3. SESSION-AWARE HEADER — on all other pages, if a valid Railway session exists, BD's Login/Sign
 *     In control becomes "My Account" → the Railway dashboard. No session → header left untouched.
 *
 * SAFETY: exact-path matching only (never a substring "login" match); one credentialed GET to
 * /api/auth/session-status (returns ONLY { authenticated: bool }); no localStorage, no polling, no
 * secrets; fails safe (any error leaves the page/header exactly as BD rendered it); no redirect loop
 * (the login/logout handoffs target a DIFFERENT origin, bid.advantage.bid, where this script does not
 * run).
 */
(function () {
  'use strict';
  var LOGIN_URL     = 'https://bid.advantage.bid/login.html';     // canonical Railway login
  var LOGOUT_URL    = 'https://bid.advantage.bid/logout';         // clears cookie + token, lands on login
  var STATUS_URL    = 'https://bid.advantage.bid/api/auth/session-status';
  var DASHBOARD_URL = 'https://bid.advantage.bid/app.html#home';
  var LABEL         = 'My Account';

  // ── Part 1: hand off the EXACT public BD login/logout paths to Railway ──────────────────────────
  // Runs synchronously, first, so BD's native login form never paints. Trailing slash is normalized
  // so /login and /login/ match; nothing else (e.g. /login-help, /account/login) is ever matched.
  try {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/login') {
      if (/[?&]action=loggedout\b/.test(location.search)) {
        location.replace(LOGOUT_URL);   // BD already ended its session → also end the Railway session
      } else {
        location.replace(LOGIN_URL);    // retired BD login form → Railway login
      }
      return;                            // navigating away; do not run the header logic here
    }
  } catch (e) { /* never block page rendering */ }

  // ── Part 2: reflect the Railway session in the header ───────────────────────────────────────────
  function isLoginControl(a) {
    var href = (a.getAttribute('href') || '').toLowerCase();
    var text = (a.textContent || '').trim().toLowerCase();
    var hrefMatch = href.indexOf('login') !== -1;          // e.g. /login.html, /login/
    var textMatch = text === 'login' || text === 'log in' || text === 'sign in' || text === 'sign-in';
    return hrefMatch || textMatch;
  }

  function reflectSession() {
    var anchors = document.querySelectorAll('a[href]');
    var changed = 0;
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.getAttribute('data-adv-session')) continue;    // already converted
      if (!isLoginControl(a)) continue;
      a.setAttribute('href', DASHBOARD_URL);
      var t = (a.textContent || '').trim().toLowerCase();
      if (t === 'login' || t === 'log in' || t === 'sign in' || t === 'sign-in') {
        a.textContent = LABEL;                             // pure text node → relabel to "My Account"
      }
      a.setAttribute('data-adv-session', 'railway');
      changed++;
    }
    return changed;
  }

  function run() {
    try {
      fetch(STATUS_URL, { method: 'GET', credentials: 'include', cache: 'no-store' })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || d.authenticated !== true) return;       // no Railway session → leave Login as-is
          if (!reflectSession()) setTimeout(reflectSession, 600); // retry once if the menu renders late
        })
        .catch(function () { /* fail safe: leave the header unchanged */ });
    } catch (e) { /* never block page rendering */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
