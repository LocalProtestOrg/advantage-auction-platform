'use strict';

/**
 * sessionAuth — the ONE canonical way the platform turns request credentials into a verified
 * Advantage.Bid session. Both the mandatory authMiddleware and the optionalAuthMiddleware call
 * resolveSession(); there is no second JWT-validation implementation.
 *
 * Carriers of the SAME signed JWT:
 *   1. Authorization: Bearer <jwt>  — API clients / localStorage sessions
 *   2. aap_session HttpOnly cookie  — the canonical browser session
 *
 * PRECEDENCE (documented contract):
 *   • A Bearer token whose signature + expiry verify wins, even when a cookie is also present
 *     (the explicit credential the client chose to send beats the ambient one).
 *   • Otherwise a cookie whose signature + expiry verify is used.
 *   • A present-but-invalid/expired credential never authenticates on its own; it only falls
 *     through to the other carrier, which must verify independently.
 * jwt.verify enforces signature and exp. Callers still enforce payload shape ({ id, role }).
 */
const jwt = require('jsonwebtoken');
const { readSessionToken } = require('./sessionCookie');

function verifyToken(token) {
  if (!token || !process.env.JWT_SECRET) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch (_) { return null; }
}

function bearerFrom(req) {
  const h = req && req.headers && req.headers['authorization'];
  if (!h || typeof h !== 'string') return null;
  return h.split(' ')[1] || null; // identical to the historical parsing in authMiddleware
}

/**
 * @returns {{ decoded: object|null, token: string|null, source: 'bearer'|'cookie'|null,
 *             presented: { bearer: boolean, cookie: boolean } }}
 */
function resolveSession(req) {
  const bearer = bearerFrom(req);
  const cookieTok = readSessionToken(req);
  const presented = { bearer: !!bearer, cookie: !!cookieTok };
  const b = verifyToken(bearer);
  if (b) return { decoded: b, token: bearer, source: 'bearer', presented };
  const c = verifyToken(cookieTok);
  if (c) return { decoded: c, token: cookieTok, source: 'cookie', presented };
  return { decoded: null, token: null, source: null, presented };
}

/** A verified payload is usable as an identity only when it carries both id and role. */
function identityFrom(decoded) {
  return decoded && decoded.id && decoded.role ? { id: decoded.id, role: decoded.role } : null;
}

module.exports = { resolveSession, verifyToken, identityFrom };
