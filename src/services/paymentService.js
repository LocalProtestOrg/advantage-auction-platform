// PaymentService implementation
const db             = require('../db');
const auditService   = require('./auditService');
const invoiceService = require('./invoiceService');
const Stripe         = require('stripe');

// Pin Stripe API version. Pin target matches the SDK 22.0.2 default; pinning
// locks the contract against silent account-level version bumps in the Stripe
// Dashboard. Upgrade by editing this constant alongside SDK upgrades.
const STRIPE_API_VERSION = '2026-03-25.dahlia';

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

// Two-layer deduplication for Stripe webhook events:
// 1. In-memory Set — fast path for within-session duplicate deliveries. Only
//    warmed AFTER a successful _finalizeWebhookEvent('processed'), so its
//    presence guarantees the DB row is also 'processed'.
// 2. DB table stripe_webhook_events — survives restarts. Tracks claim-after-process
//    state: 'received' (claimed, in-flight), 'processed' (finalized successfully),
//    'failed' (handler threw; retryable on next delivery).
const MAX_PROCESSED_EVENTS = 5000;
const _processedEvents = new Set();
function _trackProcessedEvent(id) {
  if (_processedEvents.size >= MAX_PROCESSED_EVENTS) {
    _processedEvents.delete(_processedEvents.values().next().value); // evict oldest
  }
  _processedEvents.add(id);
}

// Stale-in-flight threshold. If a row sits in 'received' longer than this, the
// previous handler is presumed dead (process crashed mid-process) and the next
// delivery is allowed to take over. Set well above the longest legitimate
// handler runtime (Stripe call + DB tx, normally <5s; cap with margin).
const STALE_IN_FLIGHT_SECONDS = 300;

// Acquire a webhook event for processing. Returns one of:
//   { action: 'process' }   — caller MUST run the handler, then call _finalizeWebhookEvent
//   { action: 'skip' }      — event is a true duplicate; ignore and acknowledge
//   { action: 'in_flight' } — another delivery is currently being processed; acknowledge
async function _acquireWebhookEvent(eventId, eventType, payload) {
  // Try to claim a brand-new event row.
  const insert = await db.query(
    `INSERT INTO stripe_webhook_events (id, event_type, payload, status, attempt_count)
     VALUES ($1, $2, $3::jsonb, 'received', 1)
     ON CONFLICT (id) DO NOTHING`,
    [eventId, eventType, JSON.stringify(payload)]
  );
  if (insert.rowCount === 1) {
    return { action: 'process' };
  }

  // Conflict path — inspect the existing row to decide what to do.
  const existing = await db.query(
    `SELECT status, received_at, attempt_count, (payload IS NULL) AS legacy_row
       FROM stripe_webhook_events WHERE id = $1`,
    [eventId]
  );
  const row = existing.rows[0];
  if (!row) {
    // Row was deleted between our INSERT conflict and SELECT (operator action).
    // Retry the acquire — the INSERT will now succeed.
    return _acquireWebhookEvent(eventId, eventType, payload);
  }

  // Legacy/deploy-window rows: the old code inserted only on successful processing
  // and never wrote a payload. Promote to 'processed' (with payload archived for
  // any future replay) and treat as a duplicate. This guards against the migration
  // backfill having missed any deploy-window rows.
  if (row.legacy_row) {
    await db.query(
      `UPDATE stripe_webhook_events
          SET status = 'processed',
              processed_at = COALESCE(processed_at, now()),
              payload = $2::jsonb
        WHERE id = $1 AND payload IS NULL`,
      [eventId, JSON.stringify(payload)]
    );
    return { action: 'skip' };
  }

  if (row.status === 'processed') {
    return { action: 'skip' };
  }

  if (row.status === 'failed') {
    // Previous attempt threw. Reclaim for retry. Single-row guard prevents two
    // concurrent deliveries from both claiming the retry.
    const claim = await db.query(
      `UPDATE stripe_webhook_events
          SET status = 'received',
              attempt_count = attempt_count + 1,
              last_error = NULL,
              received_at = now()
        WHERE id = $1 AND status = 'failed'`,
      [eventId]
    );
    if (claim.rowCount === 1) return { action: 'process' };
    // Lost the race to another delivery — re-inspect.
    return _acquireWebhookEvent(eventId, eventType, payload);
  }

  // status === 'received'
  const ageSec = (Date.now() - new Date(row.received_at).getTime()) / 1000;
  if (ageSec > STALE_IN_FLIGHT_SECONDS) {
    // Previous handler is presumed dead. Take over.
    const claim = await db.query(
      `UPDATE stripe_webhook_events
          SET attempt_count = attempt_count + 1,
              received_at = now(),
              last_error = NULL
        WHERE id = $1 AND status = 'received' AND received_at = $2`,
      [eventId, row.received_at]
    );
    if (claim.rowCount === 1) return { action: 'process' };
    return _acquireWebhookEvent(eventId, eventType, payload);
  }

  // Recent in-flight delivery — another handler is on it. Acknowledge without acting.
  return { action: 'in_flight' };
}

