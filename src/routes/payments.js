const express = require('express');
const router = express.Router();

// Middleware for financial protection
const { strictLimiter } = require('../middleware/rateLimit');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const { blockDemoSideEffects } = require('../middleware/demoGuard');
const paymentService = require('../services/paymentService');
const cardService = require('../services/cardService'); // #20 STEP 4 card-on-file
const taxService = require('../services/taxCalculationService');
const db = require('../db');
const Stripe = require('stripe');
// TEST/LIVE safety: payment endpoints fail closed (503) when the secret and publishable keys disagree.
const { requireConsistentStripeMode } = require('../lib/stripeMode');

const GENERIC_PAYMENT_ERROR = "We couldn't start your payment. Please try again in a moment.";

// Map any payment error to a buyer-safe response. Only errors the service marks as buyer-facing (or the tax
// fail-safe codes, which carry their own status) show their message; database and provider errors never
// reach the buyer (they are logged instead).
function publicPaymentError(err) {
  if (err && err.userFacing) return { status: err.status || 400, body: { success: false, code: err.code, message: err.message } };
  if (err && err.code && err.status && typeof err.status === 'number' && !err.severity && !err.type) {
    return { status: err.status, body: { success: false, code: err.code, message: err.message } };
  }
  const isDb = !!(err && (err.severity || (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code))));
  const isProvider = !!(err && typeof err.type === 'string' && /^Stripe/.test(err.type));
  if (!err || isDb || isProvider || !err.message) return { status: 500, body: { success: false, message: GENERIC_PAYMENT_ERROR } };
  // Plain validation errors thrown by the service ('Lot must be closed before payment', …) are safe to show.
  return { status: 400, body: { success: false, message: err.message } };
}

// GET /api/payments/config — returns Stripe publishable key + whether sales tax is active, so the
// buyer UI knows to collect a tax address and display a Sales Tax line before payment.
router.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '', taxEnabled: taxService.taxEnabled() });
});

// GET /api/payments/tax-address — the buyer's saved tax (billing) address, for prefill. Buyer-scoped.
router.get('/tax-address', auth, async (req, res) => {
  try {
    const u = (await db.query(
      `SELECT tax_address_line1, tax_address_line2, tax_city, tax_state, tax_postal_code, tax_country
         FROM users WHERE id = $1`, [req.user.id])).rows[0] || {};
    const address = {
      line1:       u.tax_address_line1 || '',
      line2:       u.tax_address_line2 || '',
      city:        u.tax_city || '',
      state:       u.tax_state || '',
      postal_code: u.tax_postal_code || '',
      country:     u.tax_country || 'US',
    };
    return res.json({ success: true, data: { address, complete: taxService.addressComplete(address), tax_enabled: taxService.taxEnabled() } });
  } catch (err) {
    console.error('[payments] tax-address get failed:', err.message);
    return res.status(500).json({ success: false, message: 'Could not load your billing address' });
  }
});

// PUT /api/payments/tax-address — buyer saves/confirms their tax (billing) address. Server-authoritative:
// a buyer can only set their OWN address; this address is what Stripe Tax uses for jurisdiction. It does
// NOT grant any exemption (only an admin approval does — see taxExemptionService).
router.put('/tax-address', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const address = {
      line1:       (b.line1 || '').trim(),
      line2:       (b.line2 || '').trim(),
      city:        (b.city || '').trim(),
      state:       (b.state || '').trim(),
      postal_code: (b.postal_code || '').trim(),
      country:     (b.country || 'US').trim().toUpperCase(),
    };
    if (!taxService.addressComplete(address)) {
      return res.status(422).json({ success: false, code: 'INCOMPLETE_ADDRESS',
        message: 'Please provide street address, city, state, and ZIP/postal code.' });
    }
    await db.query(
      `UPDATE users SET tax_address_line1 = $2, tax_address_line2 = $3, tax_city = $4,
                        tax_state = $5, tax_postal_code = $6, tax_country = $7
        WHERE id = $1`,
      [req.user.id, address.line1, address.line2 || null, address.city, address.state, address.postal_code, address.country]);
    return res.json({ success: true, data: { address, complete: true } });
  } catch (err) {
    console.error('[payments] tax-address save failed:', err.message);
    return res.status(500).json({ success: false, message: 'Could not save your billing address' });
  }
});

