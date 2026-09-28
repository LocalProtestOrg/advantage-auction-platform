// PaymentService implementation
const db             = require('../db');
const auditService   = require('./auditService');
const invoiceService = require('./invoiceService');
const billingTerms   = require('./billingTermsService');
const taxService     = require('./taxCalculationService');
const Stripe         = require('stripe');
const { isLiveMode, eventMatchesMode } = require('../lib/stripeMode');
const { isPrepaid, PREPAID_MESSAGE } = require('./cardService');

// Pin Stripe API version. Pin target matches the SDK 22.0.2 default; pinning
// locks the contract against silent account-level version bumps in the Stripe
// Dashboard. Upgrade by editing this constant alongside SDK upgrades.
const STRIPE_API_VERSION = '2026-03-25.dahlia';

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

// A buyer-safe payment error: `message` is shown to the buyer as-is; `status` is the HTTP status.
function paymentUserError(code, message, status = 409) {
  const e = new Error(message);
  e.code = code; e.status = status; e.userFacing = true;
  return e;
}

// On-session auction PaymentIntents are created with MANUAL confirmation and card only: only this server
// (secret key) can confirm them, after it has checked the card (debit/credit only, prepaid refused). A
// browser holding the client secret can complete a 3-D Secure step but can never confirm with a card the
// server has not checked.
const ON_SESSION_INTENT_PARAMS = Object.freeze({ payment_method_types: ['card'], confirmation_method: 'manual' });

