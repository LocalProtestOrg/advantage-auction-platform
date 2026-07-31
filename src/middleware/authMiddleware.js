// Authentication middleware (JWT-based, hardened)
//
// Identity is derived from EITHER of the two equivalent carriers of the same signed JWT:
//   1. Authorization: Bearer <jwt>  — primary (API clients, localStorage sessions)
//   2. aap_session HttpOnly cookie  — the canonical browser session
// The Bearer header wins when present and valid; otherwise we fall back to the cookie. This makes a
// valid browser session authenticate API calls even when no (or a stale) localStorage token exists —
// e.g. a member who reached /app.html via the BD "My Account" link, whose cookie is valid but whose
// Bearer token is absent. The cookie is never exposed to JavaScript here and its security is unchanged.
const jwt = require('jsonwebtoken');
const { setSessionCookie, readSessionToken } = require('../lib/sessionCookie');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not configured');
}

function verifyToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch (_) { return null; }
}

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const bearer = authHeader && authHeader.split(' ')[1];
  const cookieTok = readSessionToken(req);

  // Bearer first (primary/compat), then the cookie session (canonical browser session).
  let decoded = verifyToken(bearer);
  let token = bearer;
  let source = 'bearer';
  if (!decoded && cookieTok) {
    const cd = verifyToken(cookieTok);
    if (cd) { decoded = cd; token = cookieTok; source = 'cookie'; }
  }

  if (!decoded) {
    // Distinguish "no credentials at all" from "credentials present but invalid/expired".
    if (!bearer && !cookieTok) {
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

  // Sliding session renewal: once the token passes half its lifetime, mint a fresh one and refresh
  // the session cookie so an active member never silently expires mid-session. The X-Refreshed-Token
  // header (which the client fetch wrapper mirrors into localStorage) is emitted ONLY for Bearer
  // clients — a cookie-only session slides via the refreshed cookie alone, and we never hand a new
  // JWT to JavaScript that it did not already hold. Best-effort — never blocks the request.
  let cookieToken = token;
  try {
    if (decoded.exp && decoded.iat) {
      const nowSec   = Math.floor(Date.now() / 1000);
      const lifetime = decoded.exp - decoded.iat;
      if (lifetime > 0 && (nowSec - decoded.iat) > lifetime / 2) {
        const fresh = jwt.sign(
          { id: decoded.id, role: decoded.role },
          process.env.JWT_SECRET,
          { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
        );
        if (source === 'bearer') res.set('X-Refreshed-Token', fresh);
        cookieToken = fresh;
      }
    }
  } catch (_) { /* renewal is best-effort; ignore */ }
  try { setSessionCookie(res, cookieToken); } catch (_) { /* never block */ }
  next();
};

module.exports = authMiddleware;
