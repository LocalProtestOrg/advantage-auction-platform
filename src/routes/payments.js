const express = require('express');
const router = express.Router();

// Middleware for financial protection
const { strictLimiter } = require('../middleware/rateLimit');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const paymentService = require('../services/paymentService');
const db = require('../db');
const Stripe = require('stripe');

const CHARGE_LOT_ROUTE = 'POST /api/payments/charge-lot';

// POST /api/payments/charge-lot
// DB-backed idempotency: placeholder row is inserted first; response is stored on completion.
// Concurrent duplicate requests are held off with a 409 until the first resolves.
router.post('/charge-lot', strictLimiter, auth, role(['buyer', 'admin']), async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Missing Idempotency-Key' });
  }

  // Step 1: Claim the idempotency slot (INSERT with no response yet)
  const STALE_SECONDS = 30;
  try {
    await db.query(
      `INSERT INTO payment_idempotency_keys (idempotency_key, route)
       VALUES ($1, $2)`,
      [idempotencyKey, CHARGE_LOT_ROUTE]
    );
  } catch (insertErr) {
    if (insertErr.code === '23505') {
      // Slot already exists — check if a response was stored
      const existing = await db.query(
        `SELECT response_status, response_body, created_at FROM payment_idempotency_keys
         WHERE idempotency_key = $1 AND route = $2`,
        [idempotencyKey, CHARGE_LOT_ROUTE]
      );
      const record = existing.rows[0];
      if (record && record.response_body !== null) {
        // Replay the stored response exactly
        return res.status(record.response_status).json(record.response_body);
      }
      // Row exists but has no response yet — check if it's stale (crashed process)
      const ageSeconds = (Date.now() - new Date(record.created_at).getTime()) / 1000;
      if (ageSeconds > STALE_SECONDS) {
        // Stale in-progress row — delete it and let this request proceed
        await db.query(
          `DELETE FROM payment_idempotency_keys WHERE idempotency_key = $1 AND route = $2 AND response_body IS NULL`,
          [idempotencyKey, CHARGE_LOT_ROUTE]
        );
        await db.query(
          `INSERT INTO payment_idempotency_keys (idempotency_key, route) VALUES ($1, $2)`,
          [idempotencyKey, CHARGE_LOT_ROUTE]
        );
      } else {
        // Another request is currently processing this key — reject the duplicate
        return res.status(409).json({
          success: false,
          message: 'Request already in progress. Retry shortly.'
        });
      }
    } else {
      // Unexpected DB error — surface it
      return res.status(500).json({ success: false, message: insertErr.message });
    }
  }

  // Helper to store the response and send it
  const finish = async (statusCode, body) => {
    await db.query(
      `UPDATE payment_idempotency_keys
       SET response_status = $1, response_body = $2::jsonb
       WHERE idempotency_key = $3 AND route = $4`,
      [statusCode, JSON.stringify(body), idempotencyKey, CHARGE_LOT_ROUTE]
    );
    return res.status(statusCode).json(body);
  };

  // Step 2: Run payment business logic — separated from finish() so DB write
  // errors in finish() cannot be mistaken for business logic errors.
  const { auction_id, lot_id } = req.body;
  let statusCode, body;
  try {
    const result = await paymentService.createPaymentIntent(req.user.id, auction_id, lot_id);
    statusCode = 200;
    body = { success: true, data: result };
  } catch (err) {
    statusCode = 400;
    body = { success: false, message: err.message };
  }
  try {
    return await finish(statusCode, body);
  } catch (finishErr) {
    console.error('Failed to store idempotency response:', finishErr.message);
    if (!res.headersSent) {
      return res.status(statusCode).json(body);
    }
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
