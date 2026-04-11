const express = require('express');
const router = express.Router({ mergeParams: true });

// POST /api/auctions/:auctionId/lots/:lotId/bids
router.post('/', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: { amount_cents: 'integer', bidder_user_id: 'uuid' },
    responseShape: { id: 'uuid', amount_cents: 'integer', paddle_number: 'int' }
  });
});

// GET /api/auctions/:auctionId/lots/:lotId/bids
router.get('/', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    responseShape: [{ id: 'uuid', amount_cents: 'integer', paddle_number: 'int', timestamp: 'timestamp' }]
  });
});

module.exports = router;