// Open PaymentIntent states that can still be completed by the buyer.
const REUSABLE_INTENT_STATES = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);
// A still-open intent younger than this is reused on retry (same amount, same tax calculation); an older
// one is canceled and replaced so the tax calculation is never stale.
const INTENT_REUSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Is a provider error a card problem (decline / authentication) rather than a configuration or lookup
// problem? Card problems are the buyer's to fix with another card; the rest are ours.
function isCardError(err) {
  return !!(err && (err.type === 'StripeCardError' || err.code === 'card_declined' || err.code === 'authentication_required'));
}
// Transient transport errors: the request may or may not have reached the provider.
function isTransientProviderError(err) {
  return !!(err && (err.type === 'StripeConnectionError' || err.type === 'StripeAPIError' || err.type === 'StripeRateLimitError'));
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

    // Retry safety: a buyer retrying payment for this lot must never end up with two open PaymentIntents
    // (both payable) or hit the one-active-payment unique index. An open intent is reused when it is
    // still completable (recent, same amount, server-confirmed); otherwise it is canceled first.
    const reuse = await this._resolveOpenIntentsForRetry({ userId, auctionId, lotId });
    if (reuse) {
      const r = reuse.row;
      const tax = r.sales_tax_cents || 0;
      return {
        id:                 r.id,
        lot_id:             lotId,
        auction_id:         auctionId,
        amount_cents:       r.amount_cents,
        taxable_base_cents: (r.taxable_base_cents != null ? r.taxable_base_cents : r.amount_cents - tax),
        sales_tax_cents:    tax,
        status:             'pending',
        created_at:         r.created_at,
        payment_intent_id:  reuse.intent.id,
        reused:             true,
      };
    }

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

      // Authoritative charge = hammer + buyer premium for THIS lot (individual → fixed 18%;
      // professional → their configured rate). The PaymentIntent amount must equal the invoice total.
      const terms = await billingTerms.resolveEffectiveTerms(auctionId, client);
      const chargeCents = lot.winning_amount_cents
        + billingTerms.lotBuyerPremiumCents(lot.winning_amount_cents, terms.buyer_premium_bps);

      // Insert pending payment row WITHOUT intent_id. The intent will be
      // attached in tx2 after the Stripe call succeeds. The partial unique
      // index idx_payments_unique_active enforces single-pending per (lot,
      // buyer) at commit time.
      const inserted = await client.query(
        `INSERT INTO payments (auction_id, lot_id, buyer_user_id, amount_cents, status, payment_intent_id)
         VALUES ($1, $2, $3, $4, 'pending', NULL)
         RETURNING id, amount_cents, created_at`,
        [auctionId, lotId, userId, chargeCents]
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
      if (error && error.code === '23505') {
        // Another attempt for this lot is being started right now (the one-active-payment index).
        throw paymentUserError('PAYMENT_IN_PROGRESS', 'A payment for this lot is already being started. Please wait a moment and try again.');
      }
      throw error;
    } finally {
      client.release();
    }

    // ── Sales tax (flag-gated) ─────────────────────────────────────────────
    // Grow the charge to (hammer + buyer premium) + tax before creating the intent, using the
    // BUYER's address for jurisdiction. Fail-safe: if tax is required but cannot be produced, fail
    // the still-pending row and surface a recoverable error — never create an untaxed intent.
    const taxableBaseCents = amountCents;
    try {
      amountCents = await this._applyTaxToPayment({ paymentId, buyerUserId: userId, taxableBaseCents });
    } catch (taxErr) {
      await this._failPendingPayment(paymentId, 'tax:' + (taxErr.code || 'error'));
      throw taxErr;
    }
    const salesTaxCents = amountCents - taxableBaseCents;

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
        ...ON_SESSION_INTENT_PARAMS,
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
      id:                 paymentId,
      lot_id:             lotId,
      auction_id:         auctionId,
      amount_cents:       amountCents,          // hammer + buyer premium + sales tax (what will be charged)
      taxable_base_cents: taxableBaseCents,     // hammer + buyer premium
      sales_tax_cents:    salesTaxCents,        // Stripe Tax (0 when the feature is disabled)
      status:             'pending',
      created_at:         paymentCreatedAt,
      payment_intent_id:  intent.id,
      // No client secret here: payment.html loads the payment by id and the server confirms it.
    };
  }

  // ── Retry safety for on-session payments ──────────────────────────────────────────────────────
  // Inspect this buyer's still-pending payment rows (per lot, or the combined lot_id NULL row) that already
  // carry a PaymentIntent. Returns { row, intent } for ONE reusable intent, or null. Every other open intent
  // is canceled and its row retired, so two open PaymentIntents can never both be paid. Throws a buyer-safe
  // error when the payment already succeeded or is still processing.
  async _resolveOpenIntentsForRetry({ userId, auctionId, lotId }) {
    const res = lotId
      ? await db.query(
        `SELECT * FROM payments
          WHERE lot_id = $1 AND buyer_user_id = $2 AND status = 'pending' AND payment_intent_id IS NOT NULL
          ORDER BY created_at DESC`, [lotId, userId])
      : await db.query(
        `SELECT * FROM payments
          WHERE auction_id = $1 AND buyer_user_id = $2 AND lot_id IS NULL AND status = 'pending' AND payment_intent_id IS NOT NULL
          ORDER BY created_at DESC`, [auctionId, userId]);
    const rows = (res && res.rows) || [];
    if (!rows.length) return null;
    const stripe = getStripe();
    let reuse = null;
    for (const row of rows) {
      let intent;
      try {
        intent = await stripe.paymentIntents.retrieve(row.payment_intent_id);
      } catch (e) {
        if (isTransientProviderError(e)) throw paymentUserError('PAYMENTS_UNAVAILABLE', 'Payments are temporarily unavailable. Please try again shortly.', 503);
        // Unknown under the current keys (e.g. a TEST intent after the switch to LIVE): it can never be
        // paid, so retire the row and start fresh.
        await this._retireSupersededPayment(row, userId, 'intent_unavailable');
        continue;
      }
      if (intent.status === 'succeeded') {
        await this._handlePaymentIntentSucceeded(intent).catch((e) => console.error('[payment] finalize on retry failed', { paymentId: row.id, error: e.message }));
        throw paymentUserError('ALREADY_PAID', 'This payment has already been completed.');
      }
      if (intent.status === 'processing' || intent.status === 'requires_capture') {
        throw paymentUserError('PAYMENT_PROCESSING', 'Your payment is being processed. Please check back in a few minutes.');
      }
      const age = Date.now() - new Date(row.created_at || 0).getTime();
      if (!reuse && REUSABLE_INTENT_STATES.has(intent.status) && intent.confirmation_method === 'manual'
          && intent.amount === row.amount_cents && age < INTENT_REUSE_MAX_AGE_MS) {
        reuse = { row, intent };
        continue;
      }
      if (intent.status !== 'canceled') {
        try {
          await stripe.paymentIntents.cancel(intent.id, { cancellation_reason: 'duplicate' });
        } catch (e) {
          // It may have completed in the meantime: never retire a real payment.
          const again = await stripe.paymentIntents.retrieve(intent.id).catch(() => null);
          if (again && again.status === 'succeeded') {
            await this._handlePaymentIntentSucceeded(again).catch(() => {});
            throw paymentUserError('ALREADY_PAID', 'This payment has already been completed.');
          }
          if (!again || again.status !== 'canceled') {
            console.error('[payment] could not cancel superseded intent', { paymentId: row.id, intent_id: intent.id, error: e.message });
            throw paymentUserError('PAYMENT_IN_PROGRESS', 'A payment for this invoice is already in progress. Please wait a moment and try again.');
          }
        }
      }
      await this._retireSupersededPayment(row, userId, 'superseded_on_retry');
    }
    return reuse;
  }

  // Retire a still-pending payment row whose intent was canceled or is unusable (pending → failed; the row
  // and its intent id are kept for history).
  async _retireSupersededPayment(row, actorId, reason) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE payments SET status = 'failed', last_attempted_at = now() WHERE id = $1 AND status = 'pending'`,
        [row.id]);
      await auditService.logEvent(client, {
        eventType: 'payment.intent_superseded', entityType: 'payment', entityId: row.id,
        auctionId: row.auction_id, lotId: row.lot_id, paymentId: row.id, actorId,
        metadata: { payment_intent_id: row.payment_intent_id, reason },
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
  // Only CURRENT-mode records are used: a TEST customer / card is never charged under LIVE keys (the buyer
  // is treated as having no card, so the invoice goes to payment_required and they pay on-session).
  async _loadCombinedChargeContext(buyerUserId) {
    const live = isLiveMode();
    const u0 = (await db.query('SELECT stripe_customer_id, stripe_customer_livemode FROM users WHERE id = $1', [buyerUserId])).rows[0] || {};
    const u = ((u0.stripe_customer_livemode === true) === live) ? u0 : {};
    const cv = u.stripe_customer_id ? (await db.query(
      `SELECT stripe_payment_method_id
         FROM card_verifications
        WHERE user_id = $1 AND status = 'verified' AND stripe_payment_method_id IS NOT NULL AND livemode = $2
        ORDER BY attempted_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [buyerUserId, live]
    )).rows[0] : null;
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

    // ── Sales tax (flag-gated) for the off-session auto-charge ─────────────
    // Buyer address must already be on file (this is a background charge, no interactive prompt).
    // If it isn't, skip → the caller marks the invoice payment_required and reminds the buyer to
    // complete their tax address + pay on-session (where the address is collected). A calc failure
    // is a transient 'failed' so the settlement worker retries later — never an untaxed off-session charge.
    if (taxService.taxEnabled()) {
      try {
        const bai = (await db.query(
          `SELECT hammer_cents, buyer_premium_cents FROM buyer_auction_invoices WHERE id = $1`,
          [combinedInvoiceId])).rows[0] || {};
        const taxableBaseCents = (bai.hammer_cents || 0) + (bai.buyer_premium_cents || 0);
        amountCents = await this._applyTaxToPayment({ paymentId, buyerUserId, taxableBaseCents, currentAmountCents: amountCents });
      } catch (taxErr) {
        await this._failPendingPayment(paymentId, 'tax:' + (taxErr.code || 'error'));
        if (taxErr.code === 'BUYER_TAX_ADDRESS_REQUIRED') return { skipped: 'tax_address_required', paymentId };
        return { status: 'failed', paymentId, reason: 'tax_' + String(taxErr.code || 'error').toLowerCase() };
      }
    }

    // 3. Stripe off-session confirm. External call OUTSIDE any DB transaction.
    const stripeKey = idempotencyKey || ('combined:' + combinedInvoiceId);
    let intent;
    const createParams = {
      amount:         amountCents,
      currency:       'usd',
      customer:       resolved.customerId,
      payment_method: resolved.paymentMethodId,
      payment_method_types: ['card'],
      off_session:    true,
      confirm:        true,
      metadata: { combined_invoice_id: combinedInvoiceId, auction_id: auctionId, buyer_user_id: buyerUserId, payment_id: paymentId },
    };
    try {
      const stripe = getStripe();
      try {
        intent = await stripe.paymentIntents.create(createParams, { timeout: 15000, idempotencyKey: stripeKey });
      } catch (firstErr) {
        // A transport error leaves it unknown whether the charge was made. Retry ONCE with the SAME
        // idempotency key: the provider returns the original result instead of charging twice.
        if (!isTransientProviderError(firstErr)) throw firstErr;
        intent = await stripe.paymentIntents.create(createParams, { timeout: 15000, idempotencyKey: stripeKey });
      }
    } catch (stripeErr) {
      // Off-session declines (card_declined) and authentication_required surface as
      // StripeCardError. Every other failure (invalid/missing customer or payment method, an id from the
      // other mode after the switch to LIVE keys, a persistent outage) is ALSO returned as a failed charge,
      // never rethrown: the caller routes the header to payment_required + Reminder #1 so the buyer can pay
      // on-session. The buyer email is neutral (it never states the reason).
      const cardProblem = isCardError(stripeErr);
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
      if (cardProblem) return { status: 'failed', paymentId, reason: stripeErr.code || stripeErr.message };
      console.error('[combined] off-session charge could not be attempted — routing to payment_required', {
        paymentId, combinedInvoiceId, type: stripeErr && stripeErr.type, code: stripeErr && stripeErr.code, error: stripeErr && stripeErr.message,
      });
      return { status: 'failed', paymentId, reason: 'charge_error:' + ((stripeErr && (stripeErr.code || stripeErr.type)) || 'unknown') };
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

  // ── Design C: combined ON-SESSION charge (buyer clicks "Pay Now" on an unpaid
  // combined invoice) ─────────────────────────────────────────────────────────
  // Creates ONE PaymentIntent for the whole combined total (lot_id NULL) with MANUAL confirmation; payment.html
  // loads it by payment id and the server confirms it after checking the card (confirmOnSessionPayment). The
  // webhook's null-lot branch (or the synchronous finalize) settles the combined header + per-lot invoices.
  // Mirrors createPaymentIntent's tx1/Stripe/tx2 idempotency discipline. Returns
  // { payment_id, amount_cents, taxable_base_cents, sales_tax_cents } (no client secret).
  async createCombinedPaymentIntent(userId, combinedInvoiceId, idempotencyKey) {
    let paymentId, amountCents, auctionId, taxableBaseCents;

    // Ownership pre-check (read-only) so retry handling only ever touches the owner's own payments.
    const pre = (await db.query(
      `SELECT auction_id, buyer_user_id, status FROM buyer_auction_invoices WHERE id = $1`, [combinedInvoiceId])).rows[0];
    if (!pre) throw paymentUserError('INVOICE_NOT_FOUND', 'Invoice not found.', 404);
    if (pre.buyer_user_id !== userId) throw paymentUserError('NOT_INVOICE_OWNER', 'Only the invoice owner can pay this invoice.', 403);
    if (pre.status === 'paid' || pre.status === 'void') throw paymentUserError('INVOICE_CLOSED', `This invoice is already ${pre.status}.`);

    // Retry safety (see createPaymentIntent): reuse or cancel an open combined intent first.
    const reuse = await this._resolveOpenIntentsForRetry({ userId, auctionId: pre.auction_id, lotId: null });
    if (reuse) {
      const r = reuse.row;
      const taxC = r.sales_tax_cents || 0;
      return {
        payment_id: r.id,
        amount_cents: r.amount_cents,
        taxable_base_cents: (r.taxable_base_cents != null ? r.taxable_base_cents : r.amount_cents - taxC),
        sales_tax_cents: taxC,
        reused: true,
      };
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const baiRes = await client.query(
        `SELECT id, auction_id, buyer_user_id, hammer_cents, buyer_premium_cents, total_cents, status
           FROM buyer_auction_invoices WHERE id = $1 FOR UPDATE`,
        [combinedInvoiceId]
      );
      const bai = baiRes.rows[0];
      if (!bai) throw paymentUserError('INVOICE_NOT_FOUND', 'Invoice not found.', 404);
      if (bai.buyer_user_id !== userId) throw paymentUserError('NOT_INVOICE_OWNER', 'Only the invoice owner can pay this invoice.', 403);
      if (bai.status === 'paid' || bai.status === 'void') throw paymentUserError('INVOICE_CLOSED', `This invoice is already ${bai.status}.`);
      if (!bai.total_cents || bai.total_cents <= 0) throw paymentUserError('NOTHING_TO_PAY', 'This invoice has no payable amount.', 422);
      auctionId = bai.auction_id;
      // Taxable base = hammer + buyer premium (Owner policy; excludes shipping/credits, which are $0 at V1.0).
      taxableBaseCents = (bai.hammer_cents || 0) + (bai.buyer_premium_cents || 0);

      // Retire an orphaned stale pending (no intent, >60s) so a fresh attempt can proceed.
      await client.query(
        `UPDATE payments SET status = 'failed', last_attempted_at = now()
          WHERE auction_id = $1 AND buyer_user_id = $2 AND lot_id IS NULL AND status = 'pending'
            AND payment_intent_id IS NULL AND created_at < now() - interval '60 seconds'`,
        [auctionId, userId]
      );

      // Insert pending combined payment (lot_id NULL). idx_payments_combined_active
      // blocks a duplicate active combined charge at commit → handled below.
      const inserted = await client.query(
        `INSERT INTO payments (auction_id, lot_id, buyer_user_id, amount_cents, status, payment_intent_id)
         VALUES ($1, NULL, $2, $3, 'pending', NULL)
         RETURNING id, amount_cents`,
        [auctionId, userId, bai.total_cents]
      );
      paymentId   = inserted.rows[0].id;
      amountCents = inserted.rows[0].amount_cents;
      await auditService.logEvent(client, {
        eventType: 'payment.created', entityType: 'payment', entityId: paymentId,
        auctionId, paymentId, actorId: userId,
        metadata: { amount_cents: amountCents, status: 'pending', combined: true, on_session: true, combined_invoice_id: combinedInvoiceId },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      if (error && error.code === '23505') {
        // Another attempt is being started right now, or a combined payment already exists (paid/refunded).
        // Never surface the raw database error to the buyer.
        throw paymentUserError('PAYMENT_IN_PROGRESS', 'A payment for this invoice is already in progress. Please wait a moment and try again.');
      }
      throw error;
    }
    client.release();

    // ── Sales tax (flag-gated) — add tax on the (hammer + buyer premium) base before the intent. ──
    try {
      amountCents = await this._applyTaxToPayment({ paymentId, buyerUserId: userId, taxableBaseCents, currentAmountCents: amountCents });
    } catch (taxErr) {
      await this._failPendingPayment(paymentId, 'tax:' + (taxErr.code || 'error'));
      throw taxErr;
    }

    const stripeKey = idempotencyKey || ('combined-onsession:' + combinedInvoiceId);
    let intent;
    try {
      intent = await getStripe().paymentIntents.create({
        amount: amountCents, currency: 'usd',
        ...ON_SESSION_INTENT_PARAMS,
        metadata: { combined_invoice_id: combinedInvoiceId, auction_id: auctionId, buyer_user_id: userId, payment_id: paymentId },
      }, { timeout: 15000, idempotencyKey: stripeKey });
    } catch (stripeErr) {
      const fc = await db.connect();
      try {
        await fc.query(`UPDATE payments SET status = 'failed', last_attempted_at = now() WHERE id = $1 AND status = 'pending' AND payment_intent_id IS NULL`, [paymentId]);
      } catch (e) { /* best-effort slot release */ } finally { fc.release(); }
      throw stripeErr;
    }
    await db.query(`UPDATE payments SET payment_intent_id = $1 WHERE id = $2 AND payment_intent_id IS NULL`, [intent.id, paymentId]);
    return {
      payment_id: paymentId,
      amount_cents: amountCents,                                      // base + sales tax (what will be charged)
      taxable_base_cents: taxableBaseCents,
      sales_tax_cents: amountCents - taxableBaseCents,
    };
  }

  // ── On-session checkout (payment.html) ──────────────────────────────────────────────────────────
  // Load a pending payment for its OWNER only. Returns display data (never a client secret) or throws a
  // buyer-safe error. Used by GET /api/payments/checkout/:paymentId.
  async getCheckout(userId, paymentId) {
    const p = (await db.query(
      `SELECT p.id, p.auction_id, p.lot_id, p.buyer_user_id, p.status, p.amount_cents, p.taxable_base_cents,
              p.sales_tax_cents, p.payment_intent_id, l.title AS lot_title, l.lot_number, a.title AS auction_title
         FROM payments p
         LEFT JOIN lots l ON l.id = p.lot_id
         LEFT JOIN auctions a ON a.id = p.auction_id
        WHERE p.id = $1`, [paymentId])).rows[0];
    // Same answer for "missing" and "someone else's", so ids cannot be probed.
    if (!p || p.buyer_user_id !== userId) throw paymentUserError('PAYMENT_NOT_FOUND', 'Payment not found.', 404);
    const tax = p.sales_tax_cents || 0;
    return {
      payment_id: p.id,
      kind: p.lot_id ? 'lot' : 'combined',
      status: p.status,
      payable: p.status === 'pending' && !!p.payment_intent_id,
      amount_cents: p.amount_cents,
      taxable_base_cents: p.taxable_base_cents != null ? p.taxable_base_cents : p.amount_cents - tax,
      sales_tax_cents: tax,
      lot_id: p.lot_id,
      lot_title: p.lot_title || null,
      lot_number: p.lot_number || null,
      auction_id: p.auction_id,
      auction_title: p.auction_title || null,
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || '',
    };
  }

  // Server-side confirmation of an on-session payment. The browser only creates a PaymentMethod (card
  // details go straight to the provider) and posts its id; this method:
  //   1. verifies the buyer owns the pending payment and the intent belongs to it;
  //   2. refuses a prepaid card (422, PREPAID_MESSAGE) — debit and credit only;
  //   3. confirms the intent with the secret key;
  //   4. returns { status:'requires_action', client_secret } for 3-D Secure (the browser completes the
  //      step, then calls again WITHOUT a payment method so the server confirms the result), or finalizes a
  //      success synchronously (idempotent with the webhook).
  async confirmOnSessionPayment(userId, paymentId, paymentMethodId) {
    const p = (await db.query(
      `SELECT id, buyer_user_id, status, amount_cents, payment_intent_id, lot_id, auction_id FROM payments WHERE id = $1`,
      [paymentId])).rows[0];
    if (!p || p.buyer_user_id !== userId) throw paymentUserError('PAYMENT_NOT_FOUND', 'Payment not found.', 404);
    if (p.status === 'paid') return { status: 'succeeded', payment_id: p.id, already_paid: true };
    if (p.status !== 'pending' || !p.payment_intent_id) {
      throw paymentUserError('PAYMENT_NOT_OPEN', 'This payment is no longer open. Please return to your invoices and start again.');
    }
    const stripe = getStripe();
    let intent = await stripe.paymentIntents.retrieve(p.payment_intent_id);
    const md = intent.metadata || {};
    if ((md.payment_id && md.payment_id !== p.id) || intent.amount !== p.amount_cents) {
      console.error('[payment] confirm refused — intent does not match payment row', { paymentId: p.id, intent_id: intent.id });
      throw paymentUserError('PAYMENT_NOT_OPEN', 'This payment is no longer open. Please return to your invoices and start again.');
    }
    if (intent.status === 'succeeded') {
      await this._finalizeOnSessionSuccess(intent);
      return { status: 'succeeded', payment_id: p.id };
    }
    if (intent.status === 'processing') return { status: 'processing', payment_id: p.id };
    if (intent.status === 'canceled') {
      throw paymentUserError('PAYMENT_NOT_OPEN', 'This payment is no longer open. Please return to your invoices and start again.');
    }

    // Which card will be charged: the newly submitted one, or (after a 3-D Secure step) the one already
    // on the intent. Either way the server checks its funding type BEFORE confirming.
    let pmId = paymentMethodId || null;
    if (!pmId) {
      if (intent.status !== 'requires_confirmation') {
        throw paymentUserError('CARD_REQUIRED', 'Please enter your card details.', 422);
      }
      pmId = typeof intent.payment_method === 'string' ? intent.payment_method : (intent.payment_method && intent.payment_method.id);
    }
    if (!pmId || typeof pmId !== 'string' || !/^pm_/.test(pmId)) {
      throw paymentUserError('CARD_REQUIRED', 'Please enter your card details.', 422);
    }
    let pm;
    try {
      pm = await stripe.paymentMethods.retrieve(pmId);
    } catch (e) {
      throw paymentUserError('CARD_REQUIRED', 'We could not read that card. Please re-enter your card details.', 422);
    }
    if (!pm || pm.type !== 'card') throw paymentUserError('CARD_REQUIRED', 'Please pay with a debit or credit card.', 422);
    if (isPrepaid(pm)) {
      require('../lib/auditLog').writeAuditLog({
        event_type: 'card.prepaid_rejected', entity_type: 'payment', entity_id: p.id, actor_id: userId,
        metadata: { brand: pm.card && pm.card.brand, last4: pm.card && pm.card.last4, funding: 'prepaid', on_session: true },
      }).catch(() => {});
      throw paymentUserError('PREPAID_NOT_ACCEPTED', PREPAID_MESSAGE, 422);
    }

    try {
      intent = await stripe.paymentIntents.confirm(intent.id, paymentMethodId ? { payment_method: pmId } : {},
        { timeout: 20000 });
    } catch (err) {
      if (isCardError(err)) {
        // The buyer can try another card on the same page; the intent stays open.
        const msg = (err.message && !/stripe/i.test(err.message)) ? err.message : 'Your card was declined. Please try another card.';
        throw paymentUserError('CARD_DECLINED', msg, 402);
      }
      throw err;
    }

    if (intent.status === 'requires_action') {
      return { status: 'requires_action', payment_id: p.id, client_secret: intent.client_secret };
    }
    if (intent.status === 'succeeded') {
      await this._finalizeOnSessionSuccess(intent);
      return { status: 'succeeded', payment_id: p.id };
    }
    if (intent.status === 'processing') return { status: 'processing', payment_id: p.id };
    // requires_payment_method after a failed attempt (e.g. authentication failed).
    throw paymentUserError('CARD_DECLINED', 'Your card could not be charged. Please try another card.', 402);
  }

  // Synchronous finalize after an on-session success. Idempotent with the webhook (both paths no-op on an
  // already-paid row). A failure here is logged — the webhook still settles the payment.
  async _finalizeOnSessionSuccess(intent) {
    try {
      await this._handlePaymentIntentSucceeded(intent);
    } catch (e) {
      console.error('[payment] on-session finalize failed; webhook will settle', { intent_id: intent.id, error: e.message });
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
        // Idempotent retry: if a prior success recorded the payment but not the tax transaction, catch up.
        await this._finalizeTaxTransaction(paymentId);
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

    // Record the authoritative Stripe Tax Transaction now that the payment is committed as paid.
    // Idempotent + best-effort (guarded by stripe_tax_transaction_id + a stable idempotency key);
    // a failure here never affects the already-committed payment. No-op when tax is disabled.
    await this._finalizeTaxTransaction(paymentId);

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
    // A payment with no PaymentIntent (seeded / never charged) is REFUSED with NO_PAYMENT_INTENT; it is
    // never marked refunded without a real provider refund.
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

      // No PaymentIntent = no card charge on record, so there is nothing the provider can refund. Refuse
      // instead of silently marking the payment refunded (money would never actually move back).
      if (!payment.payment_intent_id) {
        const e = new Error('Cannot refund this payment here: it has no card charge on record (no payment intent). Record any off-platform refund manually.');
        e.code = 'NO_PAYMENT_INTENT';
        throw e;
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
    {
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

    // Reverse the recorded Stripe Tax Transaction for the refunded amount: in full on a full refund, or
    // proportionally on a partial refund. Idempotent (one reversal per cumulative refunded level, unique
    // reference) + best-effort; no-op when tax is disabled or no transaction exists.
    await this._reverseTaxForRefund(paymentId, newRefundedTotal, 'processRefund');

    return {
      payment_id:          paymentId,
      status:              newStatus,
      refund_amount_cents: refundAmountCents,
      stripe_refund_id:    stripeRefundId,
      refunded_at:         refundedAt,
      refunded_amount_cents_total: newRefundedTotal,
    };
  }

  // ── Stripe Tax helpers (all flag-gated; no-ops when STRIPE_TAX_ENABLED is off) ──────────────
  //
  // Load the buyer's confirmed tax address (jurisdiction evidence). Owner policy: jurisdiction is
  // the BUYER address, never the auction pickup address. Returns null when incomplete.
  async _loadBuyerTaxAddress(buyerUserId) {
    const u = (await db.query(
      `SELECT tax_address_line1, tax_address_line2, tax_city, tax_state, tax_postal_code, tax_country
         FROM users WHERE id = $1`, [buyerUserId])).rows[0];
    if (!u) return null;
    return {
      line1:       u.tax_address_line1,
      line2:       u.tax_address_line2,
      city:        u.tax_city,
      state:       u.tax_state,
      postal_code: u.tax_postal_code,
      country:     u.tax_country || 'US',
    };
  }

  // Release a still-transitional pending payment row (no intent attached) so a retry can proceed.
  // Used by the tax fail-safe: if tax cannot be calculated we must NOT charge the buyer.
  async _failPendingPayment(paymentId, reason) {
    try {
      await db.query(
        `UPDATE payments SET status = 'failed', last_attempted_at = now()
          WHERE id = $1 AND status = 'pending' AND payment_intent_id IS NULL`,
        [paymentId]);
    } catch (e) { console.error('[tax] failPendingPayment cleanup failed', { paymentId, reason, error: e.message }); }
  }

  // Compute sales tax for a taxable base and, when tax applies, grow the payment's charge amount and
  // persist the tax provenance. Returns the FINAL charge amount (base when tax is off/exempt/$0).
  // Throws taxService.TaxCalculationError when tax is required but cannot be produced (fail-safe):
  // the caller must fail the pending payment and surface a recoverable error — never charge without tax.
  async _applyTaxToPayment({ paymentId, buyerUserId, taxableBaseCents, currentAmountCents }) {
    // Tax is computed on taxableBaseCents (hammer + buyer premium — Owner policy) and ADDED on top of
    // the current charge (which equals the taxable base for single lots, or the combined total for
    // combined invoices, where shipping/credits are $0 at V1.0). Returns the final charge amount.
    const current = (currentAmountCents == null) ? taxableBaseCents : currentAmountCents;
    if (!taxService.taxEnabled()) return current; // exact pre-tax behavior; no Stripe call
    const address = await this._loadBuyerTaxAddress(buyerUserId);
    const t = await taxService.computeTax({
      buyerUserId,
      taxableBaseCents,
      address,
      reference: 'payment:' + paymentId,
    });
    const chargeCents = current + (t.taxCents || 0);
    await db.query(
      `UPDATE payments
          SET amount_cents               = $1,
              taxable_base_cents         = $2,
              sales_tax_cents            = $3,
              stripe_tax_calculation_id  = $4
        WHERE id = $5`,
      [chargeCents, taxableBaseCents, t.taxCents || 0, t.calculationId || null, paymentId]);
    return chargeCents;
  }

  // Record the authoritative Stripe Tax Transaction after a payment is paid. Idempotent: guarded by
  // stripe_tax_transaction_id IS NULL plus a stable Stripe idempotency key. Best-effort and safe to
  // re-run (webhook retries). No-op when the flag is off or the payment carries no calculation id.
  async _finalizeTaxTransaction(paymentId) {
    if (!taxService.taxEnabled()) return;
    try {
      const p = (await db.query(
        `SELECT stripe_tax_calculation_id, stripe_tax_transaction_id FROM payments WHERE id = $1`,
        [paymentId])).rows[0];
      if (!p || !p.stripe_tax_calculation_id || p.stripe_tax_transaction_id) return; // nothing to do / already recorded
      const txId = await taxService.recordTransaction({
        calculationId: p.stripe_tax_calculation_id,
        reference: 'payment:' + paymentId,
      });
      if (txId) {
        await db.query(`UPDATE payments SET stripe_tax_transaction_id = $1 WHERE id = $2 AND stripe_tax_transaction_id IS NULL`, [txId, paymentId]);
      }
    } catch (e) {
      // Never let tax bookkeeping break the (already-committed) payment. Log loudly for reconciliation.
      console.error('[tax] finalizeTaxTransaction failed — MANUAL TAX RECONCILIATION MAY BE REQUIRED', { paymentId, error: e.message });
    }
  }

  // Reverse sales tax for a refund (full or partial, issued from the app OR from outside it). The payment's
  // recorded Tax Transaction is reversed up to the CUMULATIVE refunded amount `refundedThroughCents`:
  //   - first reversal covering the whole payment → mode 'full' (reference 'refund:<payment>'), and
  //     payments.stripe_tax_reversal_id is set (guarded by stripe_tax_reversal_id IS NULL);
  //   - otherwise → mode 'partial' with a flat (tax-inclusive) amount equal to the newly refunded delta,
  //     so tax is reversed proportionally (reference 'refund:<payment>:<cumulative cents>').
  // Idempotent: one payment_tax_reversals row per cumulative level (unique), the provider call uses a stable
  // idempotency key per reference, and the payment row is locked so two refund paths (processRefund and the
  // charge.refunded webhook echo) can never reverse the same amount twice. Best-effort; never throws.
  async _reverseTaxForRefund(paymentId, refundedThroughCents, source) {
    if (!taxService.taxEnabled()) return null;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const p = (await client.query(
        `SELECT amount_cents, stripe_tax_transaction_id, stripe_tax_reversal_id FROM payments WHERE id = $1 FOR UPDATE`,
        [paymentId])).rows[0];
      if (!p || !p.stripe_tax_transaction_id || p.stripe_tax_reversal_id) { await client.query('ROLLBACK'); return null; }
      const through = Math.min(Math.max(0, Math.trunc(Number(refundedThroughCents) || 0)), p.amount_cents);
      const prior = (await client.query(
        `SELECT COALESCE(MAX(refunded_through_cents), 0)::int AS through, COUNT(*)::int AS n
           FROM payment_tax_reversals WHERE payment_id = $1`, [paymentId])).rows[0] || { through: 0, n: 0 };
      if (through <= prior.through) { await client.query('ROLLBACK'); return null; }   // already covered
      const delta = through - prior.through;
      const full = prior.n === 0 && through >= p.amount_cents;
      const reference = full ? 'refund:' + paymentId : 'refund:' + paymentId + ':' + through;
      const revId = full
        ? await taxService.reverseFullTransaction({ originalTransactionId: p.stripe_tax_transaction_id, reference })
        : await taxService.reversePartialTransaction({ originalTransactionId: p.stripe_tax_transaction_id, reference, refundAmountCents: delta });
      await client.query(
        `INSERT INTO payment_tax_reversals
           (payment_id, refunded_through_cents, reversal_amount_cents, mode, reference, stripe_tax_reversal_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [paymentId, through, delta, full ? 'full' : 'partial', reference, revId || null, source || null]);
      if (full && revId) {
        await client.query(`UPDATE payments SET stripe_tax_reversal_id = $1 WHERE id = $2 AND stripe_tax_reversal_id IS NULL`, [revId, paymentId]);
      }
      await client.query('COMMIT');
      return revId || null;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[tax] reverseTaxForRefund failed — MANUAL TAX REVERSAL MAY BE REQUIRED', { paymentId, refundedThroughCents, source, error: e.message });
      return null;
    } finally {
      client.release();
    }
  }

  // Reverse the recorded Tax Transaction in full when a payment is fully refunded. Idempotent.
  // (Legacy entry point; refunds now go through _reverseTaxForRefund.)
  async _reverseTaxForPayment(paymentId) {
    if (!taxService.taxEnabled()) return;
    try {
      const p = (await db.query(
        `SELECT stripe_tax_transaction_id, stripe_tax_reversal_id FROM payments WHERE id = $1`,
        [paymentId])).rows[0];
      if (!p || !p.stripe_tax_transaction_id || p.stripe_tax_reversal_id) return;
      const revId = await taxService.reverseFullTransaction({
        originalTransactionId: p.stripe_tax_transaction_id,
        reference: 'refund:' + paymentId,
      });
      if (revId) {
        await db.query(`UPDATE payments SET stripe_tax_reversal_id = $1 WHERE id = $2 AND stripe_tax_reversal_id IS NULL`, [revId, paymentId]);
      }
    } catch (e) {
      console.error('[tax] reverseTaxForPayment failed — MANUAL TAX REVERSAL MAY BE REQUIRED', { paymentId, error: e.message });
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

    // TEST/LIVE isolation: an event from the other mode (e.g. a TEST event delivered to a server running
    // LIVE keys) is acknowledged but never acted on, and not recorded as processed.
    if (!eventMatchesMode(event)) {
      console.warn(`[webhook] ${event.id} (${event.type}) livemode=${event.livemode} does not match the server key mode — ignored`);
      return { ignored: 'mode_mismatch' };
    }

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

    // ── Fixed-price Marketplace orders (Buy Now). These reuse THIS same signature-verified + idempotent
    // pipeline — no second webhook endpoint. Routed by metadata.product_type so auction PaymentIntents are
    // untouched. Lazy-required to avoid a require cycle. ──
    if ((event.type === 'payment_intent.succeeded'
        || event.type === 'payment_intent.payment_failed'
        || event.type === 'payment_intent.canceled')
        && obj && obj.metadata && obj.metadata.product_type === 'marketplace_order') {
      return require('./marketplaceOrderService').handleIntentEvent(event.type, obj);
    }

    if (event.type === 'payment_intent.succeeded') {
      return this._handlePaymentIntentSucceeded(obj);
    }
    if (event.type === 'payment_intent.payment_failed') {
      return this._handlePaymentIntentFailed(obj);
    }
    if (event.type === 'payment_intent.canceled') {
      return this._handlePaymentIntentCanceled(obj);
    }
    // ── Disputes (chargebacks): record, hold the seller payout, audit, alert the owner. No money moves. ──
    if (event.type === 'charge.dispute.created'
        || event.type === 'charge.dispute.updated'
        || event.type === 'charge.dispute.closed') {
      return require('./disputeService').handleDisputeEvent(event, { getStripe });
    }

    if (event.type === 'charge.refunded') {
      // A Dashboard/out-of-band refund on a Marketplace charge reconciles to the marketplace order first;
      // if it is not one of ours, fall through to the auction refund reconcile.
      const handled = await require('./marketplaceOrderService').tryHandleChargeRefunded(obj);
      if (handled) return;
      return this._handleChargeRefunded(obj);
    }

    // ── Professional-membership subscription events (Phase 2A: Appraiser). ──────
    // Delegated to appraiserMembershipService, which no-ops for any subscription that is not an
    // Appraiser membership (so other future subscription products are unaffected). Reuses this
    // same signature-verified + idempotent (stripe_webhook_events) pipeline — no second endpoint.
    // Lazy-required to avoid a require cycle at module load.
    if (event.type === 'checkout.session.completed'
      || event.type === 'customer.subscription.created'
      || event.type === 'customer.subscription.updated'
      || event.type === 'customer.subscription.deleted'
      || event.type === 'invoice.paid'
      || event.type === 'invoice.payment_failed') {
      const appraiser = require('./appraiserMembershipService');
      if (event.type === 'checkout.session.completed') {
        // Route one-time products by metadata.product_type; subscription checkouts go to the appraiser
        // handler (which ignores non-subscription sessions). New one-time products add a branch here.
        const productType = obj.metadata && obj.metadata.product_type;
        if (productType === 'estate_sale_promotion') return require('./estateSalePromotionService').handleCheckoutCompleted(obj);
        if (productType === 'marketing_package' || productType === 'additional_promotion') return require('./marketingPackagePurchaseService').handleCheckoutCompleted(obj);
        return appraiser.handleCheckoutCompleted(obj);
      }
      if (event.type === 'invoice.paid') return appraiser.handleInvoicePaid(obj);
      if (event.type === 'invoice.payment_failed') return appraiser.handleInvoicePaymentFailed(obj);
      return appraiser.handleSubscriptionEvent(obj, event.type); // subscription.created/updated/deleted
    }

    // ── Stripe Connect events (seller Direct Deposit). Reuses this same signature-verified +
    // idempotent pipeline — no second endpoint. account.updated / payout.* carry event.account
    // (the connected account); transfer.* are platform events. Lazy-required to avoid cycles. ──
    if (event.type === 'account.updated') {
      return require('./stripeConnectService').applyAccountUpdated(obj);
    }
    if (event.type === 'transfer.created' || event.type === 'transfer.reversed') {
      return require('./settlementEngine').applyTransferEvent(event.type, obj);
    }
    if (event.type === 'payout.paid' || event.type === 'payout.failed') {
      // Connected-account payout health (aggregate; not per-settlement). event.account is the acct id.
      const failed = event.type === 'payout.failed';
      const failureMessage = failed ? (obj.failure_message || obj.failure_code || 'payout failed') : null;
      return require('./stripeConnectService').applyPayoutEvent(event.account || null, { failed, failureMessage });
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
    if (!paymentRes.rows[0] && intent.metadata && intent.metadata.payment_id && intent.metadata.buyer_user_id) {
      // The intent id was never attached (e.g. the create call timed out but the charge went through).
      // Attach it to the row named in its own metadata — only when that row belongs to the same buyer and
      // has no intent yet — so money received is always recorded (the state machine below does the rest).
      const attached = await db.query(
        `UPDATE payments SET payment_intent_id = $1
          WHERE id = $2 AND buyer_user_id = $3 AND payment_intent_id IS NULL
          RETURNING id, lot_id, auction_id, buyer_user_id`,
        [intent.id, intent.metadata.payment_id, intent.metadata.buyer_user_id]);
      if (attached && attached.rows && attached.rows[0]) {
        console.warn(`[webhook] payment_intent.succeeded — attached unrecorded intent ${intent.id} to payment ${attached.rows[0].id} via metadata`);
        paymentRes.rows = attached.rows;
      }
    }
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
        const s = await combinedSvc.settleCombined(bai.id, intent.id, payment.id);
        // If THIS settle flipped the header to paid, send the success package (covers the
        // rare charge-returned-pending case where the close hook did not email). Idempotent:
        // if the close hook already settled + emailed, settleCombined returns {alreadyPaid}
        // and no duplicate is sent. Best-effort — never break the webhook ack.
        if (s && s.settled) {
          require('./combinedReceiptService').sendSuccessPackage(bai.id)
            .catch(e => console.error('[webhook] combined success package send failed', bai.id, e.message));
        }
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
    let reverseForPaymentId = null, reverseThrough = 0;
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
        // Make sure the matching tax reversal exists (idempotent; a no-op when processRefund already did it).
        await this._reverseTaxForRefund(payment.id, payment.refunded_amount_cents || 0, 'charge.refunded');
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
      reverseForPaymentId = payment.id;
      reverseThrough = Math.max(priorRefunded, amountRefunded);
      console.log(`[webhook] charge.refunded → payment ${payment.id} reconciled (status=${newStatus}, refund=${latestRefundId}, total_refunded=${Math.max(priorRefunded, amountRefunded)})`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    // Sales tax follows the refund, whether it was issued in the app or outside it (Dashboard), in full or
    // in part. Idempotent: an echo of processRefund's own refund finds the level already reversed.
    if (reverseForPaymentId) await this._reverseTaxForRefund(reverseForPaymentId, reverseThrough, 'charge.refunded');
  }
}

module.exports = new PaymentService();
