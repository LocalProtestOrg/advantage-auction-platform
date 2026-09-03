'use strict';

/**
 * settlementEngine — Increment 3 of the manual seller-settlement workflow.
 *
 * Computes a seller settlement from ACTUAL data (owner Decisions 1–4):
 *   - Basis = successfully COLLECTED buyer funds (Decision 2), NOT hammer/invoices.
 *   - Refund-aware; reports expected vs collected vs outstanding vs failed.
 *   - Credit-card processing reimbursement = ACTUAL Stripe cost from the balance
 *     transaction (Decision 1), captured read-time into payments.stripe_fee_cents.
 *     No flat percentage is used when real fee data exists.
 *   - Seller platform fee = 0% (settlementPolicy).
 *   - Manual adjustments (credit adds / debit subtracts) via settlementPolicy.sumAdjustments.
 *   - Marketing deductions ONLY from an authoritative purchase record (none exists
 *     yet → "None", 0), never hard-coded, never double-deducted.
 *   - Cents-safe integer arithmetic throughout.
 *   - Versioned snapshots; audit events on create/recalculate.
 *
 * INERT: nothing here is wired to a route yet (that is Increment 5+), and it does not
 * run at auction close. The live payment/webhook path is intentionally untouched.
 *
 * NOTE ON VALIDATION: computeSettlementTotals() is PURE and unit-tested. The DB
 * read/write layer (assemble/compute/recalculate) is code-complete against the Design C
 * schema but requires integration validation with live Stripe-TEST collected-funds data
 * before SELLER_SETTLEMENTS_ENABLED is turned on.
 */

const db = require('../db');
const auditService = require('./auditService');
const { listAdjustments } = require('./settlementAdjustmentService');
const { getSellerPayoutPreference } = require('./payoutPreferenceService');
const { platformFeeCents, processingFeeCents, isProfessionalSellerType, DEFAULT_PRO_PLATFORM_FEE_BPS, sumAdjustments, SETTLEMENT_AUDIT_EVENTS, SETTLEMENT_STATUS } = require('../lib/settlementPolicy');

class MarkPaidError extends Error {}

const cents = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };

// ── PURE settlement formula (the financial guarantee; fully unit-tested) ────────
/**
 * @param {object} i assembled figures (all integer cents / arrays)
 * @returns {object} complete cents-safe settlement breakdown
 */
function computeSettlementTotals(i = {}) {
  const grossSales   = cents(i.grossSalesCents);
  const expected     = cents(i.buyerPaymentsExpectedCents);
  const collected    = cents(i.buyerPaymentsCollectedCents); // paid, gross of refunds
  const refunds      = cents(i.refundsCents);
  const failed       = cents(i.failedPaymentsCents);
  const marketing    = cents(i.marketingDeductionCents);
  const stripeFee    = cents(i.stripeFeeCents);              // ACTUAL Stripe cost (reconciliation); never a seller charge under v2
  const adj          = sumAdjustments(i.adjustments);        // unified credit/debit: credit adds, debit subtracts

  const outstanding  = Math.max(0, expected - collected);
  const netCollected = collected - refunds;                  // collected-basis (Decision 2)
  // Seller platform fee: individual → 0%; professional → per-seller rate of HAMMER (DEFAULT 4%,
  // seller_profiles.platform_fee_bps). Basis is gross hammer sales (NOT netCollected, which includes
  // buyer premium), matching the authoritative seller_payouts figure written at close.
  const platformFee  = platformFeeCents(grossSales, i.sellerType, i.sellerPlatformFeeBps);
  // Processing fee (owner-authoritative 2026-09-03): under the centralized v2 model the seller-facing
  // processing deduction is a FIXED 3% of hammer (the frozen snapshot), and the ACTUAL Stripe cost is
  // NOT deducted again (reconciliation only) — no double processing charge. Legacy auctions keep the
  // prior behavior: the actual Stripe cost IS the processing deduction and there is no flat 3%.
  const isV2 = i.pricingModel === 'v2_separated';
  const processingFee = isV2 ? processingFeeCents(grossSales, i.processingFeeBps) : stripeFee;
  const netProceeds  = netCollected + adj.net_cents - marketing - processingFee - platformFee;

  return {
    gross_sales_cents:                grossSales,
    buyer_payments_expected_cents:    expected,
    buyer_payments_collected_cents:   collected,
    outstanding_balance_cents:        outstanding,
    failed_payments_cents:            failed,
    refunds_cents:                    refunds,
    net_collected_cents:              netCollected,
    adjustments:                      { credit_cents: adj.credit_cents, debit_cents: adj.debit_cents, net_cents: adj.net_cents },
    marketing_deduction_cents:        marketing,
    credit_card_processing_fee_cents: processingFee,          // amount actually DEDUCTED (v2: 3% flat; legacy: actual Stripe)
    processing_fee_bps:               isV2 ? Math.max(0, cents(i.processingFeeBps)) : 0,
    actual_stripe_cost_cents:         stripeFee,               // internal reconciliation ONLY — never a second deduction
    seller_platform_fee_bps:          isProfessionalSellerType(i.sellerType)
                                        ? (i.sellerPlatformFeeBps == null ? DEFAULT_PRO_PLATFORM_FEE_BPS : Math.trunc(Number(i.sellerPlatformFeeBps)))
                                        : 0,        // rate actually applied (0 for individuals)
    seller_platform_fee_cents:        platformFee, // hammer × rate (0 for individuals)
    net_seller_proceeds_cents:        netProceeds,
    final_amount_owed_cents:          netProceeds,
  };
}

