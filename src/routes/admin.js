
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const auctionService = require('../services/auctionService');
const paymentService = require('../services/paymentService');
const { sendFinalSellerReport } = require('../services/pdfGenerationService');

// PATCH /api/admin/auctions/:auctionId
router.patch('/auctions/:auctionId', auth, role(['admin']), idempotency, (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: {
      title: 'string?',
      featured_lot_ids: ['uuid'],
      pickup_window_start: 'timestamp?'
    },
    responseShape: { id: 'uuid', updated_at: 'timestamp' }
  });
});

// POST /api/admin/sellers/:sellerId/capabilities
router.post('/sellers/:sellerId/capabilities', auth, role(['admin']), idempotency, (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    requestShape: {
      shipping_enabled: 'boolean?',
      reserve_enabled: 'boolean?'
    },
    responseShape: { seller_id: 'uuid', capabilities: 'object' }
  });
});

// POST /api/admin/auctions/:auctionId/publish
router.post('/auctions/:auctionId/publish', auth, role(['admin']), idempotency, (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    responseShape: { id: 'uuid', state: 'published' }
  });
});

// PATCH /api/admin/auctions/:auctionId/publish
router.patch('/auctions/:auctionId/publish', auth, role(['admin']), idempotency, async (req, res, next) => {
  try {
    const { auctionId } = req.params;
    const result = await auctionService.publishAuction(auctionId, req.user.id);
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.message === 'Auction not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (err.message === 'Auction is already published') {
      return res.status(409).json({ success: false, message: err.message });
    }
    if (err.message === 'Cannot publish a closed auction') {
      return res.status(422).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// POST /api/admin/auctions/:auctionId/close
router.post('/auctions/:auctionId/close', auth, role(['admin']), async (req, res, next) => {
  try {
    const { auctionId } = req.params;
    const result = await auctionService.closeAuction(auctionId, req.user.id);
    return res.json({
      success: true,
      message: 'Auction closed successfully.',
      data: result
    });
  } catch (err) {
    if (err.message === 'Auction not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (err.message === 'Auction is already closed') {
      return res.status(409).json({ success: false, message: err.message });
    }
    if (err.message === 'Only published auctions can be closed') {
      return res.status(422).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// POST /api/admin/auctions/:auctionId/send-final-report
// MANUAL ONLY — human-gated. Never called automatically by the auction lifecycle.
router.post('/auctions/:auctionId/send-final-report', auth, role(['admin']), async (req, res, next) => {
  try {
    const { auctionId } = req.params;
    const result = await sendFinalSellerReport(auctionId);
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.message === 'Auction not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (err.message.startsWith('sendFinalSellerReport: not yet implemented')) {
      return res.status(501).json({ success: false, message: 'Final report delivery is not yet implemented. The endpoint is wired and protected.' });
    }
    next(err);
  }
});

// POST /api/admin/payments/:paymentId/record-success
router.post('/payments/:paymentId/record-success', auth, role(['admin']), async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const { payment_provider_id } = req.body;
    const result = await paymentService.recordPaymentSuccess(
      paymentId,
      payment_provider_id || 'manual'
    );
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.message === 'Payment not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    next(err);
  }
});

module.exports = router;
