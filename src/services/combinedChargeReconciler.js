'use strict';

/**
 * combinedChargeReconciler — resolves off-session auction charges whose outcome is UNKNOWN.
 *
 * When the automatic charge at auction close cannot reach the payment provider (twice, with the same
 * idempotency key), the charge may or may not have been made. Telling the buyer to pay again at that point
 * risks a double charge, so chargeCombinedOffSession records the attempt as 'payment.charge_uncertain' (with
 * the exact request and idempotency key), leaves the payment pending and sends nothing.
 *
 * This reconciler, run every few minutes by the notification worker, settles each uncertain charge:
 *   - within the provider's idempotency window it REPEATS THE EXACT REQUEST with the SAME key, which returns
 *     the original result if the charge was made (never a second charge) or makes the intended charge once;
 *   - after the window it LOOKS UP the charge by its payment id instead of repeating it;
 * then: succeeded → invoice settled + receipt; needs the buyer (declined / authentication) or never charged →
 * payment_required + reminders (the normal decline path); provider still unreachable → left for the next run.
 */

const db = require('../db');
const auditService = require('./auditService');
const combinedInvoiceService = require('./combinedInvoiceService');
const combinedReceiptService = require('./combinedReceiptService');

const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;   // the provider keeps keys ~24h; stay well inside it
const MIN_AGE_MINUTES = 3;

const isTransient = (e) => !!(e && (e.type === 'StripeConnectionError' || e.type === 'StripeAPIError' || e.type === 'StripeRateLimitError'));
const isCardError = (e) => !!(e && (e.type === 'StripeCardError' || e.code === 'card_declined' || e.code === 'authentication_required'));

/** The normal "please pay" path: invoice to payment_required, reminder #1 now, #2 and #3 at +12h and +24h. */
async function routePaymentRequired(combinedInvoiceId, buyerUserId, reason) {
  await combinedInvoiceService.markFailed(combinedInvoiceId, reason);
  await combinedReceiptService.sendPaymentRequired(combinedInvoiceId, 1);
  await db.query(
    `INSERT INTO notifications_queue (user_id, type, payload, next_attempt_at)
     VALUES ($1, 'PAYMENT_REMINDER', jsonb_build_object('combined_invoice_id', $2::text, 'n', 2), now() + interval '12 hours'),
            ($1, 'PAYMENT_REMINDER', jsonb_build_object('combined_invoice_id', $2::text, 'n', 3), now() + interval '24 hours')`,
    [buyerUserId, combinedInvoiceId]);
}

async function listUncertain(runner = db) {
  return (await runner.query(
    `SELECT p.id AS payment_id, p.auction_id, p.buyer_user_id, a.metadata, a.created_at AS attempted_at,
            (now() - a.created_at) < interval '23 hours' AS within_window
       FROM payments p
       JOIN LATERAL (
         SELECT metadata, created_at FROM audit_log
          WHERE event_type = 'payment.charge_uncertain' AND entity_id = p.id
          ORDER BY created_at DESC LIMIT 1) a ON true
      WHERE p.status = 'pending' AND p.lot_id IS NULL AND p.payment_intent_id IS NULL
        AND a.created_at < now() - ($1 || ' minutes')::interval
      ORDER BY a.created_at ASC LIMIT 50`, [String(MIN_AGE_MINUTES)])).rows;
}

async function markFailed(paymentId, intentId, reason) {
  await db.query(
    `UPDATE payments SET status = 'failed', last_attempted_at = now(), payment_intent_id = COALESCE(payment_intent_id, $2)
      WHERE id = $1 AND status = 'pending'`, [paymentId, intentId || null]);
  await auditService.logEvent(db, { eventType: 'payment.charge_uncertain_resolved', entityType: 'payment', entityId: paymentId,
    paymentId, actorId: null, metadata: { outcome: 'failed', reason, payment_intent_id: intentId || null } });
}

/**
 * Resolve every uncertain charge once. `deps.stripe` lets tests supply the provider client.
 * Returns a summary; never throws for a single charge (each is independent).
 */