// #20 STEP 4: card-on-file (Stripe TEST, no charge).
// POST /api/payments/setup-intent — create a SetupIntent to save a card.
router.post('/setup-intent', auth, requireConsistentStripeMode, blockDemoSideEffects, async (req, res) => {
  try {
    const data = await cardService.createSetupIntent(req.user.id);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[payments] setup-intent failed:', err.message);
    return res.status(500).json({ success: false, message: 'Could not start card setup' });
  }
});

// POST /api/payments/card-on-file — after the client confirms the SetupIntent,
// record the saved PM as the default + a verified marker. No charge.
router.post('/card-on-file', auth, requireConsistentStripeMode, blockDemoSideEffects, async (req, res) => {
  try {
    const data = await cardService.recordCardOnFile(req.user.id);
    return res.json({ success: true, data });
  } catch (err) {
    if (err.code === 'NO_PM') return res.status(422).json({ success: false, message: err.message, code: 'NO_PM' });
    // Debit and credit cards only: a prepaid card is refused with a plain explanation (the card is not kept).
    if (err.code === 'PREPAID_NOT_ACCEPTED') return res.status(422).json({ success: false, message: err.message, code: 'PREPAID_NOT_ACCEPTED' });
    console.error('[payments] card-on-file save failed:', err.message);
    return res.status(500).json({ success: false, message: 'Could not save payment method' });
  }
});

// GET /api/payments/card-on-file — whether the buyer has a card on file.
router.get('/card-on-file', auth, async (req, res) => {
  try {
    const has = await cardService.hasCardOnFile(req.user.id);
    return res.json({ success: true, data: { has_card: has } });
  } catch (err) {
    console.error('[payments] card-on-file status failed:', err.message);
    return res.status(500).json({ success: false, message: 'Could not check payment method' });
  }
});

// GET /api/payments/card-summary — buyer billing page: SAFE card metadata only
// (brand/last4/exp from Stripe). Never PAN/CVC; nothing sensitive is stored.
router.get('/card-summary', auth, async (req, res) => {
  try {
    const data = await cardService.getCardSummary(req.user.id);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[payments] card-summary failed:', err.message);
    return res.status(500).json({ success: false, message: 'Could not load billing summary' });
  }
});

// POST /api/payments/charge-lot
// 'seller' is permitted in addition to 'buyer': in a discovery marketplace a user
// who self-serves into a seller account may still win and pay for lots in OTHER
// sellers' auctions. Without this, becoming a seller would silently revoke the
// ability to pay for won lots. (Self-bidding on one's OWN auction is blocked
// server-side in bidService.createBid, so a seller can never pay themselves.)
router.post('/charge-lot', strictLimiter, auth, role(['buyer', 'seller', 'admin']), requireConsistentStripeMode, blockDemoSideEffects, idempotency, async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Missing Idempotency-Key' });
  }

  const { auction_id, lot_id } = req.body;
  try {
    // The HTTP Idempotency-Key is also passed to Stripe so SDK-level retries
    // collapse to the same PaymentIntent within Stripe's 24h idempotency window.
    const result = await paymentService.createPaymentIntent(req.user.id, auction_id, lot_id, idempotencyKey);
    console.log('[payments] payment intent created:', { userId: req.user.id, lotId: lot_id, auctionId: auction_id });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('[payments] charge-lot failed:', { userId: req.user.id, lotId: lot_id, auctionId: auction_id, error: err.message });
    // Tax fail-safe codes (e.g. BUYER_TAX_ADDRESS_REQUIRED) and retry outcomes carry their own status so the
    // UI can prompt; raw database / provider errors are never shown to the buyer.
    const pe = publicPaymentError(err);
    return res.status(pe.status).json(pe.body);
  }
});

// POST /api/payments/charge-combined — start an ON-SESSION payment for an unpaid
// combined invoice (the whole auction at once). Returns a payment_id for payment.html (no client secret);
// the webhook null-lot branch settles the combined header + per-lot invoices on success.
router.post('/charge-combined', strictLimiter, auth, role(['buyer', 'seller', 'admin']), requireConsistentStripeMode, blockDemoSideEffects, idempotency, async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) return res.status(400).json({ error: 'Missing Idempotency-Key' });
  const { combined_invoice_id } = req.body;
  if (!combined_invoice_id) return res.status(400).json({ success: false, message: 'combined_invoice_id is required' });
  try {
    const result = await paymentService.createCombinedPaymentIntent(req.user.id, combined_invoice_id, idempotencyKey);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('[payments] charge-combined failed:', { userId: req.user.id, combinedInvoiceId: combined_invoice_id, error: err.message });
    const pe = publicPaymentError(err);
    return res.status(pe.status).json(pe.body);
  }
});