// ── Marketing read architecture (Decision 3) ───────────────────────────────────
// Reads the AUTHORITATIVE marketing purchase record. That record does not exist yet
// (marketing_jobs stores a selection with no price/payment), so there is nothing to
// deduct: returns "None". When a real purchase record with price + payment status is
// added, extend this to read it (deducting only amounts paid FROM proceeds, never
// double-deducting amounts paid separately). Never hard-codes package prices.
async function readMarketingCharges(/* auctionId */) {
  return { charges: [], deduction_cents: 0, note: 'None', source: 'no-authoritative-purchase-record' };
}

// ── Actual Stripe fee capture (Decision 1), best-effort, read-time ─────────────
// Reads the balance transaction fee for a collected payment and stores it in
// payments.stripe_fee_cents. Never throws into the caller; returns the fee or null.
async function captureStripeFeeForPayment(payment) {
  try {
    if (!payment) return null;
    if (payment.stripe_fee_cents != null) return payment.stripe_fee_cents; // already captured
    const intentId = payment.payment_intent_id || payment.stripe_payment_intent_id;
    if (!intentId || !process.env.STRIPE_SECRET_KEY) return null;
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge.balance_transaction'] });
    const charge = intent && intent.latest_charge;
    const bt = charge && charge.balance_transaction;
    if (!bt || typeof bt.fee !== 'number') return null;
    await db.query(
      `UPDATE payments SET stripe_fee_cents = $2, stripe_fee_captured_at = now(), stripe_balance_txn_id = $3 WHERE id = $1`,
      [payment.id, bt.fee, bt.id]
    );
    return bt.fee;
  } catch (_e) {
    return null; // best-effort; the settlement still computes (fee treated as unavailable)
  }
}

