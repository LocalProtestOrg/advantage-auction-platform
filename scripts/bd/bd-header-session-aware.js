/*
 * ADVANTAGE.BID — Railway/BD session-aware public header + unified login/logout handoff
 * (Brilliant Directories sitewide script). PLACE IN THE HEADER (before </head>) so the login-page
 * handoff runs before BD's obsolete native login form can paint.
 *
 * PART 1 — exact-path login/logout handoff (unchanged):
 *   /login                    -> Railway login (retires BD's native login form)
 *   /login?action=loggedout   -> Railway logout (ends the Railway session with BD's)
 *
 * PART 2 — one, non-duplicated header control based on the real session state:
 *   A. BD session + Railway session -> keep BD's native member dropdown; HIDE the public Login/My
 *      Account anchor. Never create a second "My Account".
 *   B. Railway session only         -> convert public Login/Sign In -> "My Account" (app.html#home).
 *   C. Neither                      -> leave Login unchanged.
 *   D. BD session only              -> keep BD's native dropdown; HIDE the redundant public Login
 *      (its Dashboard item keeps going through /account/enter-auctions).
 *   Whenever BD's native member header exists (A or D) we defer to it and only hide the duplicate
 *   public control — we never touch the dropdown's own links.
 *
 * SAFETY: exact-path handoff only (never a substring "login" redirect); BD auth detected via multiple
 * confirmed DOM signatures (desktop + mobile); one credentialed GET to /api/auth/session-status
 * (returns ONLY { authenticated: bool }); no localStorage, no polling, no secrets; fails safe (any
 * error leaves the header exactly as BD rendered it); handoffs target a different origin -> no loop.
 */
(function () {
  'use strict';
  var LOGIN_URL     = 'https://bid.advantage.bid/login.html';     // canonical Railway login
  var LOGOUT_URL    = 'https://bid.advantage.bid/logout';         // clears cookie + token, lands on login
  var STATUS_URL    = 'https://bid.advantage.bid/api/auth/session-status';
  var DASHBOARD_URL = 'https://bid.advantage.bid/app.html#home';
  var LABEL         = 'My Account';

  // Confirmed authenticated-BD DOM signatures (desktop + mobile). If ANY is present, BD rendered its
  // native member thumbnail/dropdown for a logged-in member.
  var NATIVE = [
    '.header-member-account-links', '.logged-in-member-header', '.toggle-member-info',
    '#member_sidebar_toggle', '.member_sidebar', '.user_sidebar'
  ];

  // ── Part 1: hand off the EXACT public BD login/logout paths to Railway ──────────────────────────
  try {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/login') {
      if (/[?&]action=loggedout\b/.test(location.search)) {
        location.replace(LOGOUT_URL);   // BD already ended its session -> also end the Railway session
      } else {
        location.replace(LOGIN_URL);    // retired BD login form -> Railway login
      }
      return;                            // navigating away; do not run the header logic here
    }
  } catch (e) { /* never block page rendering */ }

  // ── Part 2 helpers ──────────────────────────────────────────────────────────────────────────────
  function bdAuthed() {
    for (var i = 0; i < NATIVE.length; i++) {
      try { if (document.querySelector(NATIVE[i])) return true; } catch (e) {}
    }
    return false;
  }
  function inNative(el) {
    for (var i = 0; i < NATIVE.length; i++) {
      try { if (el.closest && el.closest(NATIVE[i])) return true; } catch (e) {}
    }
    return false;
  }
  function containsNative(el) {
    for (var i = 0; i < NATIVE.length; i++) {
      try { if (el.querySelector && el.querySelector(NATIVE[i])) return true; } catch (e) {}
    }
    return false;
  }
  // A public, anonymous auth control in the header (Login/Sign In), OR a "My Account" anchor this
  // script previously created. NEVER matches the native dropdown's own items (callers skip those).
  function isPublicAuthControl(a) {
    var href = (a.getAttribute('href') || '').toLowerCase();
    var text = (a.textContent || '').trim().toLowerCase();
    if (a.getAttribute('data-adv-session')) return true;
    if (href.indexOf('login') !== -1) return true;
    return text === 'login' || text === 'log in' || text === 'sign in' || text === 'sign-in' || text === 'my account';
  }

  // States A + D: BD's native dropdown wins — hide the duplicate public Login/My Account control(s),
  // never the dropdown's own links.
  function hidePublicAuthControls() {
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (!isPublicAuthControl(a)) continue;
      if (inNative(a)) continue;                       // leave the native dropdown untouched
      var target = (a.closest && a.closest('li')) || a;
      if (target !== a && containsNative(target)) target = a; // don't hide a container holding the dropdown
      try { target.style.display = 'none'; } catch (e) {}
      a.setAttribute('data-adv-hidden', '1');
    }
  }

  // State B: Railway session only — convert the public Login/Sign In anchor(s) to "My Account".
  function isLoginControl(a) {
    var href = (a.getAttribute('href') || '').toLowerCase();
    var text = (a.textContent || '').trim().toLowerCase();
    return href.indexOf('login') !== -1 ||
      text === 'login' || text === 'log in' || text === 'sign in' || text === 'sign-in';
  }
  function convertToMyAccount() {
    var anchors = document.querySelectorAll('a[href]');
    var changed = 0;
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.getAttribute('data-adv-session')) continue;   // already converted
      if (inNative(a)) continue;                           // never rewrite the native dropdown
      if (!isLoginControl(a)) continue;
      a.setAttribute('href', DASHBOARD_URL);
      var t = (a.textContent || '').trim().toLowerCase();
      if (t === 'login' || t === 'log in' || t === 'sign in' || t === 'sign-in') {
        a.textContent = LABEL;
      }
      a.setAttribute('data-adv-session', 'railway');
      changed++;
    }
    return changed;
  }

  function run() {
    try {
      // A + D: if BD already shows its native member header, defer to it and hide the duplicate.
      if (bdAuthed()) { hidePublicAuthControls(); return; }
      // No BD session -> the Railway session decides.
      fetch(STATUS_URL, { method: 'GET', credentials: 'include', cache: 'no-store' })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (d) {
          if (bdAuthed()) { hidePublicAuthControls(); return; }      // dropdown rendered meanwhile
          if (!d || d.authenticated !== true) return;                // C: neither -> leave Login
          if (!convertToMyAccount()) setTimeout(convertToMyAccount, 600); // B: retry if menu renders late
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
