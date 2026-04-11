const express = require('express');
const router = express.Router();

// PATCH /api/admin/auctions/:auctionId
router.patch('/auctions/:auctionId', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: { title: 'string?', featured_lot_ids: ['uuid']?, pickup_window_start: 'timestamp?' },
    responseShape: { id: 'uuid', updated_at: 'timestamp' }
  });
});

// POST /api/admin/sellers/:sellerId/capabilities
router.post('/sellers/:sellerId/capabilities', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: { shipping_enabled: 'boolean?', reserve_enabled: 'boolean?' },
    responseShape: { seller_id: 'uuid', capabilities: 'object' }
  });
});

// POST /api/admin/auctions/:auctionId/publish
router.post('/auctions/:auctionId/publish', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    responseShape: { id: 'uuid', state: 'published' }
  });
});

module.exports = router;
