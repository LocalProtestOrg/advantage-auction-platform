
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const auctionService = require('../services/auctionService');
const paymentService = require('../services/paymentService');
const videoService   = require('../services/walkthroughVideoService');
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

// ── POST /api/admin/email/test ────────────────────────────────────────────────
// Sends a single test email via the configured SMTP transporter.
// Used during pilot readiness validation — confirms SMTP auth and outbound delivery.
// Does NOT queue a notification row or touch the notifications_queue table.
router.post('/email/test', auth, role(['admin']), async (req, res, next) => {
  try {
    const { to } = req.body;
    if (!to || typeof to !== 'string' || !to.includes('@')) {
      return res.status(400).json({ success: false, message: 'to must be a valid email address' });
    }

    const { sendEmail } = require('../services/emailService');
    const result = await sendEmail({
      to,
      subject: 'Advantage Auction — SMTP delivery test',
      html: `
        <p>This is an automated SMTP delivery test from the Advantage Auction Platform.</p>
        <p>If you received this email, outbound delivery is working correctly.</p>
        <ul>
          <li><strong>To:</strong> ${to}</li>
          <li><strong>Sent at:</strong> ${new Date().toISOString()}</li>
          <li><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</li>
        </ul>
        <p>Check email headers for SPF and DKIM pass status.</p>
      `.trim(),
      text: `Advantage Auction SMTP test — sent at ${new Date().toISOString()}. If you received this, outbound delivery is working.`,
    });

    if (result.skipped) {
      return res.status(503).json({
        success: false,
        message: 'SMTP not configured — SMTP_HOST, SMTP_USER, and SMTP_PASS must be set',
        email_configured: false,
      });
    }

    return res.json({
      success: true,
      message: `Test email sent to ${to}`,
      message_id: result.messageId,
      email_configured: true,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/sellers?search=<email>
// Returns matching seller profiles with user email, type, capabilities, and auction count.
router.get('/sellers', auth, role(['admin']), async (req, res, next) => {
  try {
    const search = (req.query.search || '').trim();
    const rows = await db.query(
      `SELECT sp.id              AS seller_profile_id,
              sp.seller_type,
              sp.capabilities,
              sp.created_at      AS profile_created_at,
              u.id               AS user_id,
              u.email,
              u.role,
              u.created_at       AS user_created_at,
              COUNT(a.id)::int   AS auction_count
         FROM seller_profiles sp
         JOIN users u ON u.id = sp.user_id
    LEFT JOIN auctions a ON a.seller_id = sp.id
        WHERE ($1 = '' OR u.email ILIKE $2)
     GROUP BY sp.id, u.id
     ORDER BY sp.created_at DESC
        LIMIT 50`,
      [search, `%${search}%`]
    );
    return res.json({ success: true, data: rows.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payouts?status=<pending|released|all>
// Returns seller_payouts rows with seller email for operational visibility.
router.get('/payouts', auth, role(['admin']), async (req, res, next) => {
  try {
    const status = req.query.status || 'all';
    const validStatuses = ['pending', 'released', 'all'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'status must be pending, released, or all' });
    }

    const rows = await db.query(
      `SELECT sp.id                  AS payout_id,
              sp.auction_id,
              sp.seller_user_id,
              sp.gross_revenue_cents,
              sp.platform_fee_cents,
              sp.seller_payout_cents,
              sp.payout_method,
              sp.payout_status,
              sp.payout_reference,
              sp.created_at,
              sp.updated_at,
              u.email                AS seller_email,
              a.title                AS auction_title
         FROM seller_payouts sp
         JOIN users u ON u.id = sp.seller_user_id
    LEFT JOIN auctions a ON a.id = sp.auction_id
        WHERE ($1 = 'all' OR sp.payout_status = $1)
     ORDER BY sp.created_at DESC
        LIMIT 100`,
      [status]
    );
    return res.json({ success: true, data: rows.rows });
  } catch (err) {
    next(err);
  }
});

// ── Walkthrough video moderation ─────────────────────────────────────────────

// GET /api/admin/videos — all videos with optional ?status=pending_review|approved|rejected
router.get('/videos', auth, role(['admin']), async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const rows = await videoService.listAllVideos(req.query.status, limit);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/admin/videos/pending — moderation queue (oldest first)
router.get('/videos/pending', auth, role(['admin']), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = await videoService.getPendingVideos(limit);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/admin/videos/:videoId/approve
// Sets review_status='approved'. Does NOT auto-publish (visible_public stays false).
router.post('/videos/:videoId/approve', auth, role(['admin']), async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const adminUserId = req.user.id;
    const row = await videoService.approveVideo(videoId, adminUserId);
    if (!row) return res.status(404).json({ success: false, message: 'Video not found' });
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// POST /api/admin/videos/:videoId/reject
// Body: { reason? }
router.post('/videos/:videoId/reject', auth, role(['admin']), async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const { reason } = req.body || {};
    const adminUserId = req.user.id;
    const row = await videoService.rejectVideo(videoId, adminUserId, reason || null);
    if (!row) return res.status(404).json({ success: false, message: 'Video not found' });
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/videos/:videoId/visibility
// Body: { visible: true|false }  — only works after approval
router.patch('/videos/:videoId/visibility', auth, role(['admin']), async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const { visible } = req.body || {};
    if (typeof visible !== 'boolean') {
      return res.status(400).json({ success: false, message: 'visible must be a boolean' });
    }
    const row = await videoService.setPublicVisibility(videoId, visible);
    if (!row) return res.status(404).json({ success: false, message: 'Video not found or not yet approved' });
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/videos/:videoId/featured
// Body: { featured: true|false }  — only works after approval
router.patch('/videos/:videoId/featured', auth, role(['admin']), async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const { featured } = req.body || {};
    if (typeof featured !== 'boolean') {
      return res.status(400).json({ success: false, message: 'featured must be a boolean' });
    }
    const row = await videoService.setFeaturedForMarketing(videoId, featured);
    if (!row) return res.status(404).json({ success: false, message: 'Video not found or not yet approved' });
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/auctions/:auctionId/discovery
// Updates marketplace discovery fields: priority, lat, lng.
// All body fields are optional — only supplied fields are updated.
// Body: { priority?: integer 0–10000, lat?: float, lng?: float }
router.patch('/auctions/:auctionId/discovery', auth, role(['admin']), async (req, res, next) => {
  try {
    const { auctionId } = req.params;
    const { priority, lat, lng } = req.body || {};

    const updates = [];
    const params  = [];

    if (priority !== undefined) {
      if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 10000) {
        return res.status(400).json({ success: false, message: 'priority must be a non-negative integer (0–10000)' });
      }
      params.push(priority);
      updates.push(`marketplace_priority = $${params.length}`);
    }

    if (lat !== undefined) {
      const latF = parseFloat(lat);
      if (isNaN(latF) || latF < -90 || latF > 90) {
        return res.status(400).json({ success: false, message: 'lat must be a number between -90 and 90' });
      }
      params.push(latF);
      updates.push(`lat = $${params.length}`);
    }

    if (lng !== undefined) {
      const lngF = parseFloat(lng);
      if (isNaN(lngF) || lngF < -180 || lngF > 180) {
        return res.status(400).json({ success: false, message: 'lng must be a number between -180 and 180' });
      }
      params.push(lngF);
      updates.push(`lng = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one of priority, lat, lng is required' });
    }

    params.push(auctionId);
    const { rows } = await db.query(
      `UPDATE auctions
          SET ${updates.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING id, title, state, marketplace_priority, lat, lng`,
      params
    );

    if (!rows.length) return res.status(404).json({ success: false, message: 'Auction not found' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

// ── Config sub-router ─────────────────────────────────────────────────────────
// Handles /api/admin/config/platform, /widgets, /packages
// Auth + role enforcement is applied inside adminConfig.js
router.use('/config', require('./adminConfig').router);

module.exports = router;
