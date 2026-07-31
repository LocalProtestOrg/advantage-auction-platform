'use strict';

/**
 * sessionCookie — a server-readable session cookie that carries the SAME JWT the app already
 * issues for Authorization: Bearer API calls. It exists ONLY so the server can authenticate an
 * ordinary browser HTML navigation (localStorage/Bearer is not sent on navigations) and gate
 * private pages server-side. It does NOT replace the Bearer login; APIs keep using the header.
 *
 * Cookie hardening: HttpOnly (no JS access), Secure in production (HTTPS only, behind Railway's
 * proxy — trust proxy is set), SameSite=Lax (sent on top-level navigations so the gate works, but
 * not on cross-site subrequests), Path=/.
 */

const COOKIE_NAME = 'aap_session';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // mirror JWT_EXPIRES_IN default (24h)

function baseOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

function setSessionCookie(res, token) {
  try { res.cookie(COOKIE_NAME, token, Object.assign(baseOpts(), { maxAge: MAX_AGE_MS })); } catch (_) { /* never block the response */ }
}

function clearSessionCookie(res) {
  try { res.clearCookie(COOKIE_NAME, baseOpts()); } catch (_) { /* best-effort */ }
}

// Parse the session cookie WITHOUT a cookie-parser dependency.
function readSessionToken(req) {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return part.slice(i + 1).trim(); }
    }
  }
  return null;
}

module.exports = { COOKIE_NAME, setSessionCookie, clearSessionCookie, readSessionToken };