// Finalize a previously-acquired event. Called exactly once after handler completes.
//   outcome='processed' → DB row marked done; in-memory cache warmed by caller
//   outcome='failed'    → DB row marked failed; Stripe retry will re-acquire
async function _finalizeWebhookEvent(eventId, outcome, errorMessage) {
  if (outcome === 'processed') {
    await db.query(
      `UPDATE stripe_webhook_events
          SET status = 'processed', processed_at = now(), last_error = NULL
        WHERE id = $1`,
      [eventId]
    );
    return;
  }
  // outcome === 'failed'
  await db.query(
    `UPDATE stripe_webhook_events
        SET status = 'failed', last_error = $2
      WHERE id = $1`,
    [eventId, (errorMessage || '').substring(0, 2000)]
  );
}

class PaymentService {
  async _ensureAdminRole(client, adminId) {
    const user = await client.query('SELECT role FROM users WHERE id = $1', [adminId]);
    if (!user.rows[0] || user.rows[0].role !== 'admin') {
      throw new Error('Unauthorized: Admin only');
    }
  }

  async createPaymentIntent(userId, auctionId, lotId) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const lotRes = await client.query(
        'SELECT state, winning_buyer_user_id, winning_amount_cents FROM lots WHERE id = $1 AND auction_id = $2',
        [lotId, auctionId]
      );
      if (!lotRes.rows[0]) {
        throw new Error('Lot not found');
      }
      const lot = lotRes.rows[0];

      // Lot must be closed (winner locked at closeAuction time)
      if (lot.state !== 'closed') {
        throw new Error('Lot must be closed before payment');
      }

      // Winning bidder must be set (locked at close time)
      if (!lot.winning_buyer_user_id || lot.winning_amount_cents === null) {
        throw new Error('Lot has no assigned winner');
      }

      // Only winning bidder can create payment
      if (lot.winning_buyer_user_id !== userId) {
        throw new Error('Only winning bidder can create payment');
      }

      // Check if a completed payment already exists — block only on paid/refunded
      const existingPayment = await client.query(
        `SELECT id, status FROM payments
         WHERE lot_id = $1 AND buyer_user_id = $2 AND status IN ('paid', 'refunded', 'partially_refunded')
         LIMIT 1`,
        [lotId, userId]
      );
      if (existingPayment.rows[0]) {
        throw new Error(`Payment already exists for this lot (status: ${existingPayment.rows[0].status}). Cannot create duplicate.`);
      }

      // Retire any stale pending payment so the DB unique constraint allows a fresh one
      await client.query(
        `UPDATE payments SET status = 'failed'
         WHERE lot_id = $1 AND buyer_user_id = $2 AND status = 'pending'`,
        [lotId, userId]
      );

      // Create the Stripe PaymentIntent before writing the DB row so we never
      // store a pending payment without a real intent backing it.
      const stripe = getStripe();
      const intent = await stripe.paymentIntents.create({
        amount:   lot.winning_amount_cents,
        currency: 'usd',
        metadata: { lot_id: lotId, auction_id: auctionId, buyer_user_id: userId },
      }, { timeout: 15000 });

      // Create pending payment row with the intent ID locked in.
      const payment = await client.query(
        `INSERT INTO payments (auction_id, lot_id, buyer_user_id, amount_cents, status, payment_intent_id)
         VALUES ($1, $2, $3, $4, 'pending', $5)
         RETURNING id, amount_cents, status, created_at`,
        [auctionId, lotId, userId, lot.winning_amount_cents, intent.id]
      );

      const paymentId = payment.rows[0].id;

