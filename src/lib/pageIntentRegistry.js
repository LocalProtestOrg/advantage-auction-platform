'use strict';

/**
 * pageIntentRegistry — the ONE mapping from a public page path to a marketing INTENT label. Pure, no I/O.
 * Centralizes intent classification so path checks are not scattered across services. New pages can be
 * added here without a migration. Classification is deterministic and explainable (never a black box).
 *
 * Intent labels are behavioral CATEGORIES of interest, never sensitive/protected traits.
 */

// Ordered rules: first match wins. `test` is a RegExp on the URL PATH (lowercased, no query).
// `intent` is the durable label; `weight` is a base contribution to signal strength (1=weak..3=high).
// Rules are validated against ACTUAL production routes (Phase 4H). More-specific rules come first so a
// post-conversion/account page never falls through to a generic buyer/discovery classification.
const RULES = [
  // ── Account / post-conversion FIRST (must not read as buyer discovery or acquisition intent) ──
  // A buyer's own purchases page is ACCOUNT context, not marketplace discovery (Phase 4H / 3J fix).
  { test: /^\/marketplace-purchases/,                     intent: 'account', weight: 0 },
  { test: /^\/(account|my-bids|watchlist|invoices|my-agreements|payout-profile|billing|seller-dashboard|seller-settlements)/, intent: 'account', weight: 0 },
  // Post-conversion SELLER context (created/own an estate sale) — NOT buyer estate-sale interest (3J fix).
  { test: /^\/(estate-sale-welcome|my-estate-sales|appraiser-welcome)/, intent: 'seller_post_conversion', weight: 0 },

  // ── Seller acquisition funnel (REAL routes) ──
  // become-seller.html (no "a") is the canonical individual-seller intent page (3J fix).
  { test: /^\/(start-selling|become-seller|create-estate-sale|promote-estate-sale)(\/|$|\.html)/, intent: 'seller_intent_high', weight: 3, funnel: 'seller_signup_entry' },
  { test: /^\/(become-professional-seller|professional-sellers)/, intent: 'professional_seller_intent', weight: 2 },
  { test: /^\/(free-business-listing|get-listed)/,        intent: 'professional_seller_intent', weight: 2 },
  { test: /^\/how-sellers-get-paid/,                      intent: 'seller_consideration_high', weight: 2 },
  { test: /^\/(seller-faq|seller-pilot)/,                 intent: 'seller_consideration', weight: 2 },
  { test: /^\/(downsizing-liquidation|after-estate-sale)/, intent: 'seller_education', weight: 1 },

  // ── Buyer discovery / merchandise (REAL routes) ──
  { test: /^\/auction-view/,        intent: 'event_interest', weight: 2 },        // single auction detail (catalog)
  { test: /^\/event\.html|^\/event(\/|$)/, intent: 'estate_sale_interest', weight: 2 }, // event/estate-sale detail
  { test: /^\/events(\/|$|\.html)/, intent: 'estate_sale_interest', weight: 1 },  // All Events listing
  { test: /^\/(search|lot)(\/|$|\.html)/, intent: 'buyer_discovery', weight: 1 }, // auctions/lots search + lot detail
  { test: /^\/(featured-auctions|ending-soon|featured-lots)/, intent: 'auction_interest', weight: 1 },
  { test: /^\/(browse-categories|browse-locations)/, intent: 'marketplace_interest', weight: 1 },
  { test: /^\/(how-to-buy|buyer-faq|how-it-works)/, intent: 'buyer_education', weight: 1 },

  // ── Home ──
  { test: /^\/(index)?(\.html)?$|^\/$/, intent: 'home_discovery', weight: 1 },
];

// Normalize a URL or path to a lowercase path with no query/hash.
function pathOf(urlOrPath) {
  if (!urlOrPath) return '/';
  var s = String(urlOrPath);
  try {
    // Accept absolute URLs or bare paths.
    var p = s.indexOf('://') >= 0 ? new URL(s).pathname : s.split('?')[0].split('#')[0];
    return (p || '/').toLowerCase();
  } catch (_) {
    return s.split('?')[0].split('#')[0].toLowerCase() || '/';
  }
}

/** classify(urlOrPath) → { intent, weight, funnel } | null (unknown/uninteresting page). */
function classify(urlOrPath) {
  var path = pathOf(urlOrPath);
  for (var i = 0; i < RULES.length; i++) {
    if (RULES[i].test.test(path)) {
      return { intent: RULES[i].intent, weight: RULES[i].weight, funnel: RULES[i].funnel || null };
    }
  }
  return null;
}

// All distinct intents (for validation / admin display).
var INTENTS = Array.from(new Set(RULES.map(function (r) { return r.intent; })));

module.exports = { classify, pathOf, INTENTS, RULES };
