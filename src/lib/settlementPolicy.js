'use strict';

/**
 * settlementPolicy — single source of truth for Advantage.Bid seller-settlement
 * policy constants (owner-approved 2026-07-10). Pure module, no DB, no side
 * effects, so services, routes, and tests share ONE definition.
 *
 * Owner-approved launch policy (supersedes the retired flat 10% AND the 0%-for-everyone pilot):
 *  - INDIVIDUAL sellers (private / business / other / untyped): NO seller platform fee (0%). Advantage
 *    revenue on an individual sale is the buyer premium (see billingTermsService), not a seller fee.
 *  - PROFESSIONAL sellers (auction_house / estate_sale_company / professional_liquidator): Advantage
 *    charges a per-seller software/platform fee on the hammer (DEFAULT 4%, admin-configurable per
 *    seller via seller_profiles.platform_fee_bps). The professional's buyer premium is the SELLER's.
 *  - The credit-card PROCESSING fee reimbursed from the settlement is the ACTUAL Stripe expense for the
 *    auction (captured per charge), NOT a flat percentage — computed by the settlement engine from real
 *    Stripe data and intentionally NOT a constant here.
 *  - All settlement money math is cents-safe integer arithmetic.
 */
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');

// ── Seller platform fee ────────────────────────────────────────────────────────
// Individual = 0%; professional = per-seller rate (DEFAULT 4%), configured on
// seller_profiles.platform_fee_bps (integer basis points). Individuals ignore the column.
const PLATFORM_FEE_RATE             = 0;    // individual (Advantage revenue is the buyer premium instead)
const DEFAULT_PRO_PLATFORM_FEE_BPS  = 400;  // professional software-fee DEFAULT (4.00% of hammer)
const MAX_PLATFORM_FEE_BPS          = 2500; // validation ceiling (25%), mirrors buyer_premium_bps
// Owner-authoritative (2026-09-03): a seller-facing credit-card/payment-processing fee, kept SEPARATE
// from the platform/software fee (never collapsed into one "commission"). Applies to BOTH professional
// and individual auctions governed by the centralized pricing model. It is a fixed 3%-of-hammer POLICY
// rate — NOT the exact per-transaction Stripe cost (that is captured separately for reconciliation only).
const DEFAULT_PROCESSING_FEE_BPS    = 300;  // 3.00% of hammer — seller-facing processing fee
// Back-compat: the professional default expressed as a rate (some legacy tests import this).
const PRO_PLATFORM_FEE_RATE         = DEFAULT_PRO_PLATFORM_FEE_BPS / 10000;

function isProfessionalSellerType(t) {
  return PROFESSIONAL_SELLER_TYPES.indexOf(String(t || '').toLowerCase()) !== -1;
}

/**
 * Cents-safe seller platform fee for a gross (hammer) amount, by seller type. Always integer cents.
 *   • Individual (or untyped)  → 0 (the column is ignored; Advantage revenue is the buyer premium).
 *   • Professional             → hammer × rate, where the rate is the seller's configured
 *                                platform_fee_bps (per-seller, admin-set). Falls back to the 4%
 *                                DEFAULT only when no per-seller value is supplied.
 * Rounding matches billingTermsService (Math.round == floor(x+0.5) for non-negative gross amounts).
 * @param {number} grossCents integer cents (hammer)
 * @param {string} [sellerType] seller_profiles.seller_type (defaults to individual → 0%)
 * @param {number} [platformFeeBps] the seller's configured rate in basis points (professionals only)
 * @returns {number} integer cents
 */
function platformFeeCents(grossCents, sellerType, platformFeeBps) {
  const g = Number.isFinite(grossCents) ? Math.trunc(grossCents) : 0;
  if (!isProfessionalSellerType(sellerType)) return 0; // individuals: no seller platform fee
  const bps = (platformFeeBps == null || !Number.isFinite(Number(platformFeeBps)))
    ? DEFAULT_PRO_PLATFORM_FEE_BPS
    : Math.max(0, Math.trunc(Number(platformFeeBps)));
  return Math.round(g * bps / 10000);
}

/**
 * Cents-safe credit-card/payment-processing fee for a gross (hammer) amount. Kept independent of the
 * platform fee — each fee is computed from the SAME authoritative hammer base (never fee-on-fee).
 * Returns 0 when bps is null/invalid (legacy auctions carry processing_fee_bps = 0 → no deduction).
 * @param {number} grossCents integer cents (hammer)
 * @param {number} [processingBps] processing rate in basis points (from the frozen auction snapshot)
 * @returns {number} integer cents
 */
