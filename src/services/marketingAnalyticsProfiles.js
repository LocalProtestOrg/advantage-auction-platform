'use strict';

/**
 * marketingAnalyticsProfiles — seller-facing report profiles via an ALLOWLIST. New internal fields are
 * invisible by default; only explicitly allowlisted, genuinely-populated metrics display. Internal
 * economics (direct-spend ceiling, Growth Pool, allocation, margin, settlement loss, marketing ledger,
 * derivable internal split) can NEVER appear. Missing metric ≠ zero — an absent field is omitted, not 0.
 */
const configService = require('./configService');

const DEFAULTS = {
  standard: ['gross_revenue_cents', 'sold_lots', 'total_lots', 'unique_buyers_count', 'seller_payout_cents', 'platform_fee_cents', 'processing_fee_cents'],
  detailed: ['gross_revenue_cents', 'sold_lots', 'total_lots', 'unsold_lots', 'unique_buyers_count', 'highest_sale_cents', 'seller_payout_cents', 'platform_fee_cents', 'processing_fee_cents', 'buyer_premium_cents'],
};

// Fields that must NEVER surface on a seller/public report, regardless of allowlist edits (defense in depth).
const FORBIDDEN = /(direct_max|direct_reserved|direct_spent|growth|allocation|shortfall|marketing_ledger|internal|margin|60_40|monthly_authority)/i;

async function allowlistFor(profile) {
  const key = profile === 'detailed' ? 'marketing.analytics.detailed_allowlist' : 'marketing.analytics.standard_allowlist';
  try {
    const v = await configService.get(null, key);
    if (Array.isArray(v) && v.length) return v.filter((k) => !FORBIDDEN.test(k));
  } catch (_) { /* fall through */ }
  return DEFAULTS[profile === 'detailed' ? 'detailed' : 'standard'];
}

// Project a source metrics object onto the allowlist. Only KEYS PRESENT (populated) in source are included;
// a missing metric is omitted (never defaulted to 0). Forbidden keys are dropped even if present.
function applyAllowlist(source, allowlist) {
  const out = {};
  const src = source || {};
  for (const k of allowlist) {
    if (FORBIDDEN.test(k)) continue;
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] != null) out[k] = src[k];
  }
  return out;
}

// Build a seller report profile from a raw report summary. Never leaks internal fields.
async function sellerReportProfile(reportSummary, profile = 'standard') {
  const allowlist = await allowlistFor(profile);
  return applyAllowlist(reportSummary, allowlist);
}

// Guard usable by tests: assert an object exposes no forbidden internal field.
function assertNoInternal(obj) {
  for (const k of Object.keys(obj || {})) {
    if (FORBIDDEN.test(k)) throw new Error('Internal economics field leaked to a seller report: ' + k);
  }
  return true;
}

module.exports = { DEFAULTS, FORBIDDEN, allowlistFor, applyAllowlist, sellerReportProfile, assertNoInternal };
