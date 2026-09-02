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
router.post('/setup-intent', auth, blockDemoSideEffects, async (req, res) => {
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
router.post('/card-on-file', auth, blockDemoSideEffects, async (req, res) => {
  try {
    const data = await cardService.recordCardOnFile(req.user.id);
    return res.json({ success: true, data });
  } catch (err) {
    if (err.code === 'NO_PM') return res.status(422).json({ success: false, message: err.message, code: 'NO_PM' });
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
router.post('/charge-lot', strictLimiter, auth, role(['buyer', 'seller', 'admin']), blockDemoSideEffects, idempotency, async (req, res) => {
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
    // Tax fail-safe: surface a recoverable code (e.g. BUYER_TAX_ADDRESS_REQUIRED) so the UI can prompt.
    if (err && err.code && err.status) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/payments/charge-combined — start an ON-SESSION payment for an unpaid
// combined invoice (the whole auction at once). Returns a client_secret for payment.html;
// the webhook null-lot branch settles the combined header + per-lot invoices on success.
router.post('/charge-combined', strictLimiter, auth, role(['buyer', 'seller', 'admin']), blockDemoSideEffects, idempotency, async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) return res.status(400).json({ error: 'Missing Idempotency-Key' });
  const { combined_invoice_id } = req.body;
  if (!combined_invoice_id) return res.status(400).json({ success: false, message: 'combined_invoice_id is required' });
  try {
    const result = await paymentService.createCombinedPaymentIntent(req.user.id, combined_invoice_id, idempotencyKey);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('[payments] charge-combined failed:', { userId: req.user.id, combinedInvoiceId: combined_invoice_id, error: err.message });
    if (err && err.code && err.status) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    return res.status(400).json({ success: false, message: err.message });
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
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET not set');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
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
