
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const auctionService = require('../services/auctionService');
const paymentService = require('../services/paymentService');
const { sendFinalSellerReport } = require('../services/pdfGenerationService');
const { enqueueNewAuctionNotifications } = require('../services/followerNotificationService');
const db = require('../db');

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

    // Fan-out NEW_AUCTION notifications to seller followers after commit.
    // Guarded: failure here must never affect the publish response.
    enqueueNewAuctionNotifications(result).catch(err => {
      const log = require('../lib/logger');
      log.warn('followers', 'NEW_AUCTION enqueue failed', { auctionId, error: err.message });
    });

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

// POST /api/admin/payments/:paymentId/refund
// Full or partial refund of a paid payment. Admin-only.
// Body: { refund_amount_cents: number }
router.post('/payments/:paymentId/refund', auth, role(['admin']), async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const { refund_amount_cents } = req.body;

    if (refund_amount_cents == null || typeof refund_amount_cents !== 'number' || refund_amount_cents <= 0) {
      return res.status(400).json({
        success: false,
        message: 'refund_amount_cents is required and must be a positive number',
      });
    }

    const result = await paymentService.processRefund(req.user.id, paymentId, refund_amount_cents);
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.message === 'Payment not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (
      err.message.startsWith('Cannot refund') ||
      err.message.startsWith('Refund amount')
    ) {
      return res.status(422).json({ success: false, message: err.message });
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

// ── GET /api/admin/diagnostics/auctions ──────────────────────────────────────
// Pilot operational visibility: auction states and open lot counts.
router.get('/diagnostics/auctions', auth, role(['admin']), async (req, res, next) => {
  try {
    const [statesRes, openLotsRes, recentRes] = await Promise.all([
      db.query(`SELECT state, COUNT(*)::int AS count FROM auctions GROUP BY state ORDER BY state`),
      db.query(`SELECT COUNT(*)::int AS count FROM lots WHERE state = 'open'`),
      db.query(`
        SELECT a.id, a.title, a.state, a.created_at,
               COUNT(l.id)::int AS lot_count
          FROM auctions a
          LEFT JOIN lots l ON l.auction_id = a.id
         GROUP BY a.id
         ORDER BY a.created_at DESC
         LIMIT 15
      `),
    ]);
    return res.json({
      success: true,
      data: {
        auction_states:  statesRes.rows,
        open_lots:       openLotsRes.rows[0].count,
        recent_auctions: recentRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/diagnostics/payments ──────────────────────────────────────
// Pilot operational visibility: payment statuses and recent activity.
router.get('/diagnostics/payments', auth, role(['admin']), async (req, res, next) => {
  try {
    const [statusRes, recentRes] = await Promise.all([
      db.query(`SELECT status, COUNT(*)::int AS count FROM payments GROUP BY status ORDER BY status`),
      db.query(`
        SELECT p.id, p.amount_cents, p.status, p.created_at,
               l.title AS lot_title
          FROM payments p
          LEFT JOIN lots l ON l.id = p.lot_id
         ORDER BY p.created_at DESC
         LIMIT 15
      `),
    ]);
    return res.json({
      success: true,
      data: {
        by_status:       statusRes.rows,
        recent_payments: recentRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/diagnostics/notifications ──────────────────────────────────
// Pilot operational visibility: notification delivery status and queue depth.
router.get('/diagnostics/notifications', auth, role(['admin']), async (req, res, next) => {
  try {
    const [statusRes, queueRes, recentRes] = await Promise.all([
      db.query(`SELECT status, COUNT(*)::int AS count FROM notifications GROUP BY status ORDER BY status`),
      db.query(`SELECT COUNT(*)::int AS count FROM notifications_queue`),
      db.query(`
        SELECT id, notification_type, channel, status, sent_at, failed_reason, retry_count, created_at
          FROM notifications
         ORDER BY created_at DESC
         LIMIT 10
      `),
    ]);
    return res.json({
      success: true,
      data: {
        by_status:            statusRes.rows,
        queue_depth:          queueRes.rows[0].count,
        recent_notifications: recentRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
