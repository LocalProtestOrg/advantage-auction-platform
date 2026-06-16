// auth-refresh.js - sliding-session client glue.
// The server (authMiddleware) mints a fresh JWT and returns it in the
// `X-Refreshed-Token` response header once a token passes half its lifetime.
// This wrapper transparently swaps that fresh token into localStorage on every
// response, so an active bidder never silently expires and a page refresh keeps
// them logged in throughout auction participation (#4). Load this BEFORE any
// script that issues fetch() calls.
(function () {
  if (window.__authRefreshInstalled) return;
  window.__authRefreshInstalled = true;
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await _fetch(...args);
    try {
      const fresh = res.headers && res.headers.get && res.headers.get('X-Refreshed-Token');
      if (fresh) localStorage.setItem('token', fresh);
    } catch (_) { /* never let token refresh break a request */ }
    return res;
  };
})();
