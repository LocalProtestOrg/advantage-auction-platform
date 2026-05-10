const express = require('express');
const router  = express.Router();

const auctionService            = require('../services/auctionService');
const lotService                = require('../services/lotService');
const authMiddleware            = require('../middleware/authMiddleware');
const { generateAuctionReport } = require('../services/reportingService');
const { buildReportPdf }        = require('../services/pdfGenerationService');
const db                        = require('../db/index');

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// ── GET /  — Public auction list (non-draft auctions) ───────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, title, state, start_time, end_time
       FROM auctions
       WHERE state != 'draft'
       ORDER BY end_time DESC NULLS LAST`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /  — Create auction ─────────────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { sellerProfileId, title, description, state, startTime, endTime } = req.body;

    if (!sellerProfileId || !title) {
      return res.status(400).json({ success: false, message: 'sellerProfileId and title are required' });
    }

    // Verify the seller profile belongs to the authenticated user
    const spRes = await db.query(
      'SELECT id FROM seller_profiles WHERE id = $1 AND user_id = $2',
      [sellerProfileId, req.user.id]
    );
    if (!spRes.rows[0]) {
      return res.status(403).json({ success: false, message: 'Seller profile not found or not authorized' });
    }

    const auction = await auctionService.createAuction({
      sellerId:    sellerProfileId,
      title,
      description,
      state:       state || 'draft',
      startTime,
      endTime,
    });

    return res.status(201).json({ success: true, data: auction });
  } catch (err) {
    console.error('[auctions] createAuction failed:', { userId: req.user.id, error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /my  — Seller's own auctions ────────────────────────────────────────
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const auctions = await auctionService.getSellerAuctions(req.user.id);
    return res.json({ success: true, data: auctions });
  } catch (err) {
    console.error('[auctions] getSellerAuctions failed:', { userId: req.user.id, error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:auctionId/report/pdf  — Download PDF report ───────────────────────
router.get('/:auctionId/report/pdf', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const { buffer } = await buildReportPdf(auctionId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="auction-report-${auctionId}.pdf"`);
    return res.send(buffer);
  } catch (err) {
    if (err.message === 'Auction not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    console.error('PDF Report Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:auctionId/report  — JSON report ───────────────────────────────────
router.get('/:auctionId/report', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const report = await generateAuctionReport(auctionId);
    return res.json({ success: true, data: report });
  } catch (err) {
    if (err.message === 'Auction not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    console.error('Report Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /:auctionId/lots  — Add lot to auction ──────────────────────────────
router.post('/:auctionId/lots', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const { title, description, starting_price, pickup_category, category } = req.body;
    let lot;
    if (req.user.role === 'admin') {
      lot = await lotService.adminCreateLot(auctionId, { title, description, startingPrice: starting_price, pickupCategory: pickup_category, category });
    } else {
      lot = await lotService.createLot(auctionId, req.user.id, { title, description, startingPrice: starting_price, pickupCategory: pickup_category, category });
    }
    return res.status(201).json({ success: true, data: lot });
  } catch (err) {
    const status = err.message === 'Unauthorized or auction not found' ? 403 : 400;
    return res.status(status).json({ success: false, message: err.message });
  }
});

// ── GET /:auctionId/summary  — Public auction summary (buyer-facing) ─────────
// Returns minimal public info including seller_id and follower count.
// No auth required — safe to call from unauthenticated buyer pages.
router.get('/:auctionId/summary', async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const { rows } = await db.query(
      `SELECT a.id, a.title, a.state, a.seller_id,
              COUNT(sf.id)::int AS follower_count
         FROM auctions a
         LEFT JOIN seller_followers sf ON sf.seller_id = a.seller_id
        WHERE a.id = $1
        GROUP BY a.id, a.title, a.state, a.seller_id`,
      [auctionId]
    );
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: 'Auction not found' });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[auctions] summary error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:auctionId  — Single auction (seller-owned) ────────────────────────
router.get('/:auctionId', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const auction = await auctionService.getAuctionById(auctionId, req.user.id);
    if (!auction) {
      return res.status(404).json({ success: false, message: 'Auction not found' });
    }
    return res.json({ success: true, data: auction });
  } catch (err) {
    console.error('Get Auction Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /:auctionId  — Update auction fields ───────────────────────────────
router.patch('/:auctionId', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const updated = await auctionService.updateAuction(auctionId, req.user.id, req.body);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'No valid fields or auction not found' });
    }
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('Update Auction Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /:auctionId  — Delete auction ─────────────────────────────────────
router.delete('/:auctionId', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const deleted = await auctionService.deleteAuction(auctionId, req.user.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Auction not found or not owned by user' });
    }
    return res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('Delete Auction Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
