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

// A gsaauctions.gov listing URL marks a GSA / Federal Surplus auction.
function isGovSurplus(externalUrl) {
  return typeof externalUrl === 'string' && /gsaauctions\.gov/i.test(externalUrl);
}

// A login-gated PPMS image URL is not publicly displayable (401), so it must be treated as "no usable
// image" — this makes the placeholder apply to the events ALREADY imported with a ppms.gov url (existing
// prod rows), not just to future imports, without mutating production data.
function isNonPublicImage(url) { return typeof url === 'string' && /ppms\.gov/i.test(url); }

// JS fallback (for read paths that derive the cover image in JS): a publicly displayable real image, else
// the branded placeholder for a gov-surplus event, else null.
function eventImage(realImageUrl, externalUrl) {
  const usable = (realImageUrl && !isNonPublicImage(realImageUrl)) ? realImageUrl : null;
  if (usable) return usable;
  return isGovSurplus(externalUrl) ? GOV_SURPLUS_PLACEHOLDER : null;
}

// SQL fallback (for query paths): wrap the existing event cover-image SQL expression so a login-gated
// ppms.gov image counts as no image, then fall back to the branded placeholder for gsaauctions.gov events.
// `extCol` defaults to the standard `e.external_url`. Never selects/returns external_url itself — only the
// placeholder path is surfaced. (The correlated subquery is tiny and the feed is cached.)
function coverImageSql(realImageExpr, extCol = 'e.external_url') {
  const img = `(${realImageExpr})`;
  const usable = `CASE WHEN ${img} ILIKE '%ppms.gov%' THEN NULL ELSE ${img} END`;
  return `COALESCE(${usable}, CASE WHEN ${extCol} ILIKE '%gsaauctions.gov%' THEN '${GOV_SURPLUS_PLACEHOLDER}' END)`;
}

module.exports = { GOV_SURPLUS_PLACEHOLDER, isGovSurplus, eventImage, coverImageSql };
