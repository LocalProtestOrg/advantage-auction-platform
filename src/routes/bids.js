const express = require('express');
const router = express.Router({ mergeParams: true });

// Middleware for financial protection
const { strictLimiter } = require('../middleware/rateLimit');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const { validateBid } = require('../validation/bidValidation');
const bidService = require('../services/bidService');

// POST /api/auctions/:auctionId/lots/:lotId/bids
router.post('/', strictLimiter, auth, role(['buyer']), idempotency, async (req, res, next) => {
  try {
    if (!req.headers['idempotency-key']) {
      return res.status(400).json({ error: 'Missing Idempotency-Key' });
    }
    const validation = validateBid(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors
      });
    }
    const bidderId = req.user.id;
    const { amount_cents } = req.body;
    const { auctionId, lotId } = req.params;
    console.log({
      event: 'bid_attempt',
      bidderId,
      auctionId,
      lotId,
      amount_cents
    });
    // Business logic is handled in bidService
    const result = await bidService.placeBid(bidderId, auctionId, lotId, amount_cents);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/auctions/:auctionId/lots/:lotId/bids
router.get('/', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    responseShape: [{ id: 'uuid', amount_cents: 'integer', paddle_number: 'int', timestamp: 'timestamp' }]
  });
});

module.exports = router;