// ── Assemble real inputs from the Design C money path ──────────────────────────
async function assembleSettlementInputs(auctionId) {
  // Gross hammer of sold lots (display only; NOT the payout basis).
  const grossRes = await db.query(
    `SELECT COALESCE(SUM(winning_amount_cents),0)::bigint AS gross
       FROM lots WHERE auction_id = $1 AND winning_amount_cents IS NOT NULL`, [auctionId]);

  // Seller type + per-seller rate govern the platform fee (professional → platform_fee_bps of hammer,
  // DEFAULT 4%; individual → 0%).
  const stRes = await db.query(
    `SELECT sp.seller_type, sp.platform_fee_bps AS seller_platform_bps,
            a.platform_fee_bps AS snap_platform_bps, a.processing_fee_bps, a.pricing_model
       FROM auctions a LEFT JOIN seller_profiles sp ON sp.id = a.seller_id WHERE a.id = $1`, [auctionId]);
  const row = stRes.rows[0] || {};
  const sellerType = row.seller_type || null;
  const pricingModel = row.pricing_model || 'legacy';
  // v2 auctions use the FROZEN platform snapshot; legacy uses the live per-seller rate (unchanged).
  const sellerPlatformFeeBps = (pricingModel === 'v2_separated' && row.snap_platform_bps != null)
    ? row.snap_platform_bps
    : row.seller_platform_bps;
  const processingFeeBps = row.processing_fee_bps;

  // Expected / collected / outstanding from per-buyer combined invoices (Design C).
  const invRes = await db.query(
    `SELECT
        COALESCE(SUM(total_cents),0)::bigint                                          AS expected,
        COALESCE(SUM(total_cents) FILTER (WHERE status = 'paid'),0)::bigint           AS collected,
        COALESCE(SUM(total_cents) FILTER (WHERE status <> 'paid' AND status <> 'void'),0)::bigint AS outstanding
       FROM buyer_auction_invoices WHERE auction_id = $1`, [auctionId]);

  // Refunds + failed + Stripe-fee source rows from payments for this auction.
  const payRes = await db.query(
    `SELECT id, payment_intent_id, status, refunded_amount_cents, stripe_fee_cents
       FROM payments WHERE auction_id = $1`, [auctionId]);
  const payments = payRes.rows;
  const refunds = payments.reduce((s, p) => s + cents(p.refunded_amount_cents), 0);
  const failed  = payments.filter(p => p.status === 'failed').length; // count; amount not always retained on failure

  // Actual Stripe cost on collected (paid/refunded) payments — capture where missing.
  let stripeFee = 0;
  for (const p of payments) {
    if (p.status === 'paid' || p.status === 'partially_refunded' || p.status === 'refunded') {
      const fee = p.stripe_fee_cents != null ? p.stripe_fee_cents : await captureStripeFeeForPayment(p);
      stripeFee += cents(fee);
    }
  }

  const adjustments = await listAdjustments(auctionId);          // active credit/debit
  const marketing   = await readMarketingCharges(auctionId);    // None for now

  return {
    sellerType,
    sellerPlatformFeeBps,
    pricingModel,
    processingFeeBps,
    grossSalesCents:                Number(grossRes.rows[0].gross),
    buyerPaymentsExpectedCents:     Number(invRes.rows[0].expected),
    buyerPaymentsCollectedCents:    Number(invRes.rows[0].collected),
    refundsCents:                   refunds,
    failedPaymentsCents:            failed,
    marketingDeductionCents:        marketing.deduction_cents,
    stripeFeeCents:                 stripeFee,
    adjustments,
    _marketing:                     marketing,
  };
}

/** Read-only: compute the full settlement breakdown for an auction. */
async function computeSettlement(auctionId) {
  const inputs = await assembleSettlementInputs(auctionId);
  const totals = computeSettlementTotals(inputs);
  return { ...totals, marketing: inputs._marketing };
}

/**
 * Recalculate + persist: writes a new (non-final) versioned snapshot, increments the
 * settlement version, updates seller_payouts figures, and audits. Refuses once the
 * settlement is paid (the final snapshot is immutable). Transactional.
 */
