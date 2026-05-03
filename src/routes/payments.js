const express = require('express');
const router = express.Router();

// Middleware for financial protection
const { strictLimiter } = require('../middleware/rateLimit');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const paymentService = require('../services/paymentService');
const Stripe = require('stripe');

// POST /api/payments/charge-lot
router.post('/charge-lot', strictLimiter, auth, role(['buyer', 'admin']), idempotency, async (req, res) => {
  if (!req.headers['idempotency-key']) {
    return res.status(400).json({ error: 'Missing Idempotency-Key' });
  }

  const { auction_id, lot_id } = req.body;
  try {
    const result = await paymentService.createPaymentIntent(req.user.id, auction_id, lot_id);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
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
    console.error('[webhook] Handler error:', err.message);
    // Return 200 so Stripe does not retry events we've already partially processed.
    // Internal failures are logged; idempotency guards prevent double-processing on retry.
    return res.status(200).json({ received: true, warning: err.message });
  }
});

module.exports = router;
