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
  platformFeeCents,
  ADJUSTMENT_TYPE,
  sumAdjustments,
  SETTLEMENT_STATUS,
  SETTLEMENT_STATUS_LABEL,
  SETTLEMENT_AUDIT_EVENTS,
};
