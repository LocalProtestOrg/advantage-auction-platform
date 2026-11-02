'use strict';

/**
 * Seller-type constants — single source of truth for the seller_type enum.
 *
 * Introduced in Seller-Type Rules Framework Phase B. The admin seller-type
 * assignment endpoint validates against SELLER_TYPES here; Phase C's
 * sellerTypeRules.js will import PROFESSIONAL_SELLER_TYPES from this same
 * module so the valid list and the professional classification never drift.
 *
 * MUST stay in sync with the CHECK constraint in
 * db/migrations/051_expand_seller_type.sql (and 211_retail_gallery_studio_seller_type.sql).
 *
 * NOTE: this module declares the classification only. No scheduling/pickup
 * rule is enforced in Phase B — enforcement is Phase C.
 */

// Legacy/non-professional types (existing since migration 001).
const NON_PROFESSIONAL_SELLER_TYPES = ['private', 'business', 'other'];

// Professional types (added in migration 051). Decision: exempt from the
// non-professional 48h pickup-gap rule in Phase C. Admin-assigned only.
// retail_gallery_studio (migration 211, owner decision 2026-11-02): "Retail Shop, Gallery or Studio" (antique shops,
// boutiques, galleries, working artists and makers, specialty retailers). A professional/business type like the others.
const PROFESSIONAL_SELLER_TYPES = ['auction_house', 'estate_sale_company', 'professional_liquidator', 'retail_gallery_studio'];

// Every valid seller_type value (matches the migration 051 CHECK).
const SELLER_TYPES = [...NON_PROFESSIONAL_SELLER_TYPES, ...PROFESSIONAL_SELLER_TYPES];

// Friendly labels for admin UI display.
const SELLER_TYPE_LABELS = {
  private:                 'Private',
  business:                'Business',
  other:                   'Other',
  auction_house:           'Auction House',
  estate_sale_company:     'Estate Sale Company',
  professional_liquidator: 'Professional Liquidator',
  retail_gallery_studio:   'Retail Shop, Gallery or Studio',
};

function isValidSellerType(value) {
  return SELLER_TYPES.includes(value);
}

module.exports = {
  SELLER_TYPES,
  NON_PROFESSIONAL_SELLER_TYPES,
  PROFESSIONAL_SELLER_TYPES,
  SELLER_TYPE_LABELS,
  isValidSellerType,
};
