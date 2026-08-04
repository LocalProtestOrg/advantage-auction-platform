'use strict';

/**
 * htmlAuthGate — server-side authentication gate for PRIVATE HTML pages. Mounted BEFORE
 * express.static so a private page is never served to an unauthenticated browser. It reads the
 * session cookie (same JWT the APIs use) and:
 *   - no/invalid session  → 302 redirect to /login.html?next=<safe same-origin path>
 *   - valid but wrong role → 302 redirect to /app.html (a safe authorized destination)
 *   - valid + allowed role → next() (express.static serves the page)
 * It also stamps protected pages `Cache-Control: no-store` so a logged-out Back navigation cannot
 * reveal a cached private page.
 *
 * Public pages are NOT gated (default = passthrough). This is a strict ALLOWLIST of private paths;
 * the API layer remains the authoritative data gate (401/403 + ownership checks).
 */

const jwt = require('jsonwebtoken');
const { readSessionToken } = require('../lib/sessionCookie');

// Tier requirements. Admin pages need 'admin'; clear seller-management pages need seller|admin;
// everything else private just needs a valid session (any role) — the APIs enforce finer access.
const ANY = ['buyer', 'seller', 'admin'];
const SELLER = ['seller', 'admin'];
const ADMIN = ['admin'];

// Exact private page paths → allowed roles.
const MEMBER_PAGES = new Set([
  '/app.html', '/my-bids.html', '/invoices.html', '/my-agreements.html',
  '/verify-documents.html', '/sign-agreement.html', '/billing.html', '/add-card.html',
  '/payment.html', '/auction.html', '/account.html', '/watchlist.html', '/dashboard.html',
  '/appraiser-welcome.html', // post-checkout onboarding (any signed-in member)
]);
const SELLER_PAGES = new Set([
  '/seller-create.html', '/seller-dashboard.html', '/lot-builder.html',
  '/seller-settlements.html', '/payout-profile.html',
]);
// Directory prefixes → allowed roles. Only .html (or the bare dir) is gated; JS/CSS assets under
// these dirs are non-sensitive UI code and are served normally.
const PREFIX_TIERS = [
  { prefix: '/admin', roles: ADMIN },
  { prefix: '/dashboard/', roles: SELLER },
  { prefix: '/org/', roles: ANY },
];

function isHtmlPath(p) { return p.endsWith('.html') || p.endsWith('/') || p === '/admin'; }

function requirement(pathname) {
  if (MEMBER_PAGES.has(pathname)) return ANY;
  if (SELLER_PAGES.has(pathname)) return SELLER;
  for (const t of PREFIX_TIERS) {
    if ((pathname === t.prefix || pathname.startsWith(t.prefix.endsWith('/') ? t.prefix : t.prefix + '/')) && isHtmlPath(pathname)) {
      return t.roles;
    }
  }
  return null; // public — do not gate
}

// Same-origin relative path only (mirrors login.html's open-redirect guard).
function safeNext(originalUrl) {
  if (typeof originalUrl !== 'string' || originalUrl.charAt(0) !== '/' ||
      originalUrl.charAt(1) === '/' || originalUrl.charAt(1) === '\\') return '/app.html';
  return originalUrl;
}

module.exports = function htmlAuthGate(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const roles = requirement(req.path);
  if (!roles) return next(); // public page/asset — let static serve it

  res.set('Cache-Control', 'no-store, must-revalidate');
  const toLogin = () => res.redirect(302, '/login.html?next=' + encodeURIComponent(safeNext(req.originalUrl)));

  const token = readSessionToken(req);
  if (!token) return toLogin();
  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch (_) { return toLogin(); }
  if (!decoded || !decoded.id || !decoded.role) return toLogin();

  if (!roles.includes(decoded.role)) {
    // Authenticated but insufficient role → safe authorized destination (their own home shell).
    return res.redirect(302, '/app.html');
  }
  return next(); // authorized — express.static serves the page
};

module.exports.requirement = requirement;
module.exports.safeNext = safeNext;
