'use strict';

/**
 * Professional Seller business categories (owner decision 2026-11-10).
 *
 * "Professional Seller" is the umbrella classification for a legitimate business using Advantage.Bid's professional
 * selling tools. The categories DESCRIBE the business (a seller selects all that apply and can change them later); they
 * never decide which tools it may use. Every Professional Seller gets fixed-price selling, a storefront and website
 * widget, online auctions and estate sale events through one account, subject to each feature's own safeguards.
 *
 * Storage: seller_profiles.business_categories (text[], migration 229). seller_profiles.seller_type stays the account's
 * classification (Individual vs Professional, and the legacy primary type every existing rule reads through
 * sellerTypeRules.isProfessional). It is set from the categories only when a seller BECOMES professional; changing the
 * categories later never reclassifies the account. A seller with no stored categories (everyone before migration 229)
 * is described by its seller_type (categoriesFor).
 */

const BUSINESS_CATEGORIES = ['auction_house', 'estate_sale_company', 'professional_liquidator', 'retail_resale', 'gallery_studio', 'other_professional'];

const BUSINESS_CATEGORY_LABELS = {
  auction_house: 'Auction House',
  estate_sale_company: 'Estate Sale Company',
  professional_liquidator: 'Professional Liquidator',
  retail_resale: 'Retail Shop or Resale Business',
  gallery_studio: 'Gallery or Studio',
  other_professional: 'Other Professional Selling Business',
};

// The professional seller_type recorded when a seller becomes professional: the first match in this order.
const PRIMARY_TYPE_ORDER = [
  ['auction_house', 'auction_house'],
  ['estate_sale_company', 'estate_sale_company'],
  ['professional_liquidator', 'professional_liquidator'],
  ['retail_resale', 'retail_gallery_studio'],
  ['gallery_studio', 'retail_gallery_studio'],
  ['other_professional', 'retail_gallery_studio'],
];

// The description an existing seller had before categories existed.
const LEGACY = { auction_house: ['auction_house'], estate_sale_company: ['estate_sale_company'],
  professional_liquidator: ['professional_liquidator'], retail_gallery_studio: ['retail_resale'] };

/** Validate a submitted list: known values only, de-duplicated, in canonical order. Returns { ok, categories, invalid }. */
function normalizeCategories(input) {
  const list = Array.isArray(input) ? input : (input == null ? [] : [input]);
  const wanted = new Set(); const invalid = [];
  for (const v of list) {
    const k = String(v == null ? '' : v).trim().toLowerCase();
    if (!k) continue;
    if (BUSINESS_CATEGORIES.includes(k)) wanted.add(k); else invalid.push(k);
  }
  return { ok: !invalid.length && wanted.size > 0, categories: BUSINESS_CATEGORIES.filter((c) => wanted.has(c)), invalid };
}

function primarySellerTypeFor(categories) {
  for (const [cat, type] of PRIMARY_TYPE_ORDER) if ((categories || []).includes(cat)) return type;
  return null;
}

/** The categories describing a seller profile row ({ business_categories, seller_type }). */
function categoriesFor(sp) {
  const stored = sp && Array.isArray(sp.business_categories) ? sp.business_categories.filter((c) => BUSINESS_CATEGORIES.includes(c)) : [];
  if (stored.length) return stored;
  return (sp && LEGACY[sp.seller_type]) || [];
}

function labelsFor(categories) { return (categories || []).map((c) => BUSINESS_CATEGORY_LABELS[c]).filter(Boolean); }

module.exports = { BUSINESS_CATEGORIES, BUSINESS_CATEGORY_LABELS, normalizeCategories, primarySellerTypeFor, categoriesFor, labelsFor };
