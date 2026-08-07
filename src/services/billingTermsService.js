'use strict';
/**
 * billingTermsService — the SINGLE SOURCE OF TRUTH for Advantage.Bid buyer-premium and
 * seller-fee policy (owner-approved launch policy; supersedes the 0% pilot decision and the
 * legacy 10% platform fee). Pure, cents-safe (integer bps math, deterministic lot-level rounding).
 * Invoicing AND settlement both consume THIS module, so there is exactly one financial model.
 *
 * INDIVIDUAL sellers (private / business / other / untyped):
 *   • Buyer premium is FIXED at 18% (DEFAULT_BUYER_PREMIUM_BPS). Server-authoritative — auction
 *     overrides and seller_terms are IGNORED for individuals; they cannot change the rate.
 *   • 100% of the individual buyer premium is Advantage.Bid revenue. The seller receives the hammer.
 *   • No separate hammer platform fee.
 *
 * PROFESSIONAL sellers (auction_house / estate_sale_company / professional_liquidator — admin-approved):
 *   • The seller CONTROLS the buyer premium: auction override → seller default → platform fallback (18%).
 *   • The seller keeps their buyer premium (it is NOT Advantage revenue).
 *   • Advantage charges the professional a 2% software/platform fee on total hammer-price sales.
 */
const db = require('../db');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');

const DEFAULT_BUYER_PREMIUM_BPS = 1800;  // 18% — individual FIXED rate + professional fallback
const PRO_PLATFORM_FEE_BPS      = 200;   // 2% of hammer — Advantage software fee for professionals
const INDIVIDUAL_PLATFORM_FEE_BPS = 0;   // individuals: no hammer fee (Advantage revenue is the buyer premium)

const roundHalfUp = (n) => Math.floor(Number(n || 0) + 0.5);
const isProfessional = (t) => PROFESSIONAL_SELLER_TYPES.indexOf(String(t || '').toLowerCase()) !== -1;

// The effective buyer-premium bps for a seller. INDIVIDUAL → always 1800 (overrides ignored).
// PROFESSIONAL → auction override (bps) → seller default (pct→bps) → platform fallback 1800.
function effectiveBuyerPremiumBps(sellerType, opts = {}) {
  if (!isProfessional(sellerType)) return DEFAULT_BUYER_PREMIUM_BPS; // individual — fixed, non-overridable
  if (opts.auctionBps != null) return Math.max(0, Math.round(Number(opts.auctionBps)));
  if (opts.sellerPct != null) return Math.max(0, Math.round(Number(opts.sellerPct) * 100));
  return DEFAULT_BUYER_PREMIUM_BPS;
}

// Buyer premium for ONE lot, from that lot's hammer price. Cents-safe, deterministic rounding.
function lotBuyerPremiumCents(hammerCents, bps) {
  const h = Math.max(0, Math.round(Number(hammerCents) || 0));
  return roundHalfUp(h * (Number(bps) || 0) / 10000);
}

// Sum of PER-LOT buyer premiums (each lot rounded independently BEFORE aggregation). Accepts lot rows
// (winning_amount_cents), plain objects (hammerCents), or bare numbers.
function buyerPremiumForLots(lots, bps) {
  return (Array.isArray(lots) ? lots : []).reduce((sum, l) => {
    if (l == null) return sum;
    const h = (typeof l === 'number') ? l
      : (l.winning_amount_cents != null ? l.winning_amount_cents
        : (l.hammerCents != null ? l.hammerCents : 0));
    return sum + lotBuyerPremiumCents(h, bps);
  }, 0);
}

