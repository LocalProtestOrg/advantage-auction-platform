'use strict';

/**
 * sellerBranding — the single source of truth for whether a seller's IDENTITY may be shown to BUYERS
 * on the auction marketplace (bid.advantage.bid). Policy:
 *   - PRIVATE / individual sellers (private, other, and anything not professional) are ALWAYS anonymous
 *     to buyers — name/logo/bio/location are never disclosed.
 *   - PROFESSIONAL / business sellers (auction_house, estate_sale_company, professional_liquidator,
 *     business) MAY display approved company branding, gated by the per-seller preference
 *     seller_profiles.show_branding_to_buyers (default true). If disabled, they behave like a private
 *     seller (fully anonymous).
 * The public seller DIRECTORY on advantage.bid is a separate discovery product and is NOT governed here.
 */

const PROFESSIONAL_TYPES = ['auction_house', 'estate_sale_company', 'professional_liquidator', 'business'];

function isProfessional(sellerType) {
  return PROFESSIONAL_TYPES.indexOf(String(sellerType || '').toLowerCase()) !== -1;
}

// Whether buyer-facing branding is visible for this seller.
function brandingVisible(sellerType, showBrandingToBuyers) {
  return isProfessional(sellerType) && showBrandingToBuyers !== false;
}

// Scrub seller-identity fields from a buyer-facing row unless branding is visible. Mutates + returns.
// Leaves opaque internal ids (seller_id) intact for internal filtering; nulls only IDENTITY fields.
const IDENTITY_FIELDS = ['seller_display_name', 'seller_logo_url', 'seller_location_label', 'seller_bio', 'seller_profile_id'];
function scrubSellerIdentity(row) {
  if (!row) return row;
  if (!brandingVisible(row.seller_type, row.show_branding_to_buyers)) {
    for (const f of IDENTITY_FIELDS) if (f in row) row[f] = null;
  }
  // Never expose the raw preference flag to buyers.
  delete row.show_branding_to_buyers;
  return row;
}

function scrubRows(rows) {
  if (Array.isArray(rows)) rows.forEach(scrubSellerIdentity);
  return rows;
}

/**
 * SQL: emit a seller-identity column that is NULL unless buyer-branding is visible. `col` is the
 * source expression (e.g. 'sp.display_name'), `st` the seller_type expression (e.g. 'sp.seller_type'),
 * `pref` the preference expression (e.g. 'sp.show_branding_to_buyers'). Applies the identical rule as
 * brandingVisible() directly in the query, so buyer feeds never even SELECT hidden identity.
 */
function brandedColSql(col, st, pref) {
  st = st || 'sp.seller_type';
  pref = pref || 'sp.show_branding_to_buyers';
  return `CASE WHEN ${st} IN ('auction_house','estate_sale_company','professional_liquidator','business') `
    + `AND COALESCE(${pref}, true) THEN ${col} ELSE NULL END`;
}

module.exports = {
  PROFESSIONAL_TYPES, isProfessional, brandingVisible,
  scrubSellerIdentity, scrubRows, brandedColSql, IDENTITY_FIELDS,
};
