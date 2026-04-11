const express = require('express');
const router = express.Router();

// POST /api/payments/charge-lot
router.post('/charge-lot', (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: { auction_id: 'uuid', lot_id: 'uuid', buyer_user_id: 'uuid', amount_cents: 'integer' },
    responseShape: { id: 'uuid', status: 'pending' }
  });
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
