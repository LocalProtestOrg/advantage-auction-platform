'use strict';

/**
 * organizerPrivacy — single source of truth for whether an EVENT organizer's identity may be shown on
 * public surfaces. The events counterpart to sellerBranding (which governs auction sellers only).
 *
 * Policy: ONLY professional organizations (companies) are publicly attributed as an event host. An
 * INDIVIDUAL / homeowner organizer — e.g. the $39 Estate Sale Promotion auto-creates an organization
 * named after the person (org type NULL / 'individual') — is ALWAYS anonymous: its name, slug, and logo
 * are never surfaced on any public events API, marketplace feed, JSON-LD, byline, or related-companies
 * list. Fail-closed: an unknown/absent org type is treated as NON-professional (anonymous).
 *
 * Imported events do NOT use the owning org (they carry a source `organizer_name` — a professional
 * company from the directory); that path is handled in the serializers and is unaffected here.
 */

const PROFESSIONAL_ORG_TYPES = [
  'auction_company', 'auction_house', 'estate_sale_company', 'professional_liquidator',
  'consignment_company', 'moving_company', 'cleanout_company', 'clean_out_company',
];

// Whether an organization of this type may be publicly named as an event host.
function isPublicOrganizer(orgType) {
  return PROFESSIONAL_ORG_TYPES.indexOf(String(orgType || '').toLowerCase()) !== -1;
}

// SQL: emit an organizer column only for professional organizer types, else NULL — so buyer/public
// feeds never even SELECT an individual's identity. `col` is the source expression (e.g. 'o.name'),
// `typeExpr` the org-type expression (default 'o.type').
function organizerColSql(col, typeExpr) {
  typeExpr = typeExpr || 'o.type';
  const list = PROFESSIONAL_ORG_TYPES.map((t) => `'${t}'`).join(',');
  return `CASE WHEN lower(${typeExpr}) IN (${list}) THEN ${col} ELSE NULL END`;
}

module.exports = { PROFESSIONAL_ORG_TYPES, isPublicOrganizer, organizerColSql };
