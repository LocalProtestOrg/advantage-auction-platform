const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../db');
const { getBidsByLot, createBid } = require('../services/bidService');

// ── Bid sub-routes (must come before /:lotId to avoid shadowing) ─────────────

// GET /api/lots/:lotId/bids
router.get('/:lotId/bids', authMiddleware, async (req, res) => {
  try {
    const bids = await getBidsByLot(req.params.lotId);
    res.json({ success: true, data: bids });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/lots/:lotId/bids
// Bidding only allowed on active lots — draft and closed lots are rejected.
router.post('/:lotId/bids', authMiddleware, async (req, res) => {
  try {
    const lotRes = await db.query('SELECT status FROM lots WHERE id = $1', [req.params.lotId]);
    const lot    = lotRes.rows[0];
    if (!lot)                    return res.status(404).json({ success: false, message: 'Lot not found' });
    if (lot.status === 'draft')  return res.status(403).json({ success: false, message: 'Lot is not open for bidding' });
    if (lot.status !== 'active') return res.status(422).json({ success: false, message: 'Lot is not accepting bids' });

    const { amount, maxBid, max_bid_cents } = req.body;
    const result = await createBid(req.params.lotId, req.user.id, { amount, maxBid, max_bid_cents });
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// ── Lot CRUD ─────────────────────────────────────────────────────────────────

// POST /api/lots
router.post('/', auth, async (req, res, next) => {
  try {
    const { auctionId, title, description, category, pickup_category, bid_increment_cents } = req.body;
    const result = await db.query(
      `INSERT INTO lots (auction_id, title, description, category, pickup_category, bid_increment_cents)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [auctionId, title, description, category, pickup_category, bid_increment_cents || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/auction/:auctionId  (must come before /:lotId)
// Draft lots are excluded — this endpoint is buyer-facing and public.
router.get('/auction/:auctionId', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT * FROM lots
       WHERE auction_id = $1
         AND status IN ('active', 'sold', 'closed')
       ORDER BY created_at ASC`,
      [req.params.auctionId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ── Image sub-routes (must come before /:lotId to avoid shadowing) ───────────

// POST /api/lots/:lotId/images
router.post('/:lotId/images', auth, async (req, res, next) => {
  try {
    const { images } = req.body;

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, message: 'Images array required' });
    }

    const values = images.map((url, i) => `($1, $${i + 2}, ${i})`).join(',');
    const params = [req.params.lotId, ...images];

    await db.query(
      `INSERT INTO lot_images (lot_id, image_url, sort_order) VALUES ${values}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/:lotId/images
router.get('/:lotId/images', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT * FROM lot_images WHERE lot_id = $1 ORDER BY sort_order ASC`,
      [req.params.lotId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/lots/:lotId
router.put('/:lotId', auth, async (req, res, next) => {
  try {
    const { title, description, category, pickup_category, bid_increment_cents } = req.body;
    const result = await db.query(
      `UPDATE lots
       SET title = $1, description = $2, category = $3, pickup_category = $4,
           bid_increment_cents = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [title, description, category, pickup_category, bid_increment_cents || null, req.params.lotId]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/:lotId
// Draft lots return 404 — this endpoint is buyer-facing and public.
router.get('/:lotId', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT * FROM lots WHERE id = $1`,
      [req.params.lotId]
    );
    const lot = result.rows[0] || null;
    if (!lot || lot.status === 'draft') {
      return res.status(404).json({ success: false, message: 'Lot not found' });
    }
    res.json({ success: true, data: lot });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