function processingFeeCents(grossCents, processingBps) {
  const g = Number.isFinite(grossCents) ? Math.trunc(grossCents) : 0;
  const bps = (processingBps == null || !Number.isFinite(Number(processingBps)))
    ? 0
    : Math.max(0, Math.trunc(Number(processingBps)));
  return Math.round(g * bps / 10000);
}

// ── Settlement adjustments (owner-approved, Decision 4) ────────────────────────
// A manual adjustment carries a POSITIVE amount_cents; the type sets the sign
// applied to seller proceeds. A voided adjustment is ignored entirely.
const ADJUSTMENT_TYPE = Object.freeze({ CREDIT: 'credit', DEBIT: 'debit' });

/**
 * Pure, cents-safe net of a list of settlement adjustments. Credits add to seller
 * proceeds; debits subtract. Voided rows (voided_at set) and non-positive amounts
 * are ignored. Never throws; always returns integer cents.
 * @param {Array<{adjustment_type:string, amount_cents:number, voided_at?:any}>} adjustments
 * @returns {{credit_cents:number, debit_cents:number, net_cents:number}}
 */
function sumAdjustments(adjustments) {
  let credit = 0, debit = 0;
  for (const a of Array.isArray(adjustments) ? adjustments : []) {
    if (!a || a.voided_at) continue;
    const cents = Math.trunc(Number(a.amount_cents));
    if (!Number.isFinite(cents) || cents <= 0) continue;
    if (a.adjustment_type === ADJUSTMENT_TYPE.CREDIT) credit += cents;
    else if (a.adjustment_type === ADJUSTMENT_TYPE.DEBIT) debit += cents;
  }
  return { credit_cents: credit, debit_cents: debit, net_cents: credit - debit };
}

// ── Settlement status workflow (owner-approved) ────────────────────────────────
//   Pending Review → Approved → Ready for Payment → Paid
//                                       ↘ On Hold
const SETTLEMENT_STATUS = Object.freeze({
  PENDING_REVIEW:    'pending_review',
  APPROVED:          'approved',
  READY_FOR_PAYMENT: 'ready_for_payment',
  PAID:              'paid',
  ON_HOLD:           'on_hold',
});

// Human-readable labels for UI display (never expose the raw enum).
const SETTLEMENT_STATUS_LABEL = Object.freeze({
  [SETTLEMENT_STATUS.PENDING_REVIEW]:    'Pending Review',
  [SETTLEMENT_STATUS.APPROVED]:          'Approved',
  [SETTLEMENT_STATUS.READY_FOR_PAYMENT]: 'Ready for Payment',
  [SETTLEMENT_STATUS.PAID]:              'Paid',
  [SETTLEMENT_STATUS.ON_HOLD]:           'On Hold',
});

// ── Settlement audit event vocabulary (owner-approved) ─────────────────────────
// Every material settlement event is logged via auditService with the actor,
// auction, seller, previous/new value, and reason/note where applicable.
const SETTLEMENT_AUDIT_EVENTS = Object.freeze({
  PAYOUT_PREF_ADDED:        'settlement.payout_pref_added',
  PAYOUT_PREF_UPDATED:      'settlement.payout_pref_updated',
  SETTLEMENT_CREATED:       'settlement.created',
  SETTLEMENT_RECALCULATED:  'settlement.recalculated',
  ADJUSTMENT_ADDED:         'settlement.adjustment_added',
  ADJUSTMENT_REMOVED:       'settlement.adjustment_removed',
  SETTLEMENT_APPROVED:      'settlement.approved',
  SETTLEMENT_ON_HOLD:       'settlement.on_hold',
  SETTLEMENT_MARKED_PAID:   'settlement.marked_paid',
  PAYMENT_REFERENCE_CHANGED:'settlement.payment_reference_changed',
  MARKETING_CHARGE_INCLUDED:'settlement.marketing_charge_included',
  REFUND_OR_CREDIT_APPLIED: 'settlement.refund_or_credit_applied',
});

module.exports = {
  PLATFORM_FEE_RATE,
  PRO_PLATFORM_FEE_RATE,
  DEFAULT_PRO_PLATFORM_FEE_BPS,
  DEFAULT_PROCESSING_FEE_BPS,
  MAX_PLATFORM_FEE_BPS,
  isProfessionalSellerType,
  platformFeeCents,
  processingFeeCents,
  ADJUSTMENT_TYPE,
  sumAdjustments,
  SETTLEMENT_STATUS,
  SETTLEMENT_STATUS_LABEL,
  SETTLEMENT_AUDIT_EVENTS,
};
