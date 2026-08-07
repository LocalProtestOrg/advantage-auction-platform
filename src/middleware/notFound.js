'use strict';

/**
 * notFound — the platform 404 handler (launch fix H-5).
 *
 * Browser/page requests get a BRANDED Advantage.Bid HTML 404 (using the onboarding design system:
 * onboarding.css + `ob-` classes) with a clear way back to Home and Search/Discovery. API requests
 * (`/api/...`) and non-HTML clients keep the exact JSON 404 contract. The HTTP 404 status is always
 * preserved, and the page is `noindex` so a 404 is never indexed.
 */

function notFoundHtml() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<meta name="robots" content="noindex">'
    + '<title>Page not found - Advantage.Bid</title>'
    + '<link rel="icon" type="image/svg+xml" href="/favicon.svg">'
    + '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&display=swap" rel="stylesheet">'
    + '<link rel="stylesheet" href="/widgets/shared/onboarding.css">'
    + '</head><body class="ob-body"><div class="ob-wrap ob-narrow"><div class="ob-hero" style="padding:64px 18px 34px">'
    + '<div class="ob-kick">Error 404</div>'
    + '<h1 class="ob-h1">We couldn&rsquo;t find that page</h1>'
    + '<p class="ob-lede">The link may be old or mistyped. Let&rsquo;s get you back to the auctions and estate sales.</p>'
    + '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:24px">'
    + '<a class="ob-cta" href="/">Go to Advantage.Bid home</a>'
    + '<a class="ob-cta-2" href="/search.html">Search &amp; discover</a>'
    + '</div></div></div></body></html>';
}

// Express catch-all 404. JSON for /api/* and non-HTML clients; branded HTML for browser page requests.
function notFoundHandler(req, res) {
  res.status(404);
  const wantsHtml = !req.path.startsWith('/api/') && !!req.accepts('html');
  if (!wantsHtml) return res.json({ error: 'Route not found' });
  return res.set('Content-Type', 'text/html; charset=utf-8').send(notFoundHtml());
}

module.exports = { notFoundHtml, notFoundHandler };
