/*
 * ADVANTAGE.BID — Railway-session-aware public header (Brilliant Directories sitewide script).
 *
 * PROBLEM THIS SOLVES
 *   The primary login lives on Railway (BD's "Login"/"Sign In" links already point at
 *   https://bid.advantage.bid/login.html). When a member logs in there, BD never sees it — BD has no
 *   session of its own, so it keeps rendering the anonymous header ("Login"). A real BD session
 *   cannot be created from Railway (BD is a hosted platform: its session cookie is minted only by its
 *   own password login; its REST API is read-only; there is no SSO/token endpoint). Since the
 *   platform's source of truth is Railway, the correct fix is for BD's header to REFLECT the Railway
 *   session rather than hold one.
 *
 * WHAT IT DOES
 *   On every BD page: if the visitor has a valid Railway session, the header's "Login"/"Sign In"
 *   control becomes "My Account", pointing at the Railway member dashboard
 *   (https://bid.advantage.bid/app.html#home). With no Railway session, the header is left exactly as
 *   BD rendered it (Login stays Login).
 *
 * WHERE TO PASTE
 *   BD Admin → Toolbox → Custom Code → sitewide footer/header JavaScript (or a header widget's script
 *   slot). No BD core template edit required. Safe on every page.
 *
 * SECURITY / SAFETY
 *   - ONE credentialed GET to /api/auth/session-status, which returns ONLY { authenticated: bool } —
 *     never an id, email, role, or token. Credentialed CORS is locked server-side to the approved
 *     Advantage.Bid hosts.
 *   - Simple GET (no custom headers) → no CORS preflight; the SameSite=Lax first-party cookie is sent
 *     because www.advantage.bid and bid.advantage.bid are the same site (advantage.bid).
 *   - FAILS SAFE: any network/parse error, or authenticated !== true, leaves the header untouched.
 *   - No localStorage, no polling, no secrets, no open redirect (the destination is a constant).
 */
(function () {
  'use strict';
  var STATUS_URL = 'https://bid.advantage.bid/api/auth/session-status';
  var DASHBOARD_URL = 'https://bid.advantage.bid/app.html#home';
  var LABEL = 'My Account';

  function isLoginControl(a) {
    var href = (a.getAttribute('href') || '').toLowerCase();
    var text = (a.textContent || '').trim().toLowerCase();
    var hrefMatch = href.indexOf('login') !== -1;          // e.g. /login.html, /login/
    var textMatch = text === 'login' || text === 'log in' || text === 'sign in' || text === 'sign-in';
    return hrefMatch || textMatch;
  }

  function reflectSession() {
    // BD renders the Login/Sign In control (and a mobile duplicate) as plain anchors. Convert every
    // one so both desktop and responsive menus update. Preserve surrounding markup/classes/icons.
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
