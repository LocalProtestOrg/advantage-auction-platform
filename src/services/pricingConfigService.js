'use strict';

/**
 * pricingConfigService — the SINGLE authoritative reader for centralized Advantage.Bid pricing.
 *
 * Reads the `pricing.*` keys from platform_config (configService hierarchy) with safe fallbacks to the
 * code-owned defaults, so a fresh environment still returns correct numbers before the migration seeds
 * them. Platform (4%) and processing (3%) are ALWAYS kept as SEPARATE values — the 7% total is DERIVED
 * here (never stored, never independently editable). This service resolves the CURRENT standard pricing;
 * it is used at publish-time snapshotting and in the Admin Pricing & Fees UI. Live settlement reads the
 * FROZEN per-auction snapshot, not this service, so historical/in-flight economics never shift.
 */

const configService = require('./configService');

// Code-owned defaults (mirror settlementPolicy / billingTermsService). Basis points unless *_cents.
const KEYS = Object.freeze({
  PRO_PLATFORM_BPS:        'pricing.auction.professional.platform_fee_bps',
  PROCESSING_BPS:          'pricing.auction.processing_fee_bps',
  INDIVIDUAL_PLATFORM_BPS: 'pricing.auction.individual.platform_fee_bps',
  INDIVIDUAL_BP_BPS:       'pricing.auction.individual.buyer_premium_bps',
  STOREFRONT_FEE_BPS:      'pricing.storefront.seller_fee_bps',
  ESTATE_SALE_CENTS:       'pricing.estate_sale.price_cents',
  APPRAISER_CENTS:         'pricing.appraiser.price_cents',
});
const DEFAULTS = Object.freeze({
  [KEYS.PRO_PLATFORM_BPS]: 400,
  [KEYS.PROCESSING_BPS]: 300,
  [KEYS.INDIVIDUAL_PLATFORM_BPS]: 0,
  [KEYS.INDIVIDUAL_BP_BPS]: 1800,
  [KEYS.STOREFRONT_FEE_BPS]: 1100,
  [KEYS.ESTATE_SALE_CENTS]: 3900,
  [KEYS.APPRAISER_CENTS]: 1999,
});
const MAX_BPS = 2500; // validation ceiling (25%), mirrors buyer_premium/platform ceilings

// Read one integer config value (bps or cents) with fallback to the code default. Never throws.
async function getInt(key) {
  try {
    const v = await configService.get(null, key);
    if (v !== null && v !== undefined && v !== '') {   // an unset key returns null → use the code default
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
    }
  } catch (_) { /* fall through to default */ }
  return DEFAULTS[key];
}

// The full CURRENT standard pricing model. Components stay separate; totals are derived here.
async function getPricing() {
  const [proPlatform, processing, indPlatform, indBp, storefront, estate, appraiser] = await Promise.all([
    getInt(KEYS.PRO_PLATFORM_BPS), getInt(KEYS.PROCESSING_BPS), getInt(KEYS.INDIVIDUAL_PLATFORM_BPS),
    getInt(KEYS.INDIVIDUAL_BP_BPS), getInt(KEYS.STOREFRONT_FEE_BPS), getInt(KEYS.ESTATE_SALE_CENTS),
    getInt(KEYS.APPRAISER_CENTS),
  ]);
  return {
    auction: {
      professional: {
        platform_fee_bps: proPlatform,
        processing_fee_bps: processing,
        total_seller_deduction_bps: proPlatform + processing, // DERIVED — display only, never editable
      },
      individual: {
        platform_fee_bps: indPlatform,
        processing_fee_bps: processing,
        buyer_premium_bps: indBp,
        total_seller_deduction_bps: indPlatform + processing, // DERIVED
      },
    },
    storefront: { seller_fee_bps: storefront, processing_included: true },
    estate_sale: { price_cents: estate },
    appraiser: { price_cents: appraiser },
  };
}

// The processing bps that a NEW auction snapshot should freeze (same for pro + individual).
async function currentProcessingBps() { return getInt(KEYS.PROCESSING_BPS); }
// The professional platform default (per-seller override still wins upstream).
async function currentProPlatformBps() { return getInt(KEYS.PRO_PLATFORM_BPS); }

// Persist an editable rate (Super Admin only — authorization enforced by the route). Validates range.
async function setBps(key, bps) {
  const n = Math.trunc(Number(bps));
  if (!Number.isFinite(n) || n < 0 || n > MAX_BPS) {
    const e = new Error('Rate must be an integer between 0 and ' + MAX_BPS + ' basis points.');
    e.status = 400; e.code = 'INVALID_RATE'; throw e;
  }
  await configService.setPlatformConfig(key, n);
  return n;
}

module.exports = { KEYS, DEFAULTS, MAX_BPS, getInt, getPricing, currentProcessingBps, currentProPlatformBps, setBps };
