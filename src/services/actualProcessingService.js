'use strict';

/**
 * actualProcessingService — the ACTUAL Stripe processing fee of an auction's buyer payments (migration 186).
 *
 * Used only for auctions frozen at publish with processing_fee_basis = 'actual_stripe' (an Auction Partner auction
 * under the 0% platform fee). The seller's processing deduction equals what Stripe actually charged to collect that
 * auction's buyer payments: no markup, no subsidy, no guessed percentage.
 *
 * Definition (per collected payment: paid / partially_refunded / refunded):
 *   charge fee   = the charge's balance-transaction fee (payments.stripe_fee_cents, captured by settlementEngine). It
 *                  already contains whatever Stripe charged for that payment (international card, conversion, ...).
 *   refund effect = the sum of the fees on the payment's refund balance transactions (payments.stripe_refund_fee_cents).
 *                  Negative when Stripe returned part of the fee, 0 when it kept it. Recorded, never assumed.
 *   payment cost = charge fee + refund effect
 *   auction cost = Σ payment cost (every payment row belongs to exactly one auction: payments.auction_id).
 *
 * Not included (not part of collecting a payment, or no Owner policy yet): dispute fees, Stripe Tax service fees,
 * Connect account / payout fees, platform-level Stripe charges.
 *
 * FAIL SAFE: if any collected payment lacks a captured charge fee, or a refunded payment's refund effect is not
 * recorded for its current refunded total, the result is INCOMPLETE. Callers never substitute a percentage; the
 * settlement cannot be paid until the actual cost is verified (settlementEngine guards).
 */

const db = require('../db');

const ACTUAL = 'actual_stripe';
const COLLECTED = ['paid', 'partially_refunded', 'refunded'];
const isActual = (basis) => basis === ACTUAL;
const int = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));

/** PURE: aggregate the actual processing cost. Returns { cents, complete, payments, missing: [{payment_id, reason}] }. */
function aggregate(payments) {
  let cents = 0; let counted = 0; const missing = [];
  for (const p of Array.isArray(payments) ? payments : []) {
    if (!p || !COLLECTED.includes(p.status)) continue;
    counted += 1;
    const fee = int(p.stripe_fee_cents);
    if (fee == null) { missing.push({ payment_id: p.id, reason: 'charge_fee_not_captured' }); continue; }
    let refundEffect = 0;
    const refunded = int(p.refunded_amount_cents) || 0;
    if (refunded > 0) {
      const captured = int(p.stripe_refund_fee_cents);
      const capturedFor = int(p.stripe_refund_fee_refunded_cents);
      if (captured == null || capturedFor !== refunded) { missing.push({ payment_id: p.id, reason: 'refund_fee_not_verified' }); continue; }
      refundEffect = captured;
    }
    cents += fee + refundEffect;
  }
  return { cents, complete: missing.length === 0, payments: counted, missing };
}

/** Human-readable reason for an incomplete result (admin-facing). */
function incompleteReason(agg) {
  if (!agg || agg.complete) return null;
  const n = agg.missing.length;
  const refunds = agg.missing.filter((m) => m.reason === 'refund_fee_not_verified').length;
  return 'Actual Stripe processing cost could not be verified for ' + n + ' buyer payment' + (n === 1 ? '' : 's')
    + (refunds ? ' (' + refunds + ' after a refund)' : '') + '. This Auction Partner settlement stays in review and cannot be paid until Stripe\'s actual fee is recorded.';
}

/**
 * Record the fee effect of a payment's refunds from Stripe's refund balance transactions. Best-effort, read-only toward
 * Stripe. Stores the signed sum and the refunded total it covers; returns the sum, or null when it cannot be verified
 * (no key, Stripe error, a refund without a balance transaction, or refund totals that do not match our record).
 */
async function captureRefundFee(payment, { stripe = null, runner = db } = {}) {
  try {
    const refunded = int(payment && payment.refunded_amount_cents) || 0;
    if (!payment || refunded <= 0) return 0;
    if (int(payment.stripe_refund_fee_cents) != null && int(payment.stripe_refund_fee_refunded_cents) === refunded) return int(payment.stripe_refund_fee_cents);
    const intentId = payment.payment_intent_id || payment.stripe_payment_intent_id;
    if (!intentId) return null;
    const client = stripe || (process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null);
    if (!client) return null;
    const list = await client.refunds.list({ payment_intent: intentId, limit: 100, expand: ['data.balance_transaction'] });
    const done = (list && list.data ? list.data : []).filter((r) => r.status === 'succeeded');
    if (list && list.has_more) return null;                                    // never sum a partial list
    if (done.reduce((s, r) => s + (Number(r.amount) || 0), 0) !== refunded) return null;   // our record and Stripe disagree
    let effect = 0;
    for (const r of done) {
      const bt = r.balance_transaction;
      if (!bt || typeof bt !== 'object' || typeof bt.fee !== 'number') return null;
      effect += bt.fee;
    }
    await runner.query(
      `UPDATE payments SET stripe_refund_fee_cents = $2, stripe_refund_fee_refunded_cents = $3, stripe_refund_fee_captured_at = now() WHERE id = $1`,
      [payment.id, effect, refunded]);
    payment.stripe_refund_fee_cents = effect; payment.stripe_refund_fee_refunded_cents = refunded;
    return effect;
  } catch (_e) {
    return null;
  }
}

/** DB-only aggregate for an auction (no Stripe calls). */
async function forAuction(auctionId, runner = db) {
  const rows = (await runner.query(
    `SELECT id, status, stripe_fee_cents, refunded_amount_cents, stripe_refund_fee_cents, stripe_refund_fee_refunded_cents
       FROM payments WHERE auction_id = $1`, [auctionId])).rows;
  return aggregate(rows);
}

module.exports = { ACTUAL, COLLECTED, isActual, aggregate, incompleteReason, captureRefundFee, forAuction };
