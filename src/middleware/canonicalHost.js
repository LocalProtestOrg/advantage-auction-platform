'use strict';

/**
 * canonicalHostRedirect — permanently redirect typo-habit host aliases to the ONE canonical
 * auction-platform host, so a user who types "www." never hits a DNS/dead-end experience.
 *
 * Canonical host:  bid.advantage.bid
 * Alias(es):       www.bid.advantage.bid   (added as a Railway custom domain on the same service)
 *
 * Safety properties:
 *  - Matches ONLY the exact allowlisted alias(es) — the canonical host, staging, the Railway
 *    internal *.up.railway.app hostname, and localhost all fall through untouched (no loop).
 *  - The destination host is a FIXED constant; it is NEVER built from the incoming Host/
 *    X-Forwarded-Host header, so there is no open-redirect or Host-header-injection vector.
 *  - Preserves the exact path + query string (req.originalUrl) and stays on HTTPS.
 *  - 308 Permanent Redirect: permanent (SEO-correct, keeps bid.advantage.bid canonical) and
 *    preserves the HTTP method/body for the rare non-GET hitting the alias.
 *  - Relies on `app.set('trust proxy', 1)` so req.hostname reflects the single trusted
 *    X-Forwarded-Host hop from Railway's edge.
 */

const CANONICAL_HOST = 'bid.advantage.bid';
const HOST_ALIASES = new Set(['www.bid.advantage.bid']);

function canonicalHostRedirect(req, res, next) {
  const host = String(req.hostname || '').toLowerCase();
  if (HOST_ALIASES.has(host)) {
    return res.redirect(308, 'https://' + CANONICAL_HOST + req.originalUrl);
  }
  return next();
}

module.exports = { canonicalHostRedirect, CANONICAL_HOST, HOST_ALIASES };
