const express = require('express');
const router = express.Router();

// Middleware for financial protection
const { strictLimiter } = require('../middleware/rateLimit');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const { validatePaymentAmount } = require('../validation/paymentValidation');
const paymentService = require('../services/paymentService');

// POST /api/payments/charge-lot
router.post('/charge-lot', strictLimiter, auth, role(['buyer', 'admin']), idempotency, async (req, res, next) => {
  try {
    if (!req.headers['idempotency-key']) {
      return res.status(400).json({ error: 'Missing Idempotency-Key' });
    }
    const { amount_cents, auction_id, lot_id } = req.body;
    const validation = validatePaymentAmount(amount_cents);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors
      });
    }
    const userId = req.user.id;
    // Business logic handled in paymentService
    const result = await paymentService.chargeLot(userId, auction_id, lot_id, amount_cents);
    res.status(200).json(result);
  } catch (err) {
    next(err);
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

module.exports = router;