async function reconcileUncertainCharges(deps = {}) {
  const ready = (await db.query(`SELECT to_regclass('public.payments') AS t`).catch(() => ({ rows: [{}] }))).rows[0];
  if (!ready || !ready.t || !process.env.STRIPE_SECRET_KEY) return { ran: false };
  const stripe = deps.stripe || require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-03-25.dahlia' }); // same pin as paymentService
  const rows = await listUncertain();
  const summary = { ran: true, considered: rows.length, settled: 0, pending: 0, payment_required: 0, still_unknown: 0, errors: 0 };

  for (const r of rows) {
    const m = r.metadata || {};
    const invoiceId = m.combined_invoice_id;
    try {
      let intent = null;
      const withinWindow = r.within_window === true;   // decided by the database clock (audit timestamps carry no zone)
      if (withinWindow && m.create_params && m.idempotency_key) {
        try {
          // Same parameters + same key: the provider returns the ORIGINAL result, or charges once now.
          intent = await stripe.paymentIntents.create(m.create_params, { timeout: 15000, idempotencyKey: m.idempotency_key });
        } catch (e) {
          if (isTransient(e)) { summary.still_unknown++; continue; }
          const attached = e && e.raw && e.raw.payment_intent && e.raw.payment_intent.id;
          await markFailed(r.payment_id, attached, isCardError(e) ? (e.code || 'card_error') : 'charge_error:' + (e.code || e.type || 'unknown'));
          if (invoiceId && await combinedInvoiceService.stillUnpaid(invoiceId)) await routePaymentRequired(invoiceId, r.buyer_user_id, 'charge_after_uncertain');
          summary.payment_required++; continue;
        }
      } else {
        // Outside the idempotency window: never repeat the charge; look it up instead.
        let found;
        try {
          found = await stripe.paymentIntents.search({ query: `metadata['payment_id']:'${String(r.payment_id).replace(/'/g, '')}'`, limit: 5 });
        } catch (e) {
          if (isTransient(e)) { summary.still_unknown++; continue; }
          throw e;
        }
        intent = (found.data || []).find((pi) => pi.status === 'succeeded') || (found.data || [])[0] || null;
        if (!intent) {
          await markFailed(r.payment_id, null, 'never_charged');
          if (invoiceId && await combinedInvoiceService.stillUnpaid(invoiceId)) await routePaymentRequired(invoiceId, r.buyer_user_id, 'never_charged');
          summary.payment_required++; continue;
        }
      }

      await db.query(`UPDATE payments SET payment_intent_id = $1 WHERE id = $2 AND payment_intent_id IS NULL`, [intent.id, r.payment_id]);
      if (intent.status === 'succeeded') {
        const s = invoiceId ? await combinedInvoiceService.settleCombined(invoiceId, intent.id, r.payment_id) : null;
        if (s && s.settled) await combinedReceiptService.sendSuccessPackage(invoiceId);
        await auditService.logEvent(db, { eventType: 'payment.charge_uncertain_resolved', entityType: 'payment', entityId: r.payment_id,
          paymentId: r.payment_id, actorId: null, metadata: { outcome: 'succeeded', payment_intent_id: intent.id } });
        summary.settled++;
      } else if (intent.status === 'processing' || intent.status === 'requires_capture') {
        summary.pending++;   // the webhook finishes it
      } else {
        // Needs the buyer (authentication or a new card) or was canceled: the normal payment_required path.
        await markFailed(r.payment_id, intent.id, 'intent_' + intent.status);
        if (invoiceId && await combinedInvoiceService.stillUnpaid(invoiceId)) await routePaymentRequired(invoiceId, r.buyer_user_id, 'intent_' + intent.status);
        summary.payment_required++;
      }
    } catch (e) {
      summary.errors++;
      console.error('[combined-reconcile] could not resolve uncertain charge', { paymentId: r.payment_id, error: e.message });
    }
  }
  return summary;
}

module.exports = { reconcileUncertainCharges, routePaymentRequired, listUncertain, IDEMPOTENCY_WINDOW_MS };