// GET /api/payments/checkout/:paymentId — what payment.html needs to show and pay one pending payment
// (amount, tax breakdown, lot/auction labels, publishable key). Authenticated; only the buyer who owns the
// payment can load it. Never returns a client secret.
router.get('/checkout/:paymentId', auth, requireConsistentStripeMode, async (req, res) => {
  try {
    const data = await paymentService.getCheckout(req.user.id, req.params.paymentId);
    return res.json({ success: true, data });
  } catch (err) {
    if (!(err && err.userFacing)) console.error('[payments] checkout load failed:', { userId: req.user.id, paymentId: req.params.paymentId, error: err.message });
    const pe = publicPaymentError(err);
    return res.status(pe.status).json(pe.body);
  }
});

// POST /api/payments/checkout/:paymentId/confirm { payment_method_id? } — server-confirmed card payment.
// The browser creates a PaymentMethod and posts its id; the server refuses a prepaid card (422), otherwise
// confirms the PaymentIntent. A 3-D Secure step returns { status:'requires_action', client_secret }; after
// the browser completes it, it calls this again WITHOUT payment_method_id and the server confirms the result.
router.post('/checkout/:paymentId/confirm', strictLimiter, auth, role(['buyer', 'seller', 'admin']), requireConsistentStripeMode, blockDemoSideEffects, async (req, res) => {
  const pmId = req.body && req.body.payment_method_id ? String(req.body.payment_method_id) : null;
  try {
    const data = await paymentService.confirmOnSessionPayment(req.user.id, req.params.paymentId, pmId);
    return res.json({ success: true, data });
  } catch (err) {
    if (!(err && err.userFacing)) console.error('[payments] checkout confirm failed:', { userId: req.user.id, paymentId: req.params.paymentId, error: err.message, type: err.type, code: err.code });
    const pe = publicPaymentError(err);
    return res.status(pe.status).json(pe.body);
  }
});

// POST /api/payments/:paymentId/refund
router.post('/:paymentId/refund', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: { amount_cents: 'integer?' },
    responseShape: { id: 'uuid', status: 'refunded|partially_refunded' }
  });
});

// POST /api/payments/webhook
// Stripe sends this. MUST use express.raw() — JSON body parser breaks signature verification.
// Mount this route BEFORE any global express.json() middleware in server.js, or
// ensure server.js calls app.use('/api/payments/webhook', express.raw({ type: '*/*' }))
// before the global json middleware.
// Verify a webhook signature against each configured endpoint secret: the platform endpoint
// (STRIPE_WEBHOOK_SECRET) and, optionally, the connected-accounts endpoint (STRIPE_CONNECT_WEBHOOK_SECRET),
// which the provider signs with its own secret. Returns the event or throws the last verification error.
function verifyWebhookEvent(rawBody, sig, env = process.env) {
  const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean);
  if (!secrets.length) { const e = new Error('Webhook secret not configured'); e.code = 'NO_WEBHOOK_SECRET'; throw e; }
  const stripe = Stripe(env.STRIPE_SECRET_KEY || 'sk_test_unset');
  let lastErr;
  for (const secret of secrets) {
    try { return stripe.webhooks.constructEvent(rawBody, sig, secret); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig     = req.headers['stripe-signature'];

  let event;
  try {
    event = verifyWebhookEvent(req.body, sig);
  } catch (err) {
    if (err && err.code === 'NO_WEBHOOK_SECRET') {
      console.error('[webhook] STRIPE_WEBHOOK_SECRET not set');
      return res.status(500).send('Webhook secret not configured');
    }
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: signature verification failed');
  }

  try {
    // handleWebhookEvent acknowledges (200) but ignores an event from the other TEST/LIVE mode.
    await paymentService.handleWebhookEvent(event);
    return res.json({ received: true });
  } catch (err) {
    // Return non-2xx so Stripe retries. handleWebhookEvent marks the event row
    // as 'failed' before rethrowing, so the next delivery picks up from the
    // failure state and re-runs the handler — no double-processing risk because
    // dispatch handlers are individually idempotent on prior-success rows.
    console.error('[webhook] Handler error:', { event_id: event.id, event_type: event.type, error: err.message });
    return res.status(500).json({ received: false, error: 'handler_failed' });
  }
});

module.exports = router;
module.exports.verifyWebhookEvent = verifyWebhookEvent;
module.exports.publicPaymentError = publicPaymentError;
