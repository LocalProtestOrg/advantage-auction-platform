'use strict';

/**
 * govSurplusPlaceholder — the branded placeholder shown for GSA / Federal Surplus auctions whose official
 * photos are login-gated at the source (PPMS 401; see gsaConnector). PRESENTATION-ONLY. The gov-surplus
 * signal is derived SERVER-SIDE from the event's external_url (a gsaauctions.gov listing), so the
 * discovery-source URL itself is never exposed to clients (publicEvents policy) — only the placeholder
 * image path is returned. This gives every public surface (homepage map/event cards, marketplace + featured
 * widgets, event pages) the SAME branded placeholder with no per-surface frontend change and no change to
 * the importer, map, or event architecture.
 *
 * The asset lives at public/img/gsa-surplus-placeholder.svg (Advantage Design System tokens).
 */

const GOV_SURPLUS_PLACEHOLDER = '/img/gsa-surplus-placeholder.svg';
// Generic branded placeholder for external AUCTION partner events that have no real image and are not
// gov-surplus (tier 3 of the fallback hierarchy). Keeps the public marketplace free of broken images.
const AUCTION_PARTNER_PLACEHOLDER = '/img/auction-partner-placeholder.svg';

// A gsaauctions.gov listing URL marks a GSA / Federal Surplus auction.
function isGovSurplus(externalUrl) {
  return typeof externalUrl === 'string' && /gsaauctions\.gov/i.test(externalUrl);
}

// A login-gated PPMS image URL is not publicly displayable (401), so it must be treated as "no usable
// image" — this makes the placeholder apply to the events ALREADY imported with a ppms.gov url (existing
// prod rows), not just to future imports, without mutating production data.
function isNonPublicImage(url) { return typeof url === 'string' && /ppms\.gov/i.test(url); }

// JS fallback (for read paths that derive the cover image in JS). 3-tier hierarchy:
//   1. a publicly displayable REAL image, else
//   2. the branded GOV-SURPLUS placeholder (gsaauctions.gov events), else
//   3. the generic AUCTION-PARTNER placeholder for auction-type events (never a broken image), else null.
// saleType is optional; the generic auction placeholder is applied only to sale_type='auction' so
// estate sales / other types are not mislabeled.
function eventImage(realImageUrl, externalUrl, saleType) {
  const usable = (realImageUrl && !isNonPublicImage(realImageUrl)) ? realImageUrl : null;
  if (usable) return usable;
  if (isGovSurplus(externalUrl)) return GOV_SURPLUS_PLACEHOLDER;
  if (String(saleType || '').toLowerCase() === 'auction') return AUCTION_PARTNER_PLACEHOLDER;
  return null;
}

// SQL fallback (for query paths): wrap the existing event cover-image SQL expression so a login-gated
// ppms.gov image counts as no image, then fall back to the branded placeholder for gsaauctions.gov events.
// `extCol` defaults to the standard `e.external_url`. Never selects/returns external_url itself — only the
// placeholder path is surfaced. (The correlated subquery is tiny and the feed is cached.)
// SQL fallback (query paths), 3-tier. `saleTypeCol` (optional) enables the generic auction-partner
// placeholder for sale_type='auction' rows without a real/gov image, so the feed never yields a null
// image for an auction card. When saleTypeCol is omitted, behavior is the original 2-tier (real →
// gov-surplus → null) to preserve existing callers exactly.
function coverImageSql(realImageExpr, extCol = 'e.external_url', saleTypeCol = null) {
  const img = `(${realImageExpr})`;
  const usable = `CASE WHEN ${img} ILIKE '%ppms.gov%' THEN NULL ELSE ${img} END`;
  const gov = `CASE WHEN ${extCol} ILIKE '%gsaauctions.gov%' THEN '${GOV_SURPLUS_PLACEHOLDER}' END`;
  const generic = saleTypeCol
    ? `, CASE WHEN lower(${saleTypeCol}) = 'auction' THEN '${AUCTION_PARTNER_PLACEHOLDER}' END`
    : '';
  return `COALESCE(${usable}, ${gov}${generic})`;
}

module.exports = { GOV_SURPLUS_PLACEHOLDER, AUCTION_PARTNER_PLACEHOLDER, isGovSurplus, isNonPublicImage, eventImage, coverImageSql };
