// auth-refresh.js — central client-side session guard (sliding refresh + resilient 401 handling).
//
// Two jobs, both by transparently wrapping window.fetch:
//   1. SLIDING SESSION: the server (authMiddleware) returns a fresh JWT in X-Refreshed-Token once a
//      token passes half its lifetime; we swap it into localStorage so an active user never silently
//      expires. Load this BEFORE any script that issues fetch().
//   2. RESILIENT 401s: a single 401 from any authed call is NOT treated as "logged out". We re-verify
//      once via GET /api/auth/me. Only if THAT also fails (token truly invalid/expired) do we clear the
//      token and redirect to login — once, centrally. Otherwise the 401 was transient/scoped: for
//      idempotent GET/HEAD we retry once so the page never even sees it. This is the hardening the live
//      auction pages already had (PR #62), now applied to EVERY page (admin, dashboards, shell) so a
//      network blip or edge-of-expiry 401 can never bounce a working session to /login.
(function () {
  if (window.__authRefreshInstalled) return;
  window.__authRefreshInstalled = true;
  var _fetch = window.fetch.bind(window);
  var loggingOut = false;      // guard: redirect at most once
  var reverifying = null;      // shared in-flight /api/auth/me promise (coalesce concurrent 401s)

  function tok() { try { return localStorage.getItem('token'); } catch (e) { return null; } }
  function authHeader() { var t = tok(); return t ? { Authorization: 'Bearer ' + t } : {}; }

  function isApiCall(url) {
    try { var u = String(url || ''); return u.indexOf('/api/') !== -1 || u.charAt(0) === '/'; } catch (e) { return false; }
  }
  function methodOf(args) {
    var init = args[1] || {};
    return String((init && init.method) || (args[0] && args[0].method) || 'GET').toUpperCase();
  }
  function doLogout() {
    if (loggingOut) return; loggingOut = true;
    try { localStorage.removeItem('token'); } catch (e) {}
    var next = encodeURIComponent(location.pathname + location.search + location.hash);
    var go = function () { location.href = '/login.html?next=' + next; };
    // Also clear the server session cookie so the HTML gate can't re-admit an expired session.
    try { _fetch('/api/auth/logout', { method: 'POST' }).then(go, go); } catch (e) { go(); }
  }
  // Re-verify the session ONCE (coalesced). Resolves true if the token is still valid, false if expired.
  function stillAuthed() {
    if (!tok()) return Promise.resolve(false);
    if (reverifying) return reverifying;
    reverifying = _fetch('/api/auth/me', { headers: authHeader() })
      .then(function (r) {
        try { var f = r.headers && r.headers.get && r.headers.get('X-Refreshed-Token'); if (f) localStorage.setItem('token', f); } catch (e) {}
        return r.status !== 401 && r.status !== 403;
      })
      .catch(function () { return true; })   // network error is not a logout
      .then(function (ok) { reverifying = null; return ok; });
    return reverifying;
  }

  window.fetch = async function () {
    var args = Array.prototype.slice.call(arguments);
    var res = await _fetch.apply(null, args);
    try {
      var fresh = res.headers && res.headers.get && res.headers.get('X-Refreshed-Token');
      if (fresh) localStorage.setItem('token', fresh);
    } catch (e) {}

    // Resilient 401: only for authed API calls we made with a token, and never for the /api/auth/me
    // probe itself (that path is handled by stillAuthed via the raw fetch).
    if (res.status === 401 && tok() && isApiCall(args[0]) && String(args[0]).indexOf('/api/auth/me') === -1) {
      var ok = await stillAuthed();
      if (!ok) { doLogout(); return res; }           // confirmed expiry → single central logout
      var m = methodOf(args);
      if (m === 'GET' || m === 'HEAD') {              // transient/scoped 401 → retry idempotent once
        try {
          var retry = await _fetch.apply(null, args);
          try { var f2 = retry.headers && retry.headers.get && retry.headers.get('X-Refreshed-Token'); if (f2) localStorage.setItem('token', f2); } catch (e) {}
          return retry;
        } catch (e) { return res; }
      }
      // non-idempotent + session still valid: return the original 401 for the caller to handle normally
    }
    return res;
  };
})();
