'use strict';

/**
 * disputeService — payment disputes (chargebacks) from the charge.dispute.* webhooks.
 *
 * On charge.dispute.created / updated / closed:
 *   1. record the dispute (payment_disputes, one row per provider dispute id — upserted, so redelivered or
 *      out-of-order events converge on the latest state);
 *   2. while the dispute is open, put the related seller payout ON HOLD (settlement_status='on_hold' with a
 *      reason) so the admin settlement workbench shows it held. No money is moved: nothing is transferred,
 *      reversed or refunded here. A settlement that is already PAID is never changed (paid is immutable);
 *      the dispute row notes that recovery, if any, is a manual owner decision;
 *   3. audit every change;
 *   4. alert the owner (Admin-Action-Required SMS, deduplicated per dispute + phase).
 * A closed dispute does NOT release the hold automatically: an admin reviews the outcome and releases it.
 *
 * Idempotency: the webhook pipeline (stripe_webhook_events) already processes each event id once; the
 * upsert, the `settlement_status <> 'paid'` guard and the owner-alert dedup key make a replay harmless.
 */

const db = require('../db');
const auditService = require('./auditService');
const { SETTLEMENT_AUDIT_EVENTS } = require('../lib/settlementPolicy');

const CLOSED_STATUSES = new Set(['won', 'lost', 'warning_closed', 'charge_refunded', 'prevented']);

function isClosed(eventType, status) {
  return eventType === 'charge.dispute.closed' || CLOSED_STATUSES.has(String(status || ''));
}

function idOf(v) {
  if (!v) return null;
  return typeof v === 'string' ? v : (v.id || null);
}

function dueBy(dispute) {
  const t = dispute && dispute.evidence_details && dispute.evidence_details.due_by;
  return t ? new Date(Number(t) * 1000) : null;
}

function money(cents, currency) {
  const n = Number(cents || 0) / 100;
  return (String(currency || 'usd').toLowerCase() === 'usd' ? '$' : '') + n.toFixed(2);
}

// Find the platform payment the disputed charge belongs to (by PaymentIntent; falls back to looking the
// charge up when the dispute payload carries no PaymentIntent).
async function findPayment(dispute, getStripe) {
  let intentId = idOf(dispute.payment_intent);
  if (!intentId && dispute.charge && getStripe) {
    try {
      const ch = await getStripe().charges.retrieve(idOf(dispute.charge));
      intentId = idOf(ch && ch.payment_intent);
    } catch (e) { /* best-effort — recorded without a payment link */ }
  }
  if (!intentId) return { intentId: null, payment: null };
  const payment = (await db.query(
    `SELECT id, auction_id, buyer_user_id, lot_id, status FROM payments
      WHERE payment_intent_id = $1
      ORDER BY CASE status WHEN 'paid' THEN 0 WHEN 'partially_refunded' THEN 1 WHEN 'refunded' THEN 2 ELSE 3 END,
               created_at DESC
      LIMIT 1`, [intentId])).rows[0] || null;
  return { intentId, payment };
}

