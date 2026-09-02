'use strict';

/**
 * widgetFraming — allow ONLY the public widget assets under /widgets/* to be embedded
 * by the approved Brilliant Directories parent origins.
 *
 * Helmet applies `X-Frame-Options: SAMEORIGIN` globally, which (a) blocks cross-origin
 * embedding and (b) cannot express an allowlist. So for these routes — and ONLY these —
 * we drop X-Frame-Options and set a CSP `frame-ancestors` allowlist instead. Every other
 * route (admin, seller, buyer/member, auth, payment, dashboards, and the rest of the
 * site) keeps SAMEORIGIN completely untouched.
 *
 * Mounted right after helmet and before express.static, so this override is what ships.
 * The frame-ancestors list is deliberately narrow — the two approved BD origins only, not
 * a wildcard — so no arbitrary third-party site can frame the widgets.
 */

const FRAME_ANCESTORS = 'frame-ancestors https://advantage.bid https://www.advantage.bid';
// The white-label company auction widget (/embed/*) is installed on ARBITRARY Professional-Seller
// company websites, so it must be frameable by ANY origin. This is safe: /embed/* renders ONLY public,
// tokenized auction data — no authentication, no cookies-based session content, no private data, and all
// bidding/checkout/auth links out to the identified bid.advantage.bid platform. (Like a public video embed.)
const EMBED_FRAME_ANCESTORS = 'frame-ancestors *';

function widgetFraming(req, res, next) {
  if (req.path && req.path.startsWith('/widgets/')) {
    res.removeHeader('X-Frame-Options');            // SAMEORIGIN can't allowlist a parent origin
    res.setHeader('Content-Security-Policy', FRAME_ANCESTORS);
  } else if (req.path && req.path.startsWith('/embed/')) {
    res.removeHeader('X-Frame-Options');            // white-label host: embeddable on any company site
    res.setHeader('Content-Security-Policy', EMBED_FRAME_ANCESTORS);
  }
  next();
}

widgetFraming.FRAME_ANCESTORS = FRAME_ANCESTORS;
widgetFraming.EMBED_FRAME_ANCESTORS = EMBED_FRAME_ANCESTORS;
module.exports = widgetFraming;