async function recalculateSettlement(auctionId, actorId = null) {
  const totals = await computeSettlement(auctionId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const spRes = await client.query('SELECT * FROM seller_payouts WHERE auction_id = $1 FOR UPDATE', [auctionId]);
    const sp = spRes.rows[0];
    if (!sp) { await client.query('ROLLBACK'); throw new Error('No seller_payouts row for this auction (not closed yet?)'); }
    if (sp.settlement_status === SETTLEMENT_STATUS.PAID) { await client.query('ROLLBACK'); return { frozen: true, version: sp.settlement_version, totals }; }

    const vRes = await client.query('SELECT COALESCE(MAX(version),0) AS maxv FROM settlement_snapshots WHERE auction_id = $1', [auctionId]);
    const nextVersion = Number(vRes.rows[0].maxv) + 1;

    await client.query(
      `INSERT INTO settlement_snapshots (auction_id, seller_user_id, version, snapshot, is_final, created_by_user_id)
       VALUES ($1, $2, $3, $4, false, $5)`,
      [auctionId, sp.seller_user_id, nextVersion, JSON.stringify(totals), actorId]);

    await client.query(
      `UPDATE seller_payouts SET settlement_version = $2, seller_payout_cents = $3,
              platform_fee_bps = $4, platform_fee_cents = $5, updated_at = now()
        WHERE auction_id = $1`,
      [auctionId, nextVersion, totals.net_seller_proceeds_cents,
       (totals.seller_platform_fee_bps != null ? totals.seller_platform_fee_bps : null),
       totals.seller_platform_fee_cents]);

    await auditService.logEvent(client, {
      eventType: nextVersion === 1 ? SETTLEMENT_AUDIT_EVENTS.SETTLEMENT_CREATED : SETTLEMENT_AUDIT_EVENTS.SETTLEMENT_RECALCULATED,
      entityType: 'seller_payout', entityId: sp.id, auctionId, actorId,
      metadata: { version: nextVersion, net_seller_proceeds_cents: totals.net_seller_proceeds_cents, collected_cents: totals.buyer_payments_collected_cents },
    });
    await client.query('COMMIT');
    return { version: nextVersion, totals };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Mark Paid (records a completed MANUAL payment; never moves money) ──────────
// A payout preference is "complete" when the seller has provided everything needed
// to actually be paid by the chosen method. (Stripe-managed ACH references arrive in
// the banking increment; today: check needs payee + address, ach needs a stored ref.)
function payoutPreferenceComplete(pref) {
  if (!pref) return false;
  if (pref.payout_method === 'check') return !!(pref.check_payee_name && pref.check_address_line1);
  if (pref.payout_method === 'ach') return !!(pref.ach_account_last4 || pref.stripe_bank_account_ref);
  return false;
}

/**
 * PURE guard: decide whether Mark Paid may proceed. Throws MarkPaidError (clear reason)
 * or returns {ok:true}. No side effects — fully unit-testable.
 */
function assertMarkPaidAllowed(state, input) {
  const s = state || {}, i = input || {};
  if (!s.hasSettlementRow) throw new MarkPaidError('No settlement exists for this auction yet.');
  if (s.settlementStatus === SETTLEMENT_STATUS.PAID) throw new MarkPaidError('Settlement is already paid and is immutable.');
  if (i.paymentMethod !== 'ach' && i.paymentMethod !== 'check') throw new MarkPaidError("Payment method must be 'ach' or 'check'.");
  if (!s.payoutPreferenceComplete) throw new MarkPaidError('Seller payment preference is incomplete; cannot mark paid.');
  if (!i.paymentReference || !String(i.paymentReference).trim()) throw new MarkPaidError('A payment reference is required.');
  if (!i.paidAt) throw new MarkPaidError('The actual payment date is required.');
  if (!i.confirmedCompleted) throw new MarkPaidError('Explicit confirmation that the payment was completed is required.');
  const net = Math.trunc(Number(s.netProceedsCents));
  const finalAmt = Math.trunc(Number(i.finalAmountCents));
  if (!Number.isFinite(finalAmt)) throw new MarkPaidError('A final net payment amount is required.');
  if (finalAmt !== net) throw new MarkPaidError('Final amount (' + finalAmt + ') does not match the calculated settlement (' + net + ').');
  return { ok: true };
}

/**
 * Record a completed MANUAL seller payment. Freezes the immutable final snapshot, sets
 * paid metadata, blocks future recalculation/adjustment, and audits. This does NOT move
 * money — it records that an out-of-platform ACH/check payment was completed. Transactional
 * + idempotent (the partial-unique final-snapshot index rejects a duplicate final row).
 */
async function markSettlementPaid(auctionId, {
  paymentMethod, paymentReference, paidAt = null, paymentNote = null,
  finalAmountCents, actorId = null, confirmedCompleted = false,
} = {}) {
  const totals = await computeSettlement(auctionId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const spRes = await client.query('SELECT * FROM seller_payouts WHERE auction_id = $1 FOR UPDATE', [auctionId]);
    const sp = spRes.rows[0];
    const pref = sp ? await getSellerPayoutPreference(sp.seller_user_id) : null;

    assertMarkPaidAllowed({
      hasSettlementRow: !!sp,
      settlementStatus: sp && sp.settlement_status,
      netProceedsCents: totals.net_seller_proceeds_cents,
      payoutPreferenceComplete: payoutPreferenceComplete(pref),
    }, { paymentMethod, paymentReference, paidAt, finalAmountCents, confirmedCompleted });

    const vRes = await client.query('SELECT COALESCE(MAX(version),0) AS maxv FROM settlement_snapshots WHERE auction_id = $1', [auctionId]);
    const finalVersion = Number(vRes.rows[0].maxv) + 1;

    // Immutable final snapshot (uq_settlement_snapshot_final rejects any second final row).
    await client.query(
      `INSERT INTO settlement_snapshots (auction_id, seller_user_id, version, snapshot, is_final, created_by_user_id)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [auctionId, sp.seller_user_id, finalVersion, JSON.stringify(totals), actorId]);

    await client.query(
      `UPDATE seller_payouts SET
         settlement_status = 'paid', settlement_version = $2,
         seller_payout_cents = $3, final_amount_paid_cents = $3,
         paid_at = COALESCE($4::timestamptz, now()), paid_by_user_id = $5,
         payment_method_used = $6, payout_reference = $7, payment_note = $8,
         payout_status = 'released', updated_at = now()
       WHERE auction_id = $1`,
      [auctionId, finalVersion, totals.net_seller_proceeds_cents, paidAt, actorId,
       paymentMethod, String(paymentReference).trim(), paymentNote]);

    await auditService.logEvent(client, {
      eventType: SETTLEMENT_AUDIT_EVENTS.SETTLEMENT_MARKED_PAID,
      entityType: 'seller_payout', entityId: sp.id, auctionId, actorId,
      metadata: {
        final_version: finalVersion, final_amount_cents: totals.net_seller_proceeds_cents,
        payment_method: paymentMethod, payment_reference: String(paymentReference).trim(),
      },
    });
    await client.query('COMMIT');
    return { paid: true, final_version: finalVersion, final_amount_cents: totals.net_seller_proceeds_cents, totals };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Direct Deposit (Stripe Connect transfer) — Admin-triggered release ───────────────────
// Separate from the check Mark Paid path above. Money moves ONLY here, only at explicit Admin
// approval, only after all safeguards pass. Buyer funds stay on the platform until this runs.
class PaySellerError extends Error {}

// PURE: the Connected Account can actually receive AND pay out a transfer.
function connectPayoutReady(pref) {
  return !!(pref && pref.stripe_account_id && pref.connect_transfers_active && pref.connect_payouts_enabled);
}

/**
 * PURE guard for Direct Deposit "Pay Seller". Throws PaySellerError or returns {ok:true}.
 * Enforces every money-movement safeguard so no wrong/duplicate/early transfer can occur.
 */
function assertPaySellerAllowed(state, input) {
  const s = state || {}, i = input || {};
  if (!s.hasSettlementRow) throw new PaySellerError('No settlement exists for this auction yet.');
  if (s.settlementStatus === SETTLEMENT_STATUS.PAID) throw new PaySellerError('Settlement is already paid and is immutable.');
  if (s.existingTransferId) throw new PaySellerError('A Stripe transfer already exists for this settlement.');
  if (s.payoutMethod !== 'ach') throw new PaySellerError('Seller payout method is not Direct Deposit.');
  if (!s.connectReady) throw new PaySellerError('Seller Direct Deposit is not ready (Stripe onboarding incomplete or payouts disabled).');
  if (!i.confirmedCompleted) throw new PaySellerError('Explicit confirmation that fulfillment is complete is required.');
  const net = Math.trunc(Number(s.netProceedsCents));
  const finalAmt = Math.trunc(Number(i.finalAmountCents));
  if (!Number.isFinite(finalAmt)) throw new PaySellerError('A final net payment amount is required.');
  if (finalAmt !== net) throw new PaySellerError('Final amount (' + finalAmt + ') does not match the calculated settlement (' + net + ').');
  if (net <= 0) throw new PaySellerError('Net seller proceeds must be greater than zero.');
  return { ok: true };
}

/**
 * Admin-approved Direct Deposit. Locks the settlement row, verifies the guard, creates ONE
 * Stripe Transfer to the seller's Connected Account (idempotency-keyed), records the transfer
 * id + immutable final snapshot, and sets settlement_status='paid' + payout_status='processing'
 * (a transfer.created webhook flips it to 'released'). If the transfer throws, NOTHING is marked
 * paid and the state stays retry-safe. Duplicate/concurrent calls are blocked by the FOR UPDATE
 * lock + the unique stripe_transfer_id index + the idempotency key.
 */
async function paySellerViaTransfer(auctionId, { actorId = null, confirmedCompleted = false, finalAmountCents } = {}) {
  const totals = await computeSettlement(auctionId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const spRes = await client.query('SELECT * FROM seller_payouts WHERE auction_id = $1 FOR UPDATE', [auctionId]);
    const sp = spRes.rows[0];
    const pref = sp ? await getSellerPayoutPreference(sp.seller_user_id) : null;

    assertPaySellerAllowed({
      hasSettlementRow: !!sp,
      settlementStatus: sp && sp.settlement_status,
      existingTransferId: sp && sp.stripe_transfer_id,
      payoutMethod: pref && pref.payout_method,
      connectReady: connectPayoutReady(pref),
      netProceedsCents: totals.net_seller_proceeds_cents,
    }, { finalAmountCents, confirmedCompleted });

    const vRes = await client.query('SELECT COALESCE(MAX(version),0) AS maxv FROM settlement_snapshots WHERE auction_id = $1', [auctionId]);
    const finalVersion = Number(vRes.rows[0].maxv) + 1;
    const net = totals.net_seller_proceeds_cents;

    // Create the Stripe Transfer (platform balance → seller Connected Account). Stable, per-auction
    // idempotency key: a retry after a partial failure returns the SAME transfer, never a second one.
    let transfer;
    try {
      const stripe = require('./stripeConnectService').getStripe();
      transfer = await stripe.transfers.create({
        amount: net,
        currency: 'usd',
        destination: pref.stripe_account_id,
        metadata: {
          auction_id: String(auctionId),
          seller_user_id: String(sp.seller_user_id),
          settlement_version: String(finalVersion),
          platform: 'advantage.bid',
        },
      }, { idempotencyKey: 'settlement-transfer:' + auctionId });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new PaySellerError('Stripe transfer failed: ' + (e && e.message ? e.message : 'unknown error'));
    }

    await client.query(
      `INSERT INTO settlement_snapshots (auction_id, seller_user_id, version, snapshot, is_final, created_by_user_id)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [auctionId, sp.seller_user_id, finalVersion, JSON.stringify(totals), actorId]);

    await client.query(
      `UPDATE seller_payouts SET
         settlement_status = 'paid', settlement_version = $2,
         seller_payout_cents = $3, final_amount_paid_cents = $3,
         platform_fee_bps = $6, platform_fee_cents = $7,
         paid_at = now(), paid_by_user_id = $4,
         payment_method_used = 'ach', payout_reference = $5,
         stripe_transfer_id = $5, transfer_initiated_at = now(),
         payout_status = 'processing', updated_at = now()
       WHERE auction_id = $1`,
      [auctionId, finalVersion, net, actorId, transfer.id,
       (totals.seller_platform_fee_bps != null ? totals.seller_platform_fee_bps : null),
       totals.seller_platform_fee_cents]);

    await auditService.logEvent(client, {
      eventType: SETTLEMENT_AUDIT_EVENTS.SETTLEMENT_MARKED_PAID,
      entityType: 'seller_payout', entityId: sp.id, auctionId, actorId,
      metadata: { final_version: finalVersion, final_amount_cents: net, payment_method: 'direct_deposit', stripe_transfer_id: transfer.id },
    });
    await client.query('COMMIT');
    return { paid: true, final_version: finalVersion, final_amount_cents: net, stripe_transfer_id: transfer.id, payout_status: 'processing' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Webhook: transfer.created confirms the transfer; transfer.reversed flags a reversal. Idempotent
// (matches on stripe_transfer_id). Never marks a settlement paid — that already happened at approval.
async function applyTransferEvent(eventType, transfer) {
  if (!transfer || !transfer.id) return { updated: 0 };
  if (eventType === 'transfer.created') {
    const r = await db.query(
      `UPDATE seller_payouts SET payout_status='released', updated_at=now()
         WHERE stripe_transfer_id=$1 AND payout_status='processing'`, [transfer.id]);
    return { updated: r.rowCount, payout_status: 'released' };
  }
  if (eventType === 'transfer.reversed') {
    const r = await db.query(
      `UPDATE seller_payouts SET payout_status='reversed',
         transfer_failure_message=$2, updated_at=now()
         WHERE stripe_transfer_id=$1`, [transfer.id, 'Transfer reversed by Stripe/platform']);
    return { updated: r.rowCount, payout_status: 'reversed' };
  }
  return { updated: 0 };
}

module.exports = {
  computeSettlementTotals, // pure
  readMarketingCharges,
  captureStripeFeeForPayment,
  assembleSettlementInputs,
  computeSettlement,
  recalculateSettlement,
  payoutPreferenceComplete, // pure
  assertMarkPaidAllowed,    // pure
  markSettlementPaid,
  MarkPaidError,
  // Direct Deposit (Stripe Connect):
  connectPayoutReady,       // pure
  assertPaySellerAllowed,   // pure
  paySellerViaTransfer,
  applyTransferEvent,
  PaySellerError,
};
