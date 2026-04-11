const express = require('express');
const router = express.Router();

// mount nested lot routes
router.use('/:auctionId/lots', require('./lots'));

// GET /api/auctions/seller
router.get('/seller', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: null,
    responseShape: { auctions: [{ id: 'uuid', title: 'string', state: 'draft|submitted|published' }] }
  });
});

// POST /api/auctions
router.post('/', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: {
      title: 'string',
      description: 'string',
      public_auction_type: 'string',
      auction_terms: 'string',
      consignor_ids: ['uuid'],
      marketing_selection: { tier_id: 'uuid' }
    },
    responseShape: { id: 'uuid', state: 'draft' }
  });
});

// GET /api/auctions/:auctionId (seller view)
router.get('/:auctionId', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    responseShape: { id: 'uuid', title: 'string', consignors: [{ id: 'uuid', name: 'string' }], address_encrypted: 'binary' }
  });
});

// PATCH /api/auctions/:auctionId
router.patch('/:auctionId', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: { title: 'string?', auction_terms: 'string?', marketing_selection: 'object?' },
    responseShape: { id: 'uuid', updated_at: 'timestamp' }
  });
});

// POST /api/auctions/:auctionId/submit
router.post('/:auctionId/submit', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: { clientVersion: 'int' },
    responseShape: { id: 'uuid', state: 'submitted', errors: ['optional validation errors'] }
  });
});

// Public endpoint
router.get('/:auctionId/public', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    responseShape: { id: 'uuid', title: 'string', city: 'string', zip: 'string', lots: [{ id: 'uuid', title: 'string', bid_count: 0 }] }
  });
});

module.exports = router;
