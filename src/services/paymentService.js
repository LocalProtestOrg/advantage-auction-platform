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

// Maximum acquire attempts. The loop below only re-iterates on transient races
// (the row was deleted mid-acquire, or we lost a failed-row reclaim to a concurrent
// delivery). This hard cap makes it impossible for the acquire path to spin
// unbounded — the failure mode DEFECT-LINEB-1 produced via recursion on a
// never-matching takeover guard.
const MAX_ACQUIRE_ATTEMPTS = 5;

// Acquire a webhook event for processing. Returns one of:
//   { action: 'process' }   — caller MUST run the handler, then call _finalizeWebhookEvent
//   { action: 'skip' }      — event is a true duplicate; ignore and acknowledge
//   { action: 'in_flight' } — another delivery is currently being processed; acknowledge
//
// Concurrency model: every state transition is an atomic conditional UPDATE whose
// WHERE clause IS the compare-and-swap. Postgres row locks serialize concurrent
// deliveries, so exactly one wins each transition. Crucially, staleness is evaluated
// entirely server-side (`received_at < now() - interval`); a timestamp is never
// round-tripped through a JS Date and compared for equality. That round-trip lost
// microsecond precision (Postgres `now()` is µs; JS Date is ms), so the old
// `received_at = $2` guard never matched and the function recursed forever
// (DEFECT-LINEB-1: webhook request hangs → HTTP 502 → acquire-loop hammers the DB).
async function _acquireWebhookEvent(eventId, eventType, payload) {
  for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt++) {
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

    // Conflict path — inspect the existing row to decide what to do. We only need
    // the status and whether it is a legacy (payload-less) row; the staleness
    // decision is made by Postgres in the takeover UPDATE below, NOT in JS.
    const existing = await db.query(
      `SELECT status, (payload IS NULL) AS legacy_row
         FROM stripe_webhook_events WHERE id = $1`,
      [eventId]
    );
    const row = existing.rows[0];
    if (!row) {
      // Row was deleted between our INSERT conflict and SELECT (operator action).
      // Re-iterate — the INSERT will now succeed. Bounded by MAX_ACQUIRE_ATTEMPTS.
      continue;
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

    // Already processed — idempotent duplicate.
    if (row.status === 'processed') {
      return { action: 'skip' };
    }

    // Previous attempt threw and was finalized 'failed'. Reclaim for retry. The
    // `status = 'failed'` guard is the compare-and-swap: only one concurrent
    // delivery can flip it back to 'received'.
    if (row.status === 'failed') {
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
      // Lost the race to another delivery — re-inspect. Bounded.
      continue;
    }

    // status === 'received'. Atomic stale-takeover: claim the row ONLY if it has
    // been 'received' longer than STALE_IN_FLIGHT_SECONDS (previous handler presumed
    // dead). The staleness predicate is evaluated by Postgres against the stored
    // timestamptz at full precision — there is no JS Date equality guard, so the
    // ms/µs precision mismatch behind DEFECT-LINEB-1 cannot recur. The row lock
    // makes the UPDATE a single-winner compare-and-swap under concurrency.
    // STALE_IN_FLIGHT_SECONDS is a trusted internal integer constant (safe to inline).
    const takeover = await db.query(
      `UPDATE stripe_webhook_events
          SET attempt_count = attempt_count + 1,
              received_at = now(),
              last_error = NULL
        WHERE id = $1
          AND status = 'received'
          AND received_at < now() - interval '${STALE_IN_FLIGHT_SECONDS} seconds'`,
      [eventId]
    );
    if (takeover.rowCount === 1) {
      // We took over a stale row (previous handler presumed dead).
      return { action: 'process' };
    }

    // rowCount 0 ⇒ the row is either still fresh (a genuine concurrent in-flight
    // delivery, not yet stale) or another delivery just took it over. Either way
    // someone else owns it right now — acknowledge without acting. If that owner
    // ultimately fails, the row becomes 'failed' and the next delivery reclaims it
    // via the failed-row branch above; Stripe's retries drive that redelivery.
    return { action: 'in_flight' };
  }

  // Exhausted attempts on transient churn (row repeatedly deleted, or repeatedly
  // lost the failed-reclaim race). Acknowledge without processing so we can never
  // spin; Stripe will redeliver and a later, uncontended delivery resolves it.
  console.warn(`[webhook] _acquireWebhookEvent: exhausted ${MAX_ACQUIRE_ATTEMPTS} attempts for ${eventId} — acknowledging as in_flight`);
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

  async createPaymentIntent(userId, auctionId, lotId, idempotencyKey) {
    // Sub-batch 2 reorder (C-2 + M-1):
    //   tx1: validate, retire stale-orphaned pending, INSERT payment (intent_id=NULL), COMMIT
    //   --- locks released BEFORE any external call ---
    //   Stripe call (idempotencyKey = HTTP header value, so retries are deterministic)
    //   tx2: UPDATE payment_intent_id, audit 'payment.intent_attached', COMMIT
    //   on Stripe failure: separate tx marks the row 'failed' and rethrows.
    //
    // Transitional state (I-1): a row may sit with status='pending' and
    // payment_intent_id=NULL for the duration of the Stripe call. The R-2
    // health metric surfaces any row stuck in this state for >5 minutes.
    //
    // I-4 guard: the retire-stale-pending UPDATE only retires rows that are
    // already orphaned (intent_id IS NULL AND created_at < now() - 60s). This
    // prevents a concurrent retry from retiring a row that is currently mid-
    // Stripe-call by another process.
    let paymentId, amountCents, paymentCreatedAt;
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

      // I-4 retire guard: only retire orphaned transitional rows (intent_id NULL,
      // older than 60s). A pending row with intent_id set is actively mid-Stripe-
      // call from another process — must NOT be touched. The partial unique index
      // idx_payments_unique_active will block our subsequent INSERT if such a row
      // exists, which is the correct outcome (concurrent attempts conflict).
      await client.query(
        `UPDATE payments
            SET status = 'failed', last_attempted_at = now()
          WHERE lot_id = $1
            AND buyer_user_id = $2
            AND status = 'pending'
            AND payment_intent_id IS NULL
            AND created_at < now() - interval '60 seconds'`,
        [lotId, userId]
      );

      // Insert pending payment row WITHOUT intent_id. The intent will be
      // attached in tx2 after the Stripe call succeeds. The partial unique
      // index idx_payments_unique_active enforces single-pending per (lot,
      // buyer) at commit time.
      const inserted = await client.query(
        `INSERT INTO payments (auction_id, lot_id, buyer_user_id, amount_cents, status, payment_intent_id)
         VALUES ($1, $2, $3, $4, 'pending', NULL)
         RETURNING id, amount_cents, created_at`,
        [auctionId, lotId, userId, lot.winning_amount_cents]
      );
      paymentId        = inserted.rows[0].id;
      amountCents      = inserted.rows[0].amount_cents;
      paymentCreatedAt = inserted.rows[0].created_at;

      await auditService.logEvent(client, {
        eventType:  'payment.created',
        entityType: 'payment',
        entityId:   paymentId,
        auctionId,
        lotId,
        paymentId,
        actorId:    userId,
        metadata: {
          amount_cents:    amountCents,
          status:          'pending',
          intent_attached: false,
        }
      });

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // ── External call OUTSIDE any DB transaction ───────────────────────────
    // Stripe idempotency key: prefer the HTTP Idempotency-Key the client sent,
    // so retries within Stripe's 24h idempotency window collapse to the same
    // PaymentIntent. Fallback to payment.id if no HTTP key was provided
    // (defensive — the route currently rejects requests without the header).
    const stripeKey = idempotencyKey || paymentId;
    let intent;
    try {
      const stripe = getStripe();
      intent = await stripe.paymentIntents.create({
        amount:   amountCents,
        currency: 'usd',
        metadata: { lot_id: lotId, auction_id: auctionId, buyer_user_id: userId, payment_id: paymentId },
      }, { timeout: 15000, idempotencyKey: stripeKey });
    } catch (stripeErr) {
      // Release the slot so a retry can proceed cleanly. Only flip rows that
      // are still in the transitional state — guards against a concurrent
      // recovery flow that may have already attached an intent.
      const failClient = await db.connect();
      try {
        await failClient.query('BEGIN');
        await failClient.query(
          `UPDATE payments
              SET status = 'failed', last_attempted_at = now()
            WHERE id = $1 AND status = 'pending' AND payment_intent_id IS NULL`,
          [paymentId]
        );
        await auditService.logEvent(failClient, {
          eventType:  'payment.intent_create_failed',
          entityType: 'payment',
          entityId:   paymentId,
          auctionId,
          lotId,
          paymentId,
          actorId:    userId,
          metadata: {
            source:           'createPaymentIntent',
            stripe_error:     stripeErr.message,
            idempotency_key:  stripeKey,
          }
        });
        await failClient.query('COMMIT');
      } catch (cleanupErr) {
        await failClient.query('ROLLBACK').catch(() => {});
        console.error('[payment] createPaymentIntent cleanup failed', {
          paymentId,
          cleanup_error: cleanupErr.message,
          original_error: stripeErr.message,
        });
      } finally {
        failClient.release();
      }
      throw stripeErr;
    }

    // ── Attach the intent (tx2) ───────────────────────────────────────────
    const attachClient = await db.connect();
    try {
      await attachClient.query('BEGIN');
      const updateRes = await attachClient.query(
        `UPDATE payments
            SET payment_intent_id = $1
          WHERE id = $2 AND payment_intent_id IS NULL
          RETURNING id, status`,
        [intent.id, paymentId]
      );
      if (updateRes.rowCount !== 1) {
        // The row already had an intent attached (probably by a recovery flow
        // for the same HTTP idempotency key). Stripe returned the same intent
        // via its idempotency cache; the existing attachment is authoritative.
        // No-op on attach; still safe to return the intent details.
        console.warn(`[payment] intent attach found existing intent_id on payment ${paymentId} — Stripe returned cached intent ${intent.id}`);
      } else {
        await auditService.logEvent(attachClient, {
          eventType:  'payment.intent_attached',
          entityType: 'payment',
          entityId:   paymentId,
          auctionId,
          lotId,
          paymentId,
          actorId:    userId,
          metadata: {
            payment_intent_id: intent.id,
            idempotency_key:   stripeKey,
          }
        });
      }
      await attachClient.query('COMMIT');
    } catch (attachErr) {
      await attachClient.query('ROLLBACK').catch(() => {});
      // The Stripe intent exists but we failed to record it. The R-2 health
      // metric (payments_orphaned_intent_count) surfaces this row after 5
      // minutes. A retry with the same HTTP idempotency key will return the
      // same intent from Stripe and re-attempt the UPDATE.
      console.error('[payment] intent_attached UPDATE failed — payment row may be stuck in transitional state', {
        paymentId,
        intent_id: intent.id,
        error: attachErr.message,
      });
      throw attachErr;
    } finally {
      attachClient.release();
    }

    return {
      id:                paymentId,
      lot_id:            lotId,
      auction_id:        auctionId,
      amount_cents:      amountCents,
      status:            'pending',
      created_at:        paymentCreatedAt,
      payment_intent_id: intent.id,
      client_secret:     intent.client_secret,
    };
  }

  // ── Design C: combined per-buyer off-session charge (FLAG-INERT) ─────────────
  // Pure resolution of the off-session charge context. Given the buyer's Stripe
  // customer id + candidate payment methods, decide whether we can charge and with
  // which PM. Prefers the local 'verified' card marker, then the customer's default
  // PM. Returns { skipped:'no_card' } when either the customer or a usable PM is
  // missing (caller then routes the header to payment_required). Never throws.
  _resolveCombinedChargeContext({ stripeCustomerId, verifiedPmId, defaultPmId } = {}) {
    if (!stripeCustomerId) return { skipped: 'no_card' };
    const paymentMethodId = verifiedPmId || defaultPmId || null;
    if (!paymentMethodId) return { skipped: 'no_card' };
    return { customerId: stripeCustomerId, paymentMethodId };
  }

  // Load the raw context the pure resolver needs. Only calls Stripe (for the
  // customer's default PM) when there is no local verified marker.
  async _loadCombinedChargeContext(buyerUserId) {
    const u = (await db.query('SELECT stripe_customer_id FROM users WHERE id = $1', [buyerUserId])).rows[0] || {};
    const cv = (await db.query(
      `SELECT stripe_payment_method_id
         FROM card_verifications
        WHERE user_id = $1 AND status = 'verified' AND stripe_payment_method_id IS NOT NULL
        ORDER BY attempted_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [buyerUserId]
    )).rows[0];
    let defaultPmId = null;
    if (u.stripe_customer_id && !(cv && cv.stripe_payment_method_id)) {
      try {
        const stripe = getStripe();
        const cust = await stripe.customers.retrieve(u.stripe_customer_id);
        let dp = cust && cust.invoice_settings && cust.invoice_settings.default_payment_method;
        if (dp && typeof dp === 'object') dp = dp.id;
        defaultPmId = dp || null;
      } catch (_e) { /* best-effort — resolver will fall back to no_card */ }
    }
    return {
      stripeCustomerId: u.stripe_customer_id || null,
      verifiedPmId: (cv && cv.stripe_payment_method_id) || null,
      defaultPmId,
    };
  }

  // Charge a combined per-buyer invoice off-session. Mirrors createPaymentIntent's
  // idempotency discipline (insert pending row first, Stripe OUTSIDE the tx, attach
  // intent in a follow-up tx) but for lot_id=NULL combined payments, guarded by the
  // partial unique index idx_payments_combined_active.
  //
  // Does NOT settle — returns the outcome for the caller (combinedInvoiceService)
  // to route to settleCombined / markFailed:
  //   { skipped:'no_card' }               — no customer/PM; caller → payment_required
  //   { inProgress:true }                 — a combined charge is already in flight
  //   { status:'succeeded', paymentId, intentId }
  //   { status:'pending',   paymentId, intentId }  — requires_action / processing
  //   { status:'failed',    paymentId, reason }     — card_declined / authentication_required
  async chargeCombinedOffSession({ auctionId, buyerUserId, combinedInvoiceId, amountCents, idempotencyKey }) {
    // 1. Resolve customer + payment method. No card → skip (never throw).
    const ctx = await this._loadCombinedChargeContext(buyerUserId);
    const resolved = this._resolveCombinedChargeContext(ctx);
    if (resolved.skipped) return { skipped: resolved.skipped };

    // 2. Insert a pending combined payment row (lot_id NULL). The partial unique
    //    index blocks a duplicate active combined charge → treat as in-progress.
    let paymentId;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO payments (auction_id, lot_id, buyer_user_id, amount_cents, status, payment_intent_id)
         VALUES ($1, NULL, $2, $3, 'pending', NULL)
         RETURNING id`,
        [auctionId, buyerUserId, amountCents]
      );
      paymentId = inserted.rows[0].id;
      await auditService.logEvent(client, {
        eventType:  'payment.created',
        entityType: 'payment',
        entityId:   paymentId,
        auctionId,
        paymentId,
        actorId:    buyerUserId,
        metadata: { amount_cents: amountCents, status: 'pending', combined: true, combined_invoice_id: combinedInvoiceId },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      if (err && err.code === '23505') {
        // Unique violation on idx_payments_combined_active — a combined charge is
        // already pending/paid for this (auction, buyer).
        return { inProgress: true };
      }
      throw err;
    }
    client.release();

    // 3. Stripe off-session confirm. External call OUTSIDE any DB transaction.
    const stripeKey = idempotencyKey || ('combined:' + combinedInvoiceId);
    let intent;
    try {
      const stripe = getStripe();
      intent = await stripe.paymentIntents.create({
        amount:         amountCents,
        currency:       'usd',
        customer:       resolved.customerId,
        payment_method: resolved.paymentMethodId,
        off_session:    true,
        confirm:        true,
        metadata: { combined_invoice_id: combinedInvoiceId, auction_id: auctionId, buyer_user_id: buyerUserId, payment_id: paymentId },
      }, { timeout: 15000, idempotencyKey: stripeKey });
    } catch (stripeErr) {
      // Off-session declines (card_declined) and authentication_required surface as
      // StripeCardError. Mark the payment failed and return the outcome — do NOT throw
      // for a card problem (caller routes the header to payment_required + Reminder #1).
      const isCardError = stripeErr && (
        stripeErr.type === 'StripeCardError' ||
        stripeErr.code === 'card_declined' ||
        stripeErr.code === 'authentication_required'
      );
      const attachedIntentId = stripeErr && stripeErr.raw && stripeErr.raw.payment_intent && stripeErr.raw.payment_intent.id;
      const fc = await db.connect();
      try {
        await fc.query('BEGIN');
        await fc.query(
          `UPDATE payments
              SET status = 'failed', last_attempted_at = now(),
                  payment_intent_id = COALESCE(payment_intent_id, $2)
            WHERE id = $1 AND status = 'pending'`,
          [paymentId, attachedIntentId || null]
        );
        await auditService.logEvent(fc, {
          eventType:  'payment.intent_create_failed',
          entityType: 'payment',
          entityId:   paymentId,
          auctionId,
          paymentId,
          actorId:    buyerUserId,
          metadata: { source: 'chargeCombinedOffSession', stripe_error: stripeErr.message, combined_invoice_id: combinedInvoiceId },
        });
        await fc.query('COMMIT');
      } catch (cleanupErr) {
        await fc.query('ROLLBACK').catch(() => {});
        console.error('[combined] chargeCombinedOffSession cleanup failed', { paymentId, cleanup_error: cleanupErr.message, original_error: stripeErr.message });
      } finally {
        fc.release();
      }
      if (isCardError) return { status: 'failed', paymentId, reason: stripeErr.code || stripeErr.message };
      throw stripeErr;
    }

    // Attach the intent id (tx2) — mirror createPaymentIntent's discipline.
    const attachClient = await db.connect();
    try {
      await attachClient.query('BEGIN');
      await attachClient.query(
        `UPDATE payments SET payment_intent_id = $1 WHERE id = $2 AND payment_intent_id IS NULL`,
        [intent.id, paymentId]
      );
      await auditService.logEvent(attachClient, {
        eventType:  'payment.intent_attached',
        entityType: 'payment',
        entityId:   paymentId,
        auctionId,
        paymentId,
        actorId:    buyerUserId,
        metadata: { payment_intent_id: intent.id, combined_invoice_id: combinedInvoiceId, idempotency_key: stripeKey },
      });
      await attachClient.query('COMMIT');
    } catch (attachErr) {
      await attachClient.query('ROLLBACK').catch(() => {});
      console.error('[combined] intent_attached UPDATE failed — payment may be stuck transitional', { paymentId, intent_id: intent.id, error: attachErr.message });
      throw attachErr;
    } finally {
      attachClient.release();
    }

    if (intent.status === 'succeeded') {
      return { status: 'succeeded', paymentId, intentId: intent.id };
    }
    // requires_action / processing — not a decline. Leave the row pending; the
    // webhook (payment_intent.succeeded) will settle it later.
    return { status: 'pending', paymentId, intentId: intent.id };
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

    // Phase 2: itemized buyer payment receipt (email + attached invoice PDF).
    // Fire-and-forget, best-effort — a delivery problem must never affect the
    // already-committed payment.
    require('./receiptService').sendPaymentReceipt(paymentId)
      .catch(err => console.error('[receipt] dispatch failed:', err.message));

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

  async processRefund(adminId, paymentId, refundAmountCents, idempotencyKey) {
    // Admin-only refund logic.
    //
    // Sub-batch 2 reorder (C-3 + M-1 + C-4 + I.3 look-back):
    //   tx1: admin check, SELECT FOR UPDATE, 30s look-back guard, cumulative
    //        overspend guard, status guard, audit 'payment.refund_started', COMMIT
    //   --- locks released BEFORE Stripe call ---
    //   stripe.refunds.create({...}, { idempotencyKey: refund_key })
    //   on Stripe failure: separate tx writes 'payment.refund_failed' audit, throws
    //   tx2: UPDATE payments status + refunded_at + stripe_refund_id +
    //        refunded_amount_cents (cumulative), audit 'payment.refunded', COMMIT
    //
    // Valid transitions:
    //   paid              → refunded               (full refund)
    //   paid              → partially_refunded     (partial)
    //   partially_refunded → partially_refunded    (subsequent partials)
    //   partially_refunded → refunded              (final partial completes total)
    //
    // I.3 30s look-back: rejects a duplicate refund attempt within 30 seconds
    // of a prior payment.refund_started that has no subsequent payment.refunded
    // or payment.refund_failed. Closes the narrow concurrent-admin-click window.
    //
    // C-4 overspend: validates refundAmountCents + refunded_amount_cents <=
    // amount_cents BEFORE the Stripe call. Defense-in-depth alongside the DB
    // CHECK constraint chk_refunded_amount_bounded (migration 047).
    //
    // Seeded path (payment_intent_id IS NULL): the Stripe call is skipped;
    // DB state is still updated so the seeded test data refund flow works.
    let payment, refundStartedAt;
    const refundKey = idempotencyKey || `${paymentId}:${refundAmountCents}:${Date.now()}`;

    // ── tx1: validate, guard, mark started ────────────────────────────────
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdminRole(client, adminId);

      const paymentRes = await client.query(
        `SELECT status, amount_cents, refunded_amount_cents, payment_intent_id, lot_id, auction_id
           FROM payments WHERE id = $1 FOR UPDATE`,
        [paymentId]
      );
      if (!paymentRes.rows[0]) {
        throw new Error('Payment not found');
      }
      payment = paymentRes.rows[0];

      // Status guard: only paid or partially_refunded can be refunded further.
      if (payment.status !== 'paid' && payment.status !== 'partially_refunded') {
        throw new Error(`Cannot refund ${payment.status} payment. Only paid or partially_refunded payments can be refunded.`);
      }

      if (refundAmountCents <= 0) {
        throw new Error('Refund amount must be greater than 0');
      }

      // C-4 cumulative overspend check. The DB CHECK constraint backs this up
      // at the database level, but we want a clean application error rather
      // than a constraint violation.
      const priorRefunded = payment.refunded_amount_cents || 0;
      if (priorRefunded + refundAmountCents > payment.amount_cents) {
        throw new Error(`Refund total would exceed payment amount (already refunded ${priorRefunded} of ${payment.amount_cents}; requested additional ${refundAmountCents})`);
      }

      // I.3 30s look-back guard. Catches concurrent admin-click race before
      // any Stripe call. NB: the SELECT FOR UPDATE above already serializes
      // refund attempts for the same payment id; this is defense-in-depth for
      // any caller that doesn't take the row lock (e.g., direct SQL scripts).
      const inFlight = await client.query(
        `SELECT 1 FROM audit_log a
          WHERE a.payment_id = $1
            AND a.event_type = 'payment.refund_started'
            AND a.created_at > now() - interval '30 seconds'
            AND NOT EXISTS (
              SELECT 1 FROM audit_log a2
               WHERE a2.payment_id = $1
                 AND a2.event_type IN ('payment.refunded', 'payment.refund_failed')
                 AND a2.created_at > a.created_at
            )
          LIMIT 1`,
        [paymentId]
      );
      if (inFlight.rows[0]) {
        const err = new Error('Refund already in progress for this payment');
        err.code = 'REFUND_IN_PROGRESS';
        throw err;
      }

      refundStartedAt = new Date();
      await auditService.logEvent(client, {
        eventType:  'payment.refund_started',
        entityType: 'payment',
        entityId:   paymentId,
        auctionId:  payment.auction_id,
        lotId:      payment.lot_id,
        paymentId,
        actorId:    adminId,
        metadata: {
          requested_amount_cents:   refundAmountCents,
          prior_refunded_cents:     priorRefunded,
          payment_amount_cents:     payment.amount_cents,
          payment_intent_id:        payment.payment_intent_id,
          stripe_idempotency_key:   refundKey,
        }
      });

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw error;
    }
    client.release();

    // ── External Stripe call OUTSIDE any DB transaction ───────────────────
    let stripeRefundId = null;
    if (payment.payment_intent_id) {
      try {
        const stripe = getStripe();
        const stripeRefund = await stripe.refunds.create({
          payment_intent: payment.payment_intent_id,
          amount:         refundAmountCents,
        }, { idempotencyKey: refundKey });
        stripeRefundId = stripeRefund.id;
      } catch (stripeErr) {
        // Write a failure audit so the look-back window doesn't keep blocking
        // legitimate retries. The payment row stays in its original status.
        const failClient = await db.connect();
        try {
          await failClient.query('BEGIN');
          await auditService.logEvent(failClient, {
            eventType:  'payment.refund_failed',
            entityType: 'payment',
            entityId:   paymentId,
            auctionId:  payment.auction_id,
            lotId:      payment.lot_id,
            paymentId,
            actorId:    adminId,
            metadata: {
              source:                  'stripe.refunds.create',
              stripe_error:            stripeErr.message,
              requested_amount_cents:  refundAmountCents,
              stripe_idempotency_key:  refundKey,
            }
          });
          await failClient.query('COMMIT');
        } catch (auditErr) {
          await failClient.query('ROLLBACK').catch(() => {});
          console.error('[refund] failed to write refund_failed audit', {
            paymentId, audit_error: auditErr.message, stripe_error: stripeErr.message,
          });
        } finally {
          failClient.release();
        }
        console.error('[refund] Stripe refund API failed:', {
          paymentId,
          payment_intent_id: payment.payment_intent_id,
          amount_cents:      refundAmountCents,
          error:             stripeErr.message,
        });
        throw new Error(`Stripe refund failed: ${stripeErr.message}`);
      }
    } else {
      console.warn('[refund] No payment_intent_id — Stripe refund skipped (seeded/test payment)', { paymentId });
    }

    // ── tx2: persist DB state ─────────────────────────────────────────────
    const newRefundedTotal = (payment.refunded_amount_cents || 0) + refundAmountCents;
    const isFullRefund     = newRefundedTotal >= payment.amount_cents;
    const newStatus        = isFullRefund ? 'refunded' : 'partially_refunded';
    const refundedAt       = new Date();

    const persistClient = await db.connect();
    try {
      await persistClient.query('BEGIN');
      await persistClient.query(
        `UPDATE payments
            SET status                = $1,
                refunded_at           = COALESCE(refunded_at, $2),
                stripe_refund_id      = COALESCE($3, stripe_refund_id),
                refunded_amount_cents = $4
          WHERE id = $5`,
        [newStatus, refundedAt, stripeRefundId, newRefundedTotal, paymentId]
      );
      await auditService.logEvent(persistClient, {
        eventType:  'payment.refunded',
        entityType: 'payment',
        entityId:   paymentId,
        auctionId:  payment.auction_id,
        lotId:      payment.lot_id,
        paymentId,
        actorId:    adminId,
        metadata: {
          refund_amount_cents:      refundAmountCents,
          stripe_refund_id:         stripeRefundId,
          status:                   newStatus,
          prior_refunded_cents:     payment.refunded_amount_cents || 0,
          new_refunded_total_cents: newRefundedTotal,
          stripe_idempotency_key:   refundKey,
        }
      });
      await persistClient.query('COMMIT');
    } catch (persistErr) {
      await persistClient.query('ROLLBACK').catch(() => {});
      // Stripe already issued the refund (or seeded path produced no Stripe
      // side effect). The DB is now out of sync. Log loudly with all the
      // recovery info so an operator can reconcile manually.
      console.error('[refund] Stripe succeeded but DB UPDATE failed — MANUAL RECONCILIATION REQUIRED', {
        paymentId,
        stripe_refund_id:         stripeRefundId,
        refund_amount_cents:      refundAmountCents,
        new_refunded_total_cents: newRefundedTotal,
        new_status:               newStatus,
        error:                    persistErr.message,
      });
      throw persistErr;
    } finally {
      persistClient.release();
    }

    return {
      payment_id:          paymentId,
      status:              newStatus,
      refund_amount_cents: refundAmountCents,
      stripe_refund_id:    stripeRefundId,
      refunded_at:         refundedAt,
      refunded_amount_cents_total: newRefundedTotal,
    };
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
    //
    // Race 1 mitigation (Sub-batch 2 audit): if two rows have the same intent_id
    // (a concurrent-create recovery scenario where a failed row had its intent
    // attached and a new pending row was then created with the same Stripe
    // idempotency key), prefer the still-actionable pending row. Without this
    // ordering, the LIMIT 1 could pick the failed row arbitrarily and recordPayment-
    // Success would then attempt failed->paid recovery on the wrong row, only to
    // hit the partial unique index later when the real pending row also tries
    // to transition.
    const paymentRes = await db.query(
      `SELECT id, lot_id, auction_id, buyer_user_id FROM payments
        WHERE payment_intent_id = $1
        ORDER BY CASE status
                   WHEN 'pending' THEN 0
                   WHEN 'paid'    THEN 1
                   ELSE 2
                 END,
                 created_at DESC
        LIMIT 1`,
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
    const payment = paymentRes.rows[0];

    // Design C combined (null-lot) branch. Route to combinedInvoiceService.settleCombined
    // and RETURN before the per-lot recordPaymentSuccess path. Idempotent: settleCombined
    // is a no-op if the header is already paid (the synchronous settle may have run first).
    // Lazy require avoids a circular import.
    const combinedSvc = require('./combinedInvoiceService');
    if (combinedSvc.isCombinedPayment(payment)) {
      const bai = (await db.query(
        `SELECT id FROM buyer_auction_invoices
          WHERE stripe_payment_intent_id = $1 OR payment_id = $2
             OR (auction_id = $3 AND buyer_user_id = $4)
          LIMIT 1`,
        [intent.id, payment.id, payment.auction_id, payment.buyer_user_id]
      )).rows[0];
      if (bai) {
        await combinedSvc.settleCombined(bai.id, intent.id, payment.id);
        console.log(`[webhook] payment_intent.succeeded → combined invoice ${bai.id} settled (intent=${intent.id})`);
      } else {
        // Combined payment succeeded but no header row could be located. Mark the
        // payment paid so it does not sit pending; operator can reconcile the header.
        await db.query(
          `UPDATE payments SET status = 'paid', charged_at = now(), last_attempted_at = now() WHERE id = $1 AND status <> 'paid'`,
          [payment.id]
        );
        console.warn(`[webhook] combined payment ${payment.id} succeeded but no buyer_auction_invoices header found (intent=${intent.id})`);
      }
      return;
    }

    const paymentId = payment.id;
    // recordPaymentSuccess handles idempotency (already-paid), invoice creation,
    // pickup assignment, audit logging, and downstream notification events.
    await this.recordPaymentSuccess(paymentId, intent.id);
    console.log(`[webhook] payment_intent.succeeded → payment ${paymentId} marked paid (intent=${intent.id})`);
  }

  async _handlePaymentIntentFailed(intent) {
    const paymentRes = await db.query(
      `SELECT id, lot_id, auction_id, buyer_user_id FROM payments WHERE payment_intent_id = $1 LIMIT 1`,
      [intent.id]
    );
    if (!paymentRes.rows[0]) {
      // No DB row for an intent that failed — nothing to record. Acknowledge
      // without throwing; this is not a settlement-integrity issue.
      console.warn(`[webhook] payment_intent.payment_failed — no payment row for intent ${intent.id}`);
      return;
    }
    const payment = paymentRes.rows[0];

    // Design C combined (null-lot) branch: flip the payment failed + route the
    // header to payment_required via combinedInvoiceService.markFailed, then RETURN
    // before the per-lot recordPaymentFailure path. Idempotent (markFailed never
    // downgrades a paid/void header). Lazy require avoids a circular import.
    const combinedSvc = require('./combinedInvoiceService');
    if (combinedSvc.isCombinedPayment(payment)) {
      await db.query(
        `UPDATE payments SET status = 'failed', last_attempted_at = now() WHERE id = $1 AND status <> 'paid'`,
        [payment.id]
      );
      const bai = (await db.query(
        `SELECT id FROM buyer_auction_invoices
          WHERE stripe_payment_intent_id = $1 OR payment_id = $2
             OR (auction_id = $3 AND buyer_user_id = $4)
          LIMIT 1`,
        [intent.id, payment.id, payment.auction_id, payment.buyer_user_id]
      )).rows[0];
      if (bai) await combinedSvc.markFailed(bai.id, 'payment_intent.payment_failed');
      console.log(`[webhook] payment_intent.payment_failed → combined payment ${payment.id} failed, header payment_required`);
      return;
    }

    const paymentId = payment.id;
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
        `SELECT id, status, amount_cents, refunded_amount_cents, lot_id, auction_id, stripe_refund_id
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

      // Stripe-authoritative cumulative refund amount.
      const amountRefunded = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;

      // Echo of our own processRefund — already recorded. Reconcile
      // refunded_amount_cents anyway if Stripe's number is higher (handles a
      // race where processRefund's tx2 hadn't committed when the echo arrived).
      if (payment.stripe_refund_id && latestRefundId && payment.stripe_refund_id === latestRefundId
          && (payment.refunded_amount_cents || 0) >= amountRefunded) {
        await client.query('ROLLBACK');
        console.log(`[webhook] charge.refunded — payment ${payment.id} already reconciled (refund=${latestRefundId})`);
        return;
      }

      const isFull      = amountRefunded >= payment.amount_cents;
      const newStatus   = isFull ? 'refunded' : 'partially_refunded';
      const priorStatus = payment.status;
      const priorRefunded = payment.refunded_amount_cents || 0;

      await client.query(
        `UPDATE payments
            SET status                = $1,
                refunded_at           = COALESCE(refunded_at, now()),
                stripe_refund_id      = COALESCE($2, stripe_refund_id),
                refunded_amount_cents = GREATEST(refunded_amount_cents, $3)
          WHERE id = $4`,
        [newStatus, latestRefundId, amountRefunded, payment.id]
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
          source:                   'stripe_webhook.charge.refunded',
          stripe_charge_id:         charge.id,
          stripe_refund_id:         latestRefundId,
          amount_refunded_cents:    amountRefunded,
          prior_status:             priorStatus,
          new_status:               newStatus,
          prior_refunded_cents:     priorRefunded,
          new_refunded_total_cents: Math.max(priorRefunded, amountRefunded),
        }
      });
      await client.query('COMMIT');
      console.log(`[webhook] charge.refunded → payment ${payment.id} reconciled (status=${newStatus}, refund=${latestRefundId}, total_refunded=${Math.max(priorRefunded, amountRefunded)})`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = new PaymentService();