// The ONE settlement model. Given the seller type + aggregate hammer + already-summed buyer premium,
// returns what the buyer pays, Advantage's revenue, and the seller's payout — the SAME numbers used
// for both the preview and the actual payout (no divergence).
function settlement({ sellerType, hammerCents, buyerPremiumCents }) {
  const h = Math.max(0, Math.round(Number(hammerCents) || 0));
  const bp = Math.max(0, Math.round(Number(buyerPremiumCents) || 0));
  const buyer_total_cents = h + bp;
  if (isProfessional(sellerType)) {
    const platform_fee_cents = lotBuyerPremiumCents(h, PRO_PLATFORM_FEE_BPS); // 2% of hammer only
    return {
      seller_type: 'professional', hammer_cents: h, buyer_premium_cents: bp, buyer_total_cents,
      platform_fee_cents,                                    // Advantage 2% software fee
      advantage_revenue_cents: platform_fee_cents,           // professional BP is NOT Advantage revenue
      seller_gross_cents: h + bp,                            // seller keeps hammer + their own premium
      seller_payout_cents: h + bp - platform_fee_cents,
    };
  }
  return {                                                   // individual
    seller_type: 'individual', hammer_cents: h, buyer_premium_cents: bp, buyer_total_cents,
    platform_fee_cents: INDIVIDUAL_PLATFORM_FEE_BPS,         // 0 — no hammer fee
    advantage_revenue_cents: bp,                             // 100% of the buyer premium
    seller_gross_cents: h,                                   // seller receives the hammer only
    seller_payout_cents: h,
  };
}

// Resolve the effective terms for an auction from the DB (seller type + configured overrides).
async function resolveEffectiveTerms(auctionId, client = db) {
  const a = (await client.query(
    `SELECT a.buyer_premium_bps, sp.seller_type, st.buyer_premium_pct
       FROM auctions a
       LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
       LEFT JOIN seller_terms st ON st.seller_profile_id = sp.id AND st.superseded_at IS NULL
      WHERE a.id = $1`, [auctionId])).rows[0] || {};
  const buyer_premium_bps = effectiveBuyerPremiumBps(a.seller_type, { auctionBps: a.buyer_premium_bps, sellerPct: a.buyer_premium_pct });
  const source = !isProfessional(a.seller_type) ? 'individual_fixed'
    : a.buyer_premium_bps != null ? 'auction'
      : a.buyer_premium_pct != null ? 'seller'
        : 'default';
  return { buyer_premium_bps, seller_type: a.seller_type || null, is_professional: isProfessional(a.seller_type), source };
}

// Effective terms + full settlement for an auction's current winning-lot totals (used by admin views
// and the actual settlement writer — SAME numbers). Reads committed winning lots.
async function getSettlement(auctionId, client = db) {
  const terms = await resolveEffectiveTerms(auctionId, client);
  const { rows } = await client.query(
    `SELECT winning_amount_cents FROM lots
      WHERE auction_id = $1 AND state = 'closed' AND winning_buyer_user_id IS NOT NULL AND winning_amount_cents IS NOT NULL`,
    [auctionId]);
  const hammerCents = rows.reduce((s, r) => s + (Number(r.winning_amount_cents) || 0), 0);
  const buyerPremiumCents = buyerPremiumForLots(rows, terms.buyer_premium_bps);
  return {
    effective_terms: terms,
    settlement: settlement({ sellerType: terms.seller_type, hammerCents, buyerPremiumCents }),
  };
}

// Persist the authoritative settlement onto seller_payouts (same model as the live payout — NOT a
// separate "preview"). Best-effort, post-commit; never throws into the close path.
async function storeSettlement(auctionId) {
  try {
    const { effective_terms, settlement: s } = await getSettlement(auctionId);
    // gross_revenue_cents stays the HAMMER total (report-consistent); the seller's take is
    // seller_payout_cents. Same numbers the in-transaction close INSERT wrote — this only adds the snapshot.
    await db.query(
      `UPDATE seller_payouts
          SET buyer_premium_cents = $2, platform_fee_cents = $3, gross_revenue_cents = $4,
              seller_payout_cents = $5, terms_snapshot = $6, updated_at = now()
        WHERE auction_id = $1`,
      [auctionId, s.buyer_premium_cents, s.platform_fee_cents, s.hammer_cents,
       s.seller_payout_cents, JSON.stringify({ effective_terms, settlement: s })]);
  } catch (e) { console.error('[billingTerms] storeSettlement failed (non-fatal):', e.message); }
}

module.exports = {
  DEFAULT_BUYER_PREMIUM_BPS, PRO_PLATFORM_FEE_BPS, INDIVIDUAL_PLATFORM_FEE_BPS,
  isProfessional, effectiveBuyerPremiumBps, lotBuyerPremiumCents, buyerPremiumForLots, settlement,
  resolveEffectiveTerms, getSettlement, storeSettlement,
  // Back-compat alias (old name) so existing admin/close callers keep working during the transition.
  getSettlementPreview: getSettlement, storeSettlementPreview: storeSettlement,
};
