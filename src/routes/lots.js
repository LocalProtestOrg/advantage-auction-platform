const express = require('express');
const router = express.Router({ mergeParams: true });

// mount nested bids route for /api/auctions/:auctionId/lots/:lotId/bids
router.use('/:lotId/bids', require('./bids'));

// POST /api/auctions/:auctionId/lots
router.post('/', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: {
      title: 'string',
      description: 'string',
      size_category: "'A'|'B'|'C'",
      dimensions: 'object?',
      shippable: 'boolean?',
      shipping_cost_cents: 'integer?'
    },
    responseShape: { id: 'uuid', lot_number: 'int', state: 'open' }
  });
});

// PATCH /api/auctions/:auctionId/lots/:lotId
router.patch('/:lotId', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: { title: 'string?', description: 'string?', is_withdrawn: 'boolean?' },
    responseShape: { id: 'uuid', updated_at: 'timestamp' }
  });
});

// DELETE /api/auctions/:auctionId/lots/:lotId (withdraw)
router.delete('/:lotId', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    responseShape: { id: 'uuid', is_withdrawn: true }
  });
});

// POST /api/auctions/:auctionId/lots/:lotId/images
router.post('/:lotId/images', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: { filename: 'string', contentType: 'string' },
    responseShape: { uploadUrl: 'string', storageKey: 'string' }
  });
});

module.exports = router;