async function handleDisputeEvent(event, { getStripe } = {}) {
  const dispute = (event && event.data && event.data.object) || {};
  if (!dispute.id) return { recorded: false, reason: 'no_dispute_id' };
  const closed = isClosed(event.type, dispute.status);
  const { intentId, payment } = await findPayment(dispute, getStripe);

  const client = await db.connect();
  let row, holdApplied = false, holdNote = null, sellerPayout = null;
  try {
    await client.query('BEGIN');
    if (payment && payment.auction_id) {
      sellerPayout = (await client.query(
        `SELECT id, settlement_status, on_hold_reason FROM seller_payouts WHERE auction_id = $1 FOR UPDATE`,
        [payment.auction_id])).rows[0] || null;
    }

    const upsert = await client.query(
      `INSERT INTO payment_disputes
         (stripe_dispute_id, stripe_charge_id, payment_intent_id, payment_id, auction_id, buyer_user_id,
          seller_payout_id, amount_cents, currency, reason, status, livemode, evidence_due_by,
          closed_at, last_event_id, last_event_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $14 THEN now() END, $15, $16)
       ON CONFLICT (stripe_dispute_id) DO UPDATE SET
         stripe_charge_id  = COALESCE(EXCLUDED.stripe_charge_id, payment_disputes.stripe_charge_id),
         payment_intent_id = COALESCE(EXCLUDED.payment_intent_id, payment_disputes.payment_intent_id),
         payment_id        = COALESCE(EXCLUDED.payment_id, payment_disputes.payment_id),
         auction_id        = COALESCE(EXCLUDED.auction_id, payment_disputes.auction_id),
         buyer_user_id     = COALESCE(EXCLUDED.buyer_user_id, payment_disputes.buyer_user_id),
         seller_payout_id  = COALESCE(EXCLUDED.seller_payout_id, payment_disputes.seller_payout_id),
         amount_cents      = EXCLUDED.amount_cents,
         currency          = EXCLUDED.currency,
         reason            = EXCLUDED.reason,
         -- a late 'updated' delivered after 'closed' never reopens a closed dispute
         status            = CASE WHEN payment_disputes.closed_at IS NOT NULL AND NOT $14 THEN payment_disputes.status ELSE EXCLUDED.status END,
         evidence_due_by   = COALESCE(EXCLUDED.evidence_due_by, payment_disputes.evidence_due_by),
         closed_at         = COALESCE(payment_disputes.closed_at, EXCLUDED.closed_at),
         last_event_id     = EXCLUDED.last_event_id,
         last_event_type   = EXCLUDED.last_event_type,
         updated_at        = now()
       RETURNING id, payout_hold_applied, (xmax = 0) AS inserted`,
      [dispute.id, idOf(dispute.charge), intentId, payment ? payment.id : null,
       payment ? payment.auction_id : null, payment ? payment.buyer_user_id : null,
       sellerPayout ? sellerPayout.id : null, dispute.amount != null ? dispute.amount : null,
       dispute.currency || null, dispute.reason || null, dispute.status || 'unknown', !!dispute.livemode,
       dueBy(dispute), closed, event.id || null, event.type]);
    row = upsert.rows[0];

    // Hold the seller payout while the dispute is open. Never touches a PAID settlement.
    if (!closed && sellerPayout && !row.payout_hold_applied) {
      if (sellerPayout.settlement_status === 'paid') {
        holdNote = 'Settlement already paid before the dispute; no hold possible. Any recovery is an owner decision.';
      } else {
        const reason = `Payment dispute ${dispute.id} (${dispute.reason || 'unspecified'}, ${money(dispute.amount, dispute.currency)}) - payout held until reviewed`;
        const upd = await client.query(
          `UPDATE seller_payouts SET settlement_status = 'on_hold', on_hold_reason = $2, updated_at = now()
            WHERE id = $1 AND settlement_status <> 'paid'`, [sellerPayout.id, reason]);
        holdApplied = upd.rowCount === 1;
        holdNote = holdApplied ? 'Seller payout placed on hold.' : 'Seller payout could not be held (already paid).';
        if (holdApplied) {
          await auditService.logEvent(client, {
            eventType: SETTLEMENT_AUDIT_EVENTS.SETTLEMENT_ON_HOLD, entityType: 'seller_payout', entityId: sellerPayout.id,
            auctionId: payment.auction_id, paymentId: payment.id, actorId: null,
            metadata: { source: 'payment_dispute', stripe_dispute_id: dispute.id, previous_status: sellerPayout.settlement_status, reason },
          });
        }
      }
      await client.query(
        `UPDATE payment_disputes SET payout_hold_applied = $2, payout_hold_note = $3, updated_at = now() WHERE id = $1`,
        [row.id, holdApplied, holdNote]);
    } else if (!sellerPayout && row.inserted) {
      holdNote = payment ? 'No seller payout exists yet for this auction; hold it when one is created.' : 'Disputed charge is not an auction payment on this platform.';
      await client.query(`UPDATE payment_disputes SET payout_hold_note = $2 WHERE id = $1`, [row.id, holdNote]);
    }

    await auditService.logEvent(client, {
      eventType: 'payment.dispute_' + (closed ? 'closed' : (row.inserted ? 'opened' : 'updated')),
      entityType: 'payment_dispute', entityId: row.id,
      auctionId: payment ? payment.auction_id : null, lotId: payment ? payment.lot_id : null,
      paymentId: payment ? payment.id : null, actorId: null,
      metadata: {
        stripe_dispute_id: dispute.id, event_id: event.id, event_type: event.type, status: dispute.status,
        reason: dispute.reason, amount_cents: dispute.amount, hold_applied: holdApplied, hold_note: holdNote,
      },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;                                   // webhook marks the event failed → provider retries
  } finally {
    client.release();
  }

  // Owner alert — once when opened, once when closed (dedup key per dispute + phase). Best-effort.
  if (row.inserted || closed) {
    try {
      const oa = require('./ownerAlertService');
      await oa.notifyAdminActionRequired({
        actionType: oa.ALERT_TYPES.SETTLEMENT_EXCEPTION,
        entityType: 'payment_dispute',
        entityId: `${dispute.id}:${closed ? 'closed' : 'opened'}`,
        headline: closed ? `Payment dispute closed (${dispute.status || 'closed'})` : 'Payment dispute opened - action needed',
        context: `${money(dispute.amount, dispute.currency)} ${dispute.reason || ''}`.trim()
          + (closed ? '. Review and release the payout hold if appropriate.' : (holdApplied ? '. Seller payout held.' : '')),
        adminPath: '/admin/settlement-review.html',
        adminId: payment ? payment.auction_id : null, adminParam: 'auction',
        actionLabel: 'Review',
      });
    } catch (e) { console.error('[dispute] owner alert failed:', e.message); }
  }
  console.log(`[webhook] ${event.type} → dispute ${dispute.id} recorded (status=${dispute.status}, hold=${holdApplied})`);
  return { recorded: true, disputeRowId: row.id, holdApplied, closed };
}

module.exports = { handleDisputeEvent, isClosed, CLOSED_STATUSES };
