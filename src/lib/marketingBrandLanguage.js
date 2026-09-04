'use strict';

/**
 * marketingBrandLanguage — Tier-3 versioned FIXED language for financial/fee claims. Agents do NOT
 * free-generate fee/economics wording; they render these templates. Placeholder safety: an unfilled
 * placeholder makes render() THROW (never publish a half-filled fee claim). Fee facts match the
 * centralized pricing architecture and NEVER present the professional fees as a single "7% commission".
 */

const VERSION = 'tier3-v1';
const UNFILLED = '[[UNFILLED_PLACEHOLDER]]'; // sentinel that never appears in copy; presence after fill = missing var

const TEMPLATES = Object.freeze({
  // Individual auction: 0% Advantage.Bid fee + 3% processing; 18% buyer premium (buyer-paid).
  individual_auction_fees:
    'Advantage.Bid charges individual sellers no platform or seller fee (0%). A {{processing_pct}} payment-processing fee applies to cover card processing. The standard buyer’s premium is {{buyer_premium_pct}}, paid by the buyer.',
  individual_seller_marketing:
    'No seller fees charged from Advantage.Bid. (A {{processing_pct}} payment-processing fee still applies.)',
  // Professional auction: platform + processing shown SEPARATELY (never "7% commission").
  professional_auction_fees:
    'Advantage.Bid platform/software fee: {{platform_pct}} of the hammer price. Payment processing: {{processing_pct}} of the hammer price. These are shown separately and are not a single combined commission.',
  // Professional storefront: 11% inclusive of processing (never append another 3%).
  storefront_fees:
    'Professional Storefront seller fee: {{storefront_pct}} of the item price, inclusive of payment processing.',
});

// Render a fixed-language template. Missing/blank placeholder → throw (placeholder safety).
function render(key, vars = {}) {
  const t = TEMPLATES[key];
  if (!t) throw new Error('Unknown brand-language template: ' + key);
  const out = t.replace(/{{\s*(\w+)\s*}}/g, function (_m, k) {
    const v = vars[k];
    return (v == null || String(v).trim() === '') ? UNFILLED : String(v);
  });
  if (out.indexOf(UNFILLED) !== -1) {
    throw new Error('Unfilled fixed-language placeholder in template "' + key + '" — refusing to render.');
  }
  assertNoBannedFeeClaim(out);
  return out;
}

// Guard: never present professional fees as one combined Advantage.Bid commission/percentage.
function assertNoBannedFeeClaim(text) {
  if (/7\s*%\s*(advantage\.?bid|commission|platform fee|seller fee)/i.test(text) ||
      /(advantage\.?bid|platform)\s*commission/i.test(text)) {
    throw new Error('Banned combined-fee claim detected in brand language.');
  }
  return true;
}

module.exports = { VERSION, TEMPLATES, render, assertNoBannedFeeClaim };