      await auditService.logEvent(client, {
        eventType:  'payment.created',
        entityType: 'payment',
        entityId:   paymentId,
        auctionId,
        lotId,
        paymentId,
        actorId:    userId,
        metadata:   { amount_cents: payment.rows[0].amount_cents, status: 'pending', payment_intent_id: intent.id }
      });

      await client.query('COMMIT');
      return {
        id:                paymentId,
        lot_id:            lotId,
        auction_id:        auctionId,
        amount_cents:      payment.rows[0].amount_cents,
        status:            payment.rows[0].status,
        created_at:        payment.rows[0].created_at,
        payment_intent_id: intent.id,
        client_secret:     intent.client_secret,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordPaymentSuccess(paymentId, paymentProviderId) {
    // Record successful payment from provider.
    // Winner and amount already locked at auction close.
    //
    // Valid transitions:
    //   pending → paid   (normal path)
    //   failed  → paid   (recovery: local 3-retry exhaustion preceded an authoritative
    //                     Stripe success — Stripe is authoritative for settlement.
    //                     Audit log records the recovery via prior_status metadata.)
    //
    // Idempotent on paid (already-settled rows are returned as-is).
    //
    // Trigger: Assign buyer to pickup slot based on lot's size_category
    // Trigger: Send payment confirmation notification
    let payment, auctionId, pickupAssignment, priorStatus;
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const paymentRes = await client.query(
        'SELECT lot_id, buyer_user_id, amount_cents, status, retry_count FROM payments WHERE id = $1 FOR UPDATE',
        [paymentId]
      );
      if (!paymentRes.rows[0]) {
        throw new Error('Payment not found');
      }
      payment = paymentRes.rows[0];
      priorStatus = payment.status;

      // Idempotency: already paid — safe to return without re-processing.
      if (payment.status === 'paid') {
        await client.query('ROLLBACK');
        console.log(`[payment] recordPaymentSuccess: payment ${paymentId} already paid — skipping`);
        return { payment_id: paymentId, status: 'paid', charged_at: null };
      }

      // C-7 recovery: failed → paid is now allowed. Stripe success is authoritative;
      // local 3-retry exhaustion does not get to veto a real settlement.
      // Chargebacks/disputes arrive via separate event types and are not handled here.
      if (payment.status === 'failed') {
        console.warn(`[payment] recordPaymentSuccess: payment ${paymentId} recovering from failed (retry_count=${payment.retry_count}) — Stripe-authoritative settlement`);
      }

      // Get lot info for notifications
      const lotRes = await client.query(
        'SELECT auction_id FROM lots WHERE id = $1',
        [payment.lot_id]
      );
      auctionId = lotRes.rows[0]?.auction_id;

      // Update payment status
      await client.query(
        `UPDATE payments
         SET status = 'paid', charged_at = now(), payment_provider_id = $1, last_attempted_at = now()
         WHERE id = $2`,
        [paymentProviderId, paymentId]
      );

      // Load full payment row for invoice creation
      const paidPaymentRes = await client.query(
        'SELECT * FROM payments WHERE id = $1',
        [paymentId]
      );
      const invoice = await invoiceService.createInvoice(client, paidPaymentRes.rows[0]);
      console.log(`[invoice] created invoice ${invoice.id} for payment ${paymentId}`);

      // Assign buyer to pickup slot
      const pickupScheduleService = require('./pickupScheduleService');
      pickupAssignment = await pickupScheduleService.assignPickupOnPayment(client, payment.lot_id, payment.buyer_user_id);

      await auditService.logEvent(client, {
        eventType:  'payment.paid',
        entityType: 'payment',
        entityId:   paymentId,
        auctionId,
        lotId:      payment.lot_id,
        paymentId,
        actorId:    payment.buyer_user_id,
        metadata: {
          payment_provider_id:   paymentProviderId,
          prior_status:          priorStatus,
          recovered_from_failed: priorStatus === 'failed',
          prior_retry_count:     payment.retry_count,
        }
      });

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Fire-and-forget events run outside the transaction so a failure here
    // cannot trigger a spurious ROLLBACK on an already-committed transaction.
    const { emitEvent, EVENTS } = require('./eventEmitter');

    emitEvent(EVENTS.PAYMENT_CONFIRMED, {
      buyerUserId: payment.buyer_user_id,
      paymentId,
      lotId: payment.lot_id,
      auctionId,
      amountCents: payment.amount_cents
    });

    if (pickupAssignment?.pickupAssignmentId) {
      const verifyClient = await db.connect();
      try {
        const verifyRes = await verifyClient.query(
          `SELECT id, slot_start, slot_end FROM pickup_assignments
           WHERE id = $1 AND lot_id = $2 AND buyer_user_id = $3`,
          [pickupAssignment.pickupAssignmentId, payment.lot_id, payment.buyer_user_id]
        );
        if (verifyRes.rows[0]) {
          const verifiedAssignment = verifyRes.rows[0];
          emitEvent(EVENTS.PICKUP_SCHEDULED, {
            buyerUserId: payment.buyer_user_id,
            pickupAssignmentId: verifiedAssignment.id,
            lotId: payment.lot_id,
            auctionId,
            slotStart: verifiedAssignment.slot_start,
            slotEnd: verifiedAssignment.slot_end
          });
        } else {
          console.warn(`Pickup assignment ${pickupAssignment.pickupAssignmentId} not found after commit - notification skipped`);
        }
      } catch (verifyError) {
        console.error('Failed to verify pickup assignment:', verifyError.message);
      } finally {
        verifyClient.release();
      }
    }

    return {
      payment_id: paymentId,
      status: 'paid',
      charged_at: new Date()
    };
  }

  async recordPaymentFailure(paymentId) {
    // Record failed payment attempt and increment retry count
    // Valid transition: pending → pending (retry) OR pending → failed (after 3 retries)
    // Tracks last_attempted_at for optional cooldown/retry scheduling logic
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const paymentRes = await client.query(
        'SELECT status, retry_count FROM payments WHERE id = $1 FOR UPDATE',
        [paymentId]
      );
      if (!paymentRes.rows[0]) {
        throw new Error('Payment not found');
      }

      // Idempotency: already in a terminal state — safe to return without re-processing.
      if (paymentRes.rows[0].status === 'paid') {
        await client.query('ROLLBACK');
        console.log(`[payment] recordPaymentFailure: payment ${paymentId} already paid — skipping`);
        return { payment_id: paymentId, status: 'paid', retry_count: paymentRes.rows[0].retry_count, last_attempted_at: null };
      }
      if (paymentRes.rows[0].status === 'failed') {
        await client.query('ROLLBACK');
        console.log(`[payment] recordPaymentFailure: payment ${paymentId} already failed — skipping`);
        return { payment_id: paymentId, status: 'failed', retry_count: paymentRes.rows[0].retry_count, last_attempted_at: null };
      }

      const newRetryCount = (paymentRes.rows[0].retry_count || 0) + 1;

      // Update to failed status after 3 retries, otherwise stay pending
      const newStatus = newRetryCount >= 3 ? 'failed' : 'pending';

      // Record attempt timestamp for cooldown/scheduling logic
      await client.query(
        `UPDATE payments
         SET status = $1, retry_count = $2, last_attempted_at = now()
         WHERE id = $3`,
        [newStatus, newRetryCount, paymentId]
      );

      await client.query('COMMIT');
      return {
        payment_id: paymentId,
        status: newStatus,
        retry_count: newRetryCount,
        last_attempted_at: new Date()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // TODO: Implement optional cooldown/backoff logic (e.g., exponential backoff between retries)
  // TODO: Add query to find payments eligible for retry based on last_attempted_at + cooldown window

  async processRefund(adminId, paymentId, refundAmountCents) {
    // Admin-only refund logic
    // Valid transition: paid → refunded OR paid → partially_refunded (and ONLY from paid)
    //
    // Execution order (matches createPaymentIntent pattern — Stripe before DB write):
    //   1. Validate payment state inside a locked transaction
    //   2. Call stripe.refunds.create() — if this throws, ROLLBACK and surface the error
    //   3. Write DB status + stripe_refund_id atomically, then COMMIT
    //   4. Log audit event inside the same transaction
    //
    // If Stripe succeeds but COMMIT fails (rare crash window), the stripe_refund_id
    // from the thrown error is logged so an admin can manually reconcile in the
    // Stripe Dashboard. The buyer's money is already returned at that point.
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdminRole(client, adminId);

      const paymentRes = await client.query(
        `SELECT status, amount_cents, payment_intent_id, lot_id, auction_id
           FROM payments WHERE id = $1 FOR UPDATE`,
        [paymentId]
      );
      if (!paymentRes.rows[0]) {
        throw new Error('Payment not found');
      }
      const payment = paymentRes.rows[0];

      // Guard: ONLY paid → refunded/partially_refunded allowed
      if (payment.status !== 'paid') {
        throw new Error(`Cannot refund ${payment.status} payment. Only paid payments can be refunded.`);
      }

      if (refundAmountCents <= 0 || refundAmountCents > payment.amount_cents) {
        throw new Error('Refund amount must be between 0 and the payment amount');
      }

      // Execute Stripe refund for payments that have a real PaymentIntent.
      // Payments without payment_intent_id are seeded/test records — Stripe call skipped.
      let stripeRefundId = null;
      if (payment.payment_intent_id) {
        const stripe = getStripe();
        let stripeRefund;
        try {
          stripeRefund = await stripe.refunds.create({
            payment_intent: payment.payment_intent_id,
            amount:         refundAmountCents,
          });
        } catch (stripeErr) {
          console.error('[refund] Stripe refund API failed:', {
            paymentId,
            payment_intent_id: payment.payment_intent_id,
            amount_cents: refundAmountCents,
            error: stripeErr.message,
          });
          throw new Error(`Stripe refund failed: ${stripeErr.message}`);
        }
        stripeRefundId = stripeRefund.id;
      } else {
        console.warn('[refund] No payment_intent_id — Stripe refund skipped (seeded/test payment)', { paymentId });
      }

      const isFullRefund = refundAmountCents === payment.amount_cents;
      const newStatus = isFullRefund ? 'refunded' : 'partially_refunded';
      const refundedAt = new Date();

      await client.query(
        `UPDATE payments
         SET status = $1, refunded_at = $2, stripe_refund_id = $3
         WHERE id = $4`,
        [newStatus, refundedAt, stripeRefundId, paymentId]
      );

      await auditService.logEvent(client, {
        eventType:  'payment.refunded',
        entityType: 'payment',
        entityId:   paymentId,
        auctionId:  payment.auction_id,
        lotId:      payment.lot_id,
        paymentId,
        actorId:    adminId,
        metadata: {
          refund_amount_cents: refundAmountCents,
          stripe_refund_id:   stripeRefundId,
          status:             newStatus,
        }
      });

      await client.query('COMMIT');
      return {
        payment_id:         paymentId,
        status:             newStatus,
        refund_amount_cents: refundAmountCents,
        stripe_refund_id:   stripeRefundId,
        refunded_at:        refundedAt,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPaymentStatus(paymentId) {
    const payment = await db.query(
      'SELECT id, lot_id, buyer_user_id, amount_cents, status, charged_at, created_at FROM payments WHERE id = $1',
      [paymentId]
    );
    if (!payment.rows[0]) {
      throw new Error('Payment not found');
    }
    return payment.rows[0];
  }

  async _ensurePaymentVerified(client, lotId, buyerUserId) {
    // Guard for address visibility: payment must be 'paid' to reveal full address
    // Used to prevent premature address disclosure before payment confirmed
    const payment = await client.query(
      'SELECT status FROM payments WHERE lot_id = $1 AND buyer_user_id = $2 ORDER BY created_at DESC LIMIT 1',
      [lotId, buyerUserId]
    );
    if (!payment.rows[0]) {
      throw new Error('No payment record found');
    }
    if (payment.rows[0].status !== 'paid') {
      throw new Error('Full address available only after payment is confirmed');
    }
  }

  // TODO: In route/seller view layer: IF payment.status !== 'paid' THEN hide auction.address_encrypted
  // TODO: Decrypt and return full address ONLY after _ensurePaymentVerified() passes
  // TODO: Add buyer invoice generation that includes address (only for paid payments)

  // ── handleWebhookEvent ───────────────────────────────────────────────────────
  // Called by the /webhook route after Stripe signature is verified.
  //
  // Claim-after-process semantics: a row in stripe_webhook_events is marked
  // 'processed' iff the business handler succeeded. If the handler throws, the
  // row is marked 'failed' and this method rethrows so the route returns 500
  // and Stripe retries.
  async handleWebhookEvent(event) {
    console.log(`[webhook] received ${event.type} ${event.id}`);

    // Fast path: in-memory dedup. Only contains events we have confirmed as
    // 'processed' in the DB, so a hit is authoritative.
    if (_processedEvents.has(event.id)) {
      console.log(`[webhook] ${event.id} already processed (in-memory) — skipped`);
      return;
    }

    const acquire = await _acquireWebhookEvent(event.id, event.type, event);
    if (acquire.action === 'skip') {
      _trackProcessedEvent(event.id);
      console.log(`[webhook] ${event.id} already processed (db) — skipped`);
      return;
    }
    if (acquire.action === 'in_flight') {
      // Another delivery is currently processing this event. Acknowledge to
      // Stripe without re-running. If that handler fails, Stripe will retry
      // and a later delivery will find status='failed' and reclaim.
      console.log(`[webhook] ${event.id} in-flight on concurrent delivery — acknowledging`);
      return;
    }

    // acquire.action === 'process'
    try {
      await this._dispatchWebhookEvent(event);
      await _finalizeWebhookEvent(event.id, 'processed');
      _trackProcessedEvent(event.id);
    } catch (err) {
      // Best-effort finalize as failed. If the finalize itself fails, log it
      // but rethrow the original handler error so the route returns 500 and
      // Stripe retries. Worst case: row stays 'received' and stale-takeover
      // recovers it on the next delivery.
      try {
        await _finalizeWebhookEvent(event.id, 'failed', err.message);
      } catch (finalizeErr) {
        console.error('[webhook] finalize-as-failed errored', {
          event_id: event.id,
          finalize_error: finalizeErr.message,
          handler_error:  err.message,
        });
      }
      throw err;
    }
  }

  // Internal dispatch — assumes the event has already been acquired.
  async _dispatchWebhookEvent(event) {
    const obj = event.data.object;

    if (event.type === 'payment_intent.succeeded') {
      return this._handlePaymentIntentSucceeded(obj);
    }
    if (event.type === 'payment_intent.payment_failed') {
      return this._handlePaymentIntentFailed(obj);
    }
    if (event.type === 'payment_intent.canceled') {
      return this._handlePaymentIntentCanceled(obj);
    }
    if (event.type === 'charge.refunded') {
      return this._handleChargeRefunded(obj);
    }
    // All other event types are acknowledged without action. The row is still
    // marked 'processed' so we do not re-acquire on every delivery.
  }

  async _handlePaymentIntentSucceeded(intent) {
    // M-7 fix: metadata is informational only. Lookup is by intent.id (Stripe-authoritative).
    // Do not silently drop the event on missing metadata — that previously caused
    // money-received-but-not-recorded outcomes.
    const paymentRes = await db.query(
      `SELECT id FROM payments WHERE payment_intent_id = $1 LIMIT 1`,
      [intent.id]
    );
    if (!paymentRes.rows[0]) {
      // No DB row for an intent Stripe says succeeded. This is an orphan
      // PaymentIntent. Throw so the event is marked failed; operator must
      // reconcile (either create the missing payment row or refund the intent).
      const { lot_id, auction_id, buyer_user_id } = intent.metadata || {};
      console.warn('[webhook] payment_intent.succeeded — no payment row for intent', {
        intent_id:     intent.id,
        metadata:      { lot_id, auction_id, buyer_user_id },
      });
      throw new Error(`No payment row for intent ${intent.id}`);
    }
    const paymentId = paymentRes.rows[0].id;
    // recordPaymentSuccess handles idempotency (already-paid), invoice creation,
    // pickup assignment, audit logging, and downstream notification events.
    await this.recordPaymentSuccess(paymentId, intent.id);
    console.log(`[webhook] payment_intent.succeeded → payment ${paymentId} marked paid (intent=${intent.id})`);
  }

  async _handlePaymentIntentFailed(intent) {
    const paymentRes = await db.query(
      `SELECT id FROM payments WHERE payment_intent_id = $1 LIMIT 1`,
      [intent.id]
    );
    if (!paymentRes.rows[0]) {
      // No DB row for an intent that failed — nothing to record. Acknowledge
      // without throwing; this is not a settlement-integrity issue.
      console.warn(`[webhook] payment_intent.payment_failed — no payment row for intent ${intent.id}`);
      return;
    }
    const paymentId = paymentRes.rows[0].id;
    await this.recordPaymentFailure(paymentId);
    console.log(`[webhook] payment_intent.payment_failed → payment ${paymentId} failure recorded`);
  }

  async _handlePaymentIntentCanceled(intent) {
    // Terminal cancellation (not a retryable decline). Move any still-pending
    // payment row to 'failed' so it does not sit in limbo and so the unique
    // partial index allows a fresh charge attempt later if needed.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const paymentRes = await client.query(
        `SELECT id, status, lot_id, auction_id, buyer_user_id
           FROM payments WHERE payment_intent_id = $1 FOR UPDATE`,
        [intent.id]
      );
      if (!paymentRes.rows[0]) {
        await client.query('ROLLBACK');
        console.warn(`[webhook] payment_intent.canceled — no payment row for intent ${intent.id}`);
        return;
      }
      const payment = paymentRes.rows[0];
      if (payment.status !== 'pending') {
        await client.query('ROLLBACK');
        console.log(`[webhook] payment_intent.canceled — payment ${payment.id} not pending (status=${payment.status}); no-op`);
        return;
      }
      await client.query(
        `UPDATE payments
            SET status = 'failed', last_attempted_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [payment.id]
      );
      await auditService.logEvent(client, {
        eventType:  'payment.canceled',
        entityType: 'payment',
        entityId:   payment.id,
        auctionId:  payment.auction_id,
        lotId:      payment.lot_id,
        paymentId:  payment.id,
        actorId:    payment.buyer_user_id,
        metadata: {
          source:    'stripe_webhook.payment_intent.canceled',
          intent_id: intent.id,
        }
      });
      await client.query('COMMIT');
      console.log(`[webhook] payment_intent.canceled → payment ${payment.id} marked failed`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async _handleChargeRefunded(charge) {
    // Reconciles DB to Stripe-authoritative refund state. Triggered by both our
    // own processRefund flow (Stripe echoes back via this event) and by
    // out-of-band refunds (Stripe Dashboard, support tooling).
    //
    // If this event is an echo of our own refund (matching stripe_refund_id),
    // it is a no-op. Otherwise the DB is brought into alignment with Stripe.
    const intentId = charge.payment_intent;
    if (!intentId) {
      console.warn(`[webhook] charge.refunded — charge ${charge.id} has no payment_intent; skipping`);
      return;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const paymentRes = await client.query(
        `SELECT id, status, amount_cents, lot_id, auction_id, stripe_refund_id
           FROM payments WHERE payment_intent_id = $1 FOR UPDATE`,
        [intentId]
      );
      if (!paymentRes.rows[0]) {
        await client.query('ROLLBACK');
        console.warn(`[webhook] charge.refunded — no payment row for intent ${intentId}`);
        return;
      }
      const payment = paymentRes.rows[0];

      // Identify the most recent Stripe refund attached to this charge.
      const refunds = (charge.refunds && Array.isArray(charge.refunds.data)) ? charge.refunds.data : [];
      const latestRefund   = refunds.length ? refunds[refunds.length - 1] : null;
      const latestRefundId = latestRefund ? latestRefund.id : null;

      // Echo of our own processRefund — already recorded, nothing to reconcile.
      if (payment.stripe_refund_id && latestRefundId && payment.stripe_refund_id === latestRefundId) {
        await client.query('ROLLBACK');
        console.log(`[webhook] charge.refunded — payment ${payment.id} already reconciled (refund=${latestRefundId})`);
        return;
      }

      // Compute reconciled status from Stripe's authoritative amount_refunded.
      const amountRefunded = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
      const isFull = amountRefunded >= payment.amount_cents;
      const newStatus = isFull ? 'refunded' : 'partially_refunded';
      const priorStatus = payment.status;

      await client.query(
        `UPDATE payments
            SET status = $1,
                refunded_at = COALESCE(refunded_at, now()),
                stripe_refund_id = COALESCE($2, stripe_refund_id)
          WHERE id = $3`,
        [newStatus, latestRefundId, payment.id]
      );
      await auditService.logEvent(client, {
        eventType:  'payment.refunded',
        entityType: 'payment',
        entityId:   payment.id,
        auctionId:  payment.auction_id,
        lotId:      payment.lot_id,
        paymentId:  payment.id,
        actorId:    null,
        metadata: {
          source:                'stripe_webhook.charge.refunded',
          stripe_charge_id:      charge.id,
          stripe_refund_id:      latestRefundId,
          amount_refunded_cents: amountRefunded,
          prior_status:          priorStatus,
          new_status:            newStatus,
        }
      });
      await client.query('COMMIT');
      console.log(`[webhook] charge.refunded → payment ${payment.id} reconciled (status=${newStatus}, refund=${latestRefundId})`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = new PaymentService();
