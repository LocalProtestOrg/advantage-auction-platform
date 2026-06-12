const express = require('express');
const router = express.Router();

// Middleware for financial protection
const { strictLimiter } = require('../middleware/rateLimit');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const paymentService = require('../services/paymentService');
const cardService = require('../services/cardService'); // #20 STEP 4 card-on-file
const Stripe = require('stripe');

// GET /api/payments/config — returns Stripe publishable key for frontend use
router.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// #20 STEP 4: card-on-file (Stripe TEST, no charge).
// POST /api/payments/setup-intent — create a SetupIntent to save a card.
router.post('/setup-intent', auth, async (req, res) => {
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
router.post('/card-on-file', auth, async (req, res) => {
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

// POST /api/payments/charge-lot
router.post('/charge-lot', strictLimiter, auth, role(['buyer', 'admin']), idempotency, async (req, res) => {
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
