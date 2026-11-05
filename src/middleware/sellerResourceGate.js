'use strict';

/**
 * sellerResourceGate: the Seller How To Center and its printable tools are for Professional Sellers and Advantage.Bid
 * administrators only (owner decision 2026-11-05). The Seller Demo stays public.
 *
 * Mounted BEFORE the How To route and express.static, it covers every way to the content:
 *   page      /seller-how-to (and /seller-how-to.html, which redirects to it)
 *   scripts   /js/seller-how-to.js (checklists and worksheet), /js/lot-label-layout.js
 *   download  /api/seller-resources/lot-labels.pdf
 * The pickup note templates (the lot editor's "Add a pickup note" menu: basic pickup safety wording) are for EVERY seller,
 * Individual and Professional, and administrators (owner decision 2026-11-05); still never public.
 * Paths are matched the way the static server resolves them (decoded, normalized, case-insensitive), so an encoded or
 * differently-cased address cannot slip past.
 *
 * Signed out: a page request goes to sign-in and returns to the same address; a script or download gets 401.
 * Signed in but not allowed (buyers, Individual Sellers, staff without a seller profile): a short 403 page that points to
 * the public Seller Demo; scripts and downloads get 403. Suspended accounts and ended sessions are refused.
 * Every answer is private, never cached and never indexed. The session is the same one the APIs and htmlAuthGate use.
 */
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { readSessionToken } = require('../lib/sessionCookie');
const { isProfessional } = require('../services/sellerTypeRules');

const PAGES = new Set(['/seller-how-to', '/seller-how-to.html']);
const FILES = new Set(['/js/seller-how-to.js', '/js/lot-label-layout.js', '/api/seller-resources/lot-labels.pdf']);
const ANY_SELLER_FILES = new Set(['/widgets/shared/pickup-note-templates.js']);

function servedPath(p) {
  let d;
  try { d = decodeURIComponent(p); } catch (_e) { return null; }
  d = path.posix.normalize(d).toLowerCase();
  return d.length > 1 ? d.replace(/\/+$/, '') : d;
}

/** Who is asking: { state: 'none' } | { state: 'denied' } | { state: 'ok', role } (database-backed). anySeller: any seller profile. */
async function access(req, anySeller) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const token = readSessionToken(req) || (bearer && bearer[1]);
  if (!token) return { state: 'none' };
  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch (_) { return { state: 'none' }; }
  if (!decoded || !decoded.id) return { state: 'none' };
  try {
    const check = await require('../lib/sessionTokens').checkSession(decoded, token);
    if (check.state === 'revoked') return { state: 'none' };
  } catch (_) { /* unknown: the database lookup below still decides */ }
  const u = (await db.query(
    `SELECT u.role, COALESCE(u.is_active, true) AS is_active, sp.seller_type
       FROM users u LEFT JOIN seller_profiles sp ON sp.user_id = u.id WHERE u.id = $1`, [decoded.id])).rows[0];
  if (!u || !u.is_active) return { state: 'denied' };
  if (u.role === 'admin' || isProfessional(u.seller_type) || (anySeller && u.seller_type != null)) return { state: 'ok', role: u.role };
  return { state: 'denied' };
}

function deniedPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Seller How To Center | Advantage.Bid</title></head>
<body style="margin:0;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0f172a">
<main style="max-width:560px;margin:48px auto;padding:0 16px">
<h1 style="font-size:26px;margin:0 0 10px">The Seller How To Center is for Professional Sellers</h1>
<p style="font-size:17px;line-height:1.6;color:#334155">These guides and printable tools are part of a Professional Seller account. See what Advantage.Bid offers professional sellers in the Seller Demo, or open your dashboard.</p>
<p style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px"><a href="/seller-demo" style="background:#d62828;color:#fff;font-weight:700;text-decoration:none;padding:11px 16px;border-radius:10px">See the Seller Demo</a>
<a href="/app.html" style="border:1.5px solid #0f172a;color:#0f172a;font-weight:700;text-decoration:none;padding:10px 16px;border-radius:10px">Go To Your Dashboard</a></p>
</main></body></html>`;
}

module.exports = async function sellerResourceGate(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const served = servedPath(req.path);
  if (served === null) return res.status(400).end();
  const isPage = PAGES.has(served);
  const anySeller = ANY_SELLER_FILES.has(served);
  if (!isPage && !anySeller && !FILES.has(served)) return next();

  res.set({ 'Cache-Control': 'private, no-store, must-revalidate', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  let a;
  try { a = await access(req, anySeller); } catch (e) { console.error('[seller-resources] access check failed:', e.message); a = { state: 'denied' }; }
  if (a.state === 'ok') return next();
  if (a.state === 'none') {
    if (isPage) {
      const q = req.originalUrl.indexOf('?');
      return res.redirect(302, '/login.html?next=' + encodeURIComponent('/seller-how-to' + (q >= 0 ? req.originalUrl.slice(q) : '')));
    }
    return res.status(401).json({ success: false, message: 'Please sign in as a Professional Seller.' });
  }
  if (isPage) return res.status(403).type('html').send(deniedPage());
  return res.status(403).json({ success: false, message: anySeller ? 'Available to sellers.' : 'Available to Professional Sellers.' });
};
module.exports.servedPath = servedPath;
