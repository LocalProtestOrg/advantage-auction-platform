'use strict';

/**
 * htmlInjection — shared rules for the middleware that adds tags to served HTML (analyticsTag, sashaTag).
 *
 * WHY (seller agreement defect, 2026-10-30). sashaTag inserted its <script> before the FIRST "</body>" in the page.
 * sign-agreement.html builds its printable copy in JavaScript and contained the text '</body></html>' inside an inline
 * script, so the tag landed inside that script. The injected "</script>" ended the page's script early: the seller
 * saw raw JavaScript and the agreement never loaded. Tags now go before the LAST closing tag, which is the document's
 * own, and capability-token pages get no third-party script at all.
 *
 *   beforeClosingBody(html, tag)  insert before the last </body>, or null when there is none
 *   afterHeadOpen(html, tag)      insert right after the real <head ...> opening tag (never <header>), or null
 *   isTokenPage(req)              a page reached with a secret in its address: an agreement signing link, a password
 *                                 reset, an invitation, an unsubscribe link... Third-party scripts (analytics) would
 *                                 receive the full address, secret included, so they are never added there.
 */

// Pages whose address always carries, or exists to carry, a secret.
const TOKEN_PAGES = new Set([
  '/sign-agreement.html', '/reset-password.html', '/authorize-event-promotion.html', '/claim-listing.html',
  '/seller-staff-invite.html', '/verify-email', '/verify-email.html', '/unsubscribe', '/unsubscribe.html',
]);
// Query parameters that carry a secret on any page (e.g. /auction-partner.html?invite=…).
const SECRET_PARAMS = ['token', 't', 'invite', 'key', 'code', 'claim'];

// A secret parameter anywhere in the address, including inside an encoded return address such as
// /login.html?next=%2Fsign-agreement.html%3Ftoken%3D… (the sign-in gate sends signing links through the login page).
const SECRET_IN_URL = new RegExp('(?:[?&]|%3F|%26)(?:' + SECRET_PARAMS.join('|') + ')(?:=|%3D)', 'i');

function isTokenPage(req) {
  const p = (req && req.path) || '/';
  if (TOKEN_PAGES.has(p)) return true;
  const q = (req && req.query) || {};
  if (SECRET_PARAMS.some((k) => q[k] != null && q[k] !== '')) return true;
  return SECRET_IN_URL.test(String((req && (req.originalUrl || req.url)) || ''));
}

function beforeClosingBody(html, tag) {
  if (typeof html !== 'string' || !html) return null;
  const at = html.toLowerCase().lastIndexOf('</body>');
  if (at === -1) return null;
  return html.slice(0, at) + tag + html.slice(at);
}

function afterHeadOpen(html, tag) {
  if (typeof html !== 'string' || !html) return null;
  const m = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!m) return null;
  const at = m.index + m[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}

module.exports = { TOKEN_PAGES, SECRET_PARAMS, isTokenPage, beforeClosingBody, afterHeadOpen };
