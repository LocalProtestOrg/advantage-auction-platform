'use strict';

/**
 * marketingBrandMetadata — marketing-only metadata for later Desktop Marketing use. Pure data. This is
 * NOT product UI and must never be hard-coded into unrelated pages. It records owner preferences +
 * campaign-attribution distinctions so future marketing records stay consistent. Desktop Marketing owns
 * the visual/font/color calibration; nothing here locks exact treatment.
 */

// Owner copy-capitalization preference (metadata only). Relationship phrases use title-style presentation.
// Example: "In Conjunction with Advantage.Bid" (NOT "in conjunction with advantage.bid").
const COPY_CAPITALIZATION = {
  style: 'title_case_relationship_phrases',
  example_preferred: 'In Conjunction with Advantage.Bid',
  example_avoid: 'in conjunction with advantage.bid',
  note: 'Marketing headings/short relationship phrases prefer initial-capital/title style where natural. '
      + 'Do not hard-code this phrase into product UI; Desktop Marketing calibrates the visual treatment.',
};

// Minimal words to keep lowercase in title-style relationship phrases.
const MINOR = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'vs']);
// Helper (metadata utility, not applied to product UI): title-style a short phrase, preserving Advantage.Bid.
function titleStyle(phrase) {
  const words = String(phrase || '').trim().split(/\s+/);
  return words.map((w, i) => {
    if (/advantage\.bid/i.test(w)) return w.replace(/advantage\.bid/i, 'Advantage.Bid');
    const lower = w.toLowerCase();
    if (i !== 0 && MINOR.has(lower)) return lower;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

// Campaign attribution types so future marketing records distinguish who is advertising + the destination.
const CAMPAIGN_ATTRIBUTION_TYPES = [
  'advantage_general',            // Advantage.Bid-owned general auction campaign
  'individual_seller_event',      // an individual seller's event promoted under Advantage.Bid
  'professional_seller_campaign', // a Professional Seller's paid marketing campaign
  'seller_brand',                 // seller/company brand identity (reuse existing seller/org branding)
  'advantage_relationship',       // "in conjunction with Advantage.Bid" relationship attribution
];
const DESTINATION_TYPES = ['auction', 'event', 'estate_sale', 'storefront', 'lot_in_catalog'];

module.exports = { COPY_CAPITALIZATION, CAMPAIGN_ATTRIBUTION_TYPES, DESTINATION_TYPES, titleStyle, MINOR };
