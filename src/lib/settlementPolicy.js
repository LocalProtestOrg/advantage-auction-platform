'use strict';

/**
 * settlementPolicy — single source of truth for Advantage.Bid seller-settlement
 * policy constants (owner-approved 2026-07-10). Pure module, no DB, no side
 * effects, so services, routes, and tests share ONE definition.
 *
 * See project memory `project_launch_settlement_policy`. Governing rules:
 *  - Seller PLATFORM fee at launch is 0% (the legacy flat 10% is retired).
 *  - The credit-card PROCESSING fee reimbursed from the settlement is the ACTUAL
 *    Stripe expense for the auction (captured per charge), NOT a flat percentage.
 *    That figure is computed by the settlement engine from real Stripe data and
 *    is intentionally NOT a constant here.
 *  - All settlement money math is cents-safe integer arithmetic.
 */

// ── Seller platform fee ────────────────────────────────────────────────────────
// 0% at launch. Kept as a rate (not just a literal 0) so a future policy change
// is a one-line edit here and nowhere else.
const PLATFORM_FEE_RATE = 0;

/**
 * Cents-safe seller platform fee for a gross amount. Always integer cents.
 * @param {number} grossCents integer cents
 * @returns {number} integer cents (0 while PLATFORM_FEE_RATE is 0)
 */
function platformFeeCents(grossCents) {
  const g = Number.isFinite(grossCents) ? Math.trunc(grossCents) : 0;
  return Math.round(g * PLATFORM_FEE_RATE);
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
  platformFeeCents,
  SETTLEMENT_STATUS,
  SETTLEMENT_STATUS_LABEL,
  SETTLEMENT_AUDIT_EVENTS,
};
