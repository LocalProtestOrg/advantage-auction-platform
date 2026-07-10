'use strict';
/**
 * billingTermsService — Buyer-Premium / agreement billing terms. PHASE 1: config
 * resolution + settlement PREVIEW only.
 *
 * NOT used for live charging or live payout. Buyers are charged hammer only and
 * sellers are paid the existing flat 10% (closeAuction/reportingService) until
 * Phase 2 (gated on Buyer Terms v2 + Stripe LIVE). Everything here is preview/
 * display for admin billing prep.
 *
 * Effective terms precedence per field: auction override (bps) → seller_terms
 * default (pct→bps) → platform default.
 */
const db = require('../db');

const DEFAULT_BUYER_PREMIUM_BPS         = 1800; // 18% buyer-facing premium
const DEFAULT_AAC_BP_SHARE_BPS          = 500;  // AAC keeps 5% of hammer from the BP
const DEFAULT_AAC_HAMMER_COMMISSION_BPS = 200;  // optional AAC 2% commission on hammer
// seller BP share = buyer_premium_bps − aac_bp_share_bps (default 1300 = 13%)

const pctToBps    = p => (p == null ? null : Math.round(Number(p) * 100));
const roundHalfUp = n => Math.floor(n + 0.5);

// Resolve the effective billing terms (in bps) for an auction.
async function resolveEffectiveTerms(auctionId, client = db) {
  const a = (await client.query(
    `SELECT a.buyer_premium_bps, a.aac_bp_share_bps, a.aac_hammer_commission_bps,
            st.buyer_premium_pct, st.aac_bp_share_pct, st.aac_hammer_commission_pct
       FROM auctions a
       LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
       LEFT JOIN seller_terms st ON st.seller_profile_id = sp.id AND st.superseded_at IS NULL
      WHERE a.id = $1`, [auctionId])).rows[0] || {};
  const pick = (auctionBps, sellerPct, dflt) =>
    auctionBps != null ? Number(auctionBps)
      : sellerPct != null ? pctToBps(sellerPct)
      : dflt;
  const buyer_premium_bps = pick(a.buyer_premium_bps, a.buyer_premium_pct, DEFAULT_BUYER_PREMIUM_BPS);
  let   aac_bp_share_bps  = pick(a.aac_bp_share_bps, a.aac_bp_share_pct, DEFAULT_AAC_BP_SHARE_BPS);
  if (aac_bp_share_bps > buyer_premium_bps) aac_bp_share_bps = buyer_premium_bps; // never exceed total BP
  const seller_bp_share_bps       = buyer_premium_bps - aac_bp_share_bps;
  const aac_hammer_commission_bps = pick(a.aac_hammer_commission_bps, a.aac_hammer_commission_pct, DEFAULT_AAC_HAMMER_COMMISSION_BPS);
  const source = {
    buyer_premium:         a.buyer_premium_bps != null ? 'auction' : a.buyer_premium_pct != null ? 'seller' : 'default',
    aac_bp_share:          a.aac_bp_share_bps != null ? 'auction' : a.aac_bp_share_pct != null ? 'seller' : 'default',
    aac_hammer_commission: a.aac_hammer_commission_bps != null ? 'auction' : a.aac_hammer_commission_pct != null ? 'seller' : 'default',
  };
  return { buyer_premium_bps, aac_bp_share_bps, seller_bp_share_bps, aac_hammer_commission_bps, source };
}

// PREVIEW settlement breakdown for a hammer total. Invariant: aac_bp_share +
// seller_bp_share === buyer_premium. NOT live money.
function computeSettlement(hammerCents, terms) {
  const h = Math.max(0, Math.round(hammerCents || 0));
  const buyer_premium_cents         = roundHalfUp(h * terms.buyer_premium_bps / 10000);
  const aac_bp_share_cents          = roundHalfUp(h * terms.aac_bp_share_bps / 10000);
  const seller_bp_share_cents       = buyer_premium_cents - aac_bp_share_cents;
  const aac_hammer_commission_cents = roundHalfUp(h * terms.aac_hammer_commission_bps / 10000);
  const net_seller_preview_cents    = h + seller_bp_share_cents - aac_hammer_commission_cents;
  const aac_total_preview_cents     = aac_bp_share_cents + aac_hammer_commission_cents;
  return {
    hammer_cents: h, buyer_premium_cents, aac_bp_share_cents, seller_bp_share_cents,
    aac_hammer_commission_cents, net_seller_preview_cents, aac_total_preview_cents,
    buyer_total_preview_cents: h + buyer_premium_cents,
  };
}

// Admin display helper: effective terms + preview for an auction's current gross.
async function getSettlementPreview(auctionId, client = db) {
  const gross = (await client.query(
    `SELECT COALESCE(SUM(winning_amount_cents),0)::int g FROM lots WHERE auction_id=$1 AND state='closed'`, [auctionId])).rows[0].g
    || (await client.query(`SELECT COALESCE(SUM(current_bid_cents),0)::int g FROM lots WHERE auction_id=$1`, [auctionId])).rows[0].g;
  const terms = await resolveEffectiveTerms(auctionId, client);
  return {
    active: false,
    note: 'PREVIEW ONLY. Buyer premium is NOT charged and seller payout is NOT changed in Phase 1. Live payout remains the flat 10%.',
    effective_terms_bps: terms,
    gross_hammer_cents: gross,
    preview: computeSettlement(gross, terms),
  };
}

// Compute + persist the PREVIEW breakdown onto seller_payouts (additive columns).
// Best-effort, post-commit; NEVER alters gross/platform_fee/seller_payout (flat 10%).
async function storeSettlementPreview(auctionId) {
  try {
    const p = await getSettlementPreview(auctionId);
    const s = p.preview;
    await db.query(
      `UPDATE seller_payouts
          SET buyer_premium_cents=$2, aac_bp_share_cents=$3, seller_bp_share_cents=$4,
              aac_hammer_commission_cents=$5, terms_snapshot=$6, updated_at=now()
        WHERE auction_id=$1`,
      [auctionId, s.buyer_premium_cents, s.aac_bp_share_cents, s.seller_bp_share_cents,
       s.aac_hammer_commission_cents, JSON.stringify({ active: false, effective_terms_bps: p.effective_terms_bps, computed: s })]
    );
  } catch (e) { console.error('[billingTerms] storeSettlementPreview failed (non-fatal):', e.message); }
}

module.exports = {
  DEFAULT_BUYER_PREMIUM_BPS, DEFAULT_AAC_BP_SHARE_BPS, DEFAULT_AAC_HAMMER_COMMISSION_BPS,
  resolveEffectiveTerms, computeSettlement, getSettlementPreview, storeSettlementPreview,
};
