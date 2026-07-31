/*
 * ADVANTAGE.BID — Railway-session-aware public header (Brilliant Directories sitewide script).
 *
 * WHAT IT DOES
 *   When a visitor on www.advantage.bid has a valid Railway session (cookie on bid.advantage.bid),
 *   the public header's "Login" action is swapped for "Dashboard", pointing at the Railway Unified
 *   Member Dashboard (https://bid.advantage.bid/app.html#home). If there is NO Railway session, the
 *   header is left exactly as BD rendered it (Login stays Login).
 *
 * WHERE TO PASTE
 *   BD Admin → Toolbox → Custom Code (sitewide footer JS), or your header widget's script slot.
 *   No BD core template edit is required. Safe to load on every page.
 *
 * HOW IT WORKS (security-minimal)
 *   - Makes ONE credentialed GET to /api/auth/session-status. That endpoint returns ONLY
 *     { authenticated: true|false } — never an id, email, role, or token. Credentialed CORS is
 *     locked server-side to the approved Advantage.Bid hosts.
 *   - It is a "simple" GET (no custom headers) so the browser sends it without a CORS preflight and
 *     attaches the SameSite=Lax first-party cookie (www + bid are the same site: advantage.bid).
 *   - FAILS SAFE: any network/parse error, or authenticated !== true, leaves the header untouched.
 *   - No localStorage, no polling, no secrets, no open redirect (the Dashboard URL is a constant).
 *
 * NOTE ON THE FOUR SESSION STATES
 *   Railway-only / both  → this swaps Login → Dashboard (app.html#home; the Railway session is valid,
 *                          so no bridge round-trip is needed).
 *   BD-only              → no Railway session yet → Login is left as-is; the member still reaches the
 *                          app through the existing bridge page (/account/enter-auctions).
 *   Neither              → Login stays Login.
 *   (BD-session state is known server-side by BD, not from this script; this script only detects the
 *    Railway session, which is the missing signal.)
 */
(function () {
  'use strict';
  var STATUS_URL = 'https://bid.advantage.bid/api/auth/session-status';
  var DASHBOARD_URL = 'https://bid.advantage.bid/app.html#home';

  function looksLikeLogin(a) {
    var href = (a.getAttribute('href') || '').toLowerCase();
    var text = (a.textContent || '').trim().toLowerCase();
    var hrefMatch = /(^|[\/.])login(\/|$|\?|#)/.test(href) || href.indexOf('/login') !== -1;
    var textMatch = text === 'login' || text === 'log in' || text === 'sign in' || text === 'sign-in';
    return hrefMatch || textMatch;
  }

  function convertToDashboard() {
    // Match the header's Login control robustly across themes: by href and/or visible text.
    var anchors = document.querySelectorAll('a[href]');
    var changed = 0;
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (!looksLikeLogin(a)) continue;
      a.setAttribute('href', DASHBOARD_URL);
      // Preserve any icon markup; only replace a pure "Login"/"Sign In" text node if present.
      var t = (a.textContent || '').trim().toLowerCase();
      if (t === 'login' || t === 'log in' || t === 'sign in' || t === 'sign-in') {
        a.textContent = 'Dashboard';
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
          if (!d || d.authenticated !== true) return; // no Railway session → leave the header alone
          if (!convertToDashboard()) {
            // Header not in the DOM yet (late-rendered menu): retry once after it settles.
            setTimeout(convertToDashboard, 600);
          }
        })
        .catch(function () { /* fail safe: leave Login unchanged */ });
    } catch (e) { /* never block page rendering */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
