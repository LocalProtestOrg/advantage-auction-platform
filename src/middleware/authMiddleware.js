// Authentication middleware (JWT-based, hardened)
//
// Identity is derived from EITHER of the two equivalent carriers of the same signed JWT:
//   1. Authorization: Bearer <jwt>  — primary (API clients, localStorage sessions)
//   2. aap_session HttpOnly cookie  — the canonical browser session
// The Bearer header wins when present and valid; otherwise we fall back to the cookie. This makes a
// valid browser session authenticate API calls even when no (or a stale) localStorage token exists —
// e.g. a member who reached /app.html via the BD "My Account" link, whose cookie is valid but whose
// Bearer token is absent. The cookie is never exposed to JavaScript here and its security is unchanged.
// Credential resolution (carriers, precedence, signature + expiry) lives in ONE place:
// src/lib/sessionAuth.js — shared with optionalAuthMiddleware so the two can never drift.
const jwt = require('jsonwebtoken');
const { setSessionCookie } = require('../lib/sessionCookie');
const { resolveSession } = require('../lib/sessionAuth');
const accountStatus = require('../lib/accountStatus');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not configured');
}

// Read-only methods never change state; a suspended session may still read (unchanged behavior).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const authMiddleware = (req, res, next) => {
  // Bearer first (primary/compat), then the cookie session (canonical browser session).
  const { decoded, token, source, presented } = resolveSession(req);

  if (!decoded) {
    // Distinguish "no credentials at all" from "credentials present but invalid/expired".
    if (!presented.bearer && !presented.cookie) {
      console.warn('[auth] missing token:', req.method, req.path);
      return res.status(401).json({ error: 'Authentication required' });
    }
    console.warn('[auth] no valid bearer/cookie session:', req.method, req.path);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
  if (!decoded.id || !decoded.role) {
    console.warn('[auth] invalid token payload:', req.method, req.path);
    return res.status(401).json({ error: 'Invalid token payload' });
  }

  req.user = { id: decoded.id, role: decoded.role };

  // Account-status re-check (suspension = users.is_active = false, mig 046). A token issued while the
  // account was active stays cryptographically valid, so for an already-authenticated session we
  // refuse EVERY state-changing request from a suspended account (checkout, payment, bidding, seller
  // creation, …) — admins included — and never renew its session. Read-only requests not yet due a
  // renewal stay on the original synchronous path with no DB lookup. POST /api/auth/logout is not
  // behind this middleware, so a suspended member can always sign out.
  const stateChanging = !SAFE_METHODS.has(String(req.method || 'GET').toUpperCase());
  let refreshDue = false;
  if (decoded.exp && decoded.iat) {
    const nowSec   = Math.floor(Date.now() / 1000);
    const lifetime = decoded.exp - decoded.iat;
    refreshDue = lifetime > 0 && (nowSec - decoded.iat) > lifetime / 2;
  }

  const finish = (active) => {
    if (active === false) {
      if (stateChanging) {
        console.warn('[auth] suspended account refused:', req.method, req.path);
        return res.status(403).json(accountStatus.SUSPENDED_BODY);
      }
      // Read-only request from a suspended account: allowed as before, but no renewed token/cookie.
      return next();
    }
    if (active !== true) {
      // Status could not be determined (lookup error / timeout / no user row): FAIL CLOSED for
      // state-changing requests with a neutral retry message; read-only requests proceed, unrenewed.
      if (stateChanging) {
        console.warn('[auth] account status unavailable, refused:', req.method, req.path);
        return res.status(503).json(accountStatus.UNAVAILABLE_BODY);
      }
      return next();
    }
    // Sliding session renewal: once the token passes half its lifetime, mint a fresh one and refresh
    // the session cookie so an active member never silently expires mid-session. The X-Refreshed-Token
    // header (which the client fetch wrapper mirrors into localStorage) is emitted ONLY for Bearer
    // clients — a cookie-only session slides via the refreshed cookie alone, and we never hand a new
    // JWT to JavaScript that it did not already hold. Best-effort — never blocks the request.
    let cookieToken = token;
    try {
      if (refreshDue) {
        const fresh = jwt.sign(
          { id: decoded.id, role: decoded.role },
          process.env.JWT_SECRET,
          { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
        );
        if (source === 'bearer') res.set('X-Refreshed-Token', fresh);
        cookieToken = fresh;
      }
    } catch (_) { /* renewal is best-effort; ignore */ }
    try { setSessionCookie(res, cookieToken); } catch (_) { /* never block */ }
    return next();
  };

  if (!stateChanging && !refreshDue) return finish(true);
  const cached = accountStatus.cachedActive(decoded.id);
  if (cached !== undefined) return finish(cached);
  // is_active === false → 403 suspended; unknown (null: no row / lookup error / timeout) → 503 for
  // state-changing requests, read-only proceeds without renewal. Unknown is never cached.
  return accountStatus.isAccountActive(decoded.id).catch(() => null).then(finish);
};

module.exports = authMiddleware;
