const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../db');
const { getBidsByLot, createBid } = require('../services/bidService');

// ── Ownership helpers (admin bypasses both checks) ───────────────────────────

async function userOwnsAuction(userId, userRole, auctionId) {
  if (userRole === 'admin') return true;
  const { rows } = await db.query(
    `SELECT 1 FROM auctions a
     JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE a.id = $1 AND sp.user_id = $2`,
    [auctionId, userId]
  );
  return rows.length > 0;
}

async function userOwnsLot(userId, userRole, lotId) {
  if (userRole === 'admin') return true;
  const { rows } = await db.query(
    `SELECT 1 FROM lots l
     JOIN auctions a ON a.id = l.auction_id
     JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE l.id = $1 AND sp.user_id = $2`,
    [lotId, userId]
  );
  return rows.length > 0;
}

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
    const lotRes = await db.query('SELECT state FROM lots WHERE id = $1', [req.params.lotId]);
    const lot    = lotRes.rows[0];
    if (!lot)                       return res.status(404).json({ success: false, message: 'Lot not found' });
    if (lot.state === 'withdrawn')  return res.status(403).json({ success: false, message: 'Lot is not open for bidding' });
    if (lot.state !== 'open')       return res.status(422).json({ success: false, message: 'Lot is not accepting bids' });

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
    const { auctionId, title, description, size_category, pickup_category, bid_increment_cents, starting_bid_cents } = req.body;
    const result = await db.query(
      `INSERT INTO lots (auction_id, title, description, size_category, pickup_category, bid_increment_cents, starting_bid_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [auctionId, title, description, size_category || null, pickup_category || null, bid_increment_cents || null, starting_bid_cents || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/auction/:auctionId/seller  (must come before /:auctionId)
// Seller-facing: returns all non-withdrawn lots with first image URL. Auth + ownership required.
router.get('/auction/:auctionId/seller', auth, async (req, res, next) => {
  try {
    if (!await userOwnsAuction(req.user.id, req.user.role, req.params.auctionId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const result = await db.query(
      `SELECT l.*,
         (SELECT image_url FROM lot_images WHERE lot_id = l.id ORDER BY sort_order ASC LIMIT 1) AS first_image_url
       FROM lots l
       WHERE l.auction_id = $1
         AND l.state != 'withdrawn'
       ORDER BY l.created_at ASC`,
      [req.params.auctionId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/auction/:auctionId  (must come before /:lotId)
// Withdrawn lots are excluded — this endpoint is buyer-facing and public.
router.get('/auction/:auctionId', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT * FROM lots
       WHERE auction_id = $1
         AND state != 'withdrawn'
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

// DELETE /api/lots/:lotId  (soft delete — ownership + zero-bid guard)
router.delete('/:lotId', auth, async (req, res, next) => {
  try {
    if (!await userOwnsLot(req.user.id, req.user.role, req.params.lotId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const check = await db.query('SELECT bid_count FROM lots WHERE id = $1', [req.params.lotId]);
    if (!check.rows[0]) return res.status(404).json({ success: false, message: 'Lot not found' });
    if (check.rows[0].bid_count > 0) {
      return res.status(409).json({ success: false, message: 'Cannot remove a lot that has received bids' });
    }
    await db.query(
      `UPDATE lots SET is_withdrawn = true, state = 'withdrawn', updated_at = NOW() WHERE id = $1`,
      [req.params.lotId]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/lots/:lotId
router.put('/:lotId', auth, async (req, res, next) => {
  try {
    if (!await userOwnsLot(req.user.id, req.user.role, req.params.lotId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const { title, description, size_category, pickup_category, bid_increment_cents, starting_bid_cents } = req.body;
    const result = await db.query(
      `UPDATE lots
       SET title = $1, description = $2, size_category = $3, pickup_category = $4,
           bid_increment_cents = $5, starting_bid_cents = $6, updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [title, description, size_category || null, pickup_category || null,
       bid_increment_cents || null, starting_bid_cents || null, req.params.lotId]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/:lotId
// Withdrawn lots return 404 — this endpoint is buyer-facing and public.
router.get('/:lotId', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT * FROM lots WHERE id = $1`,
      [req.params.lotId]
    );
    const lot = result.rows[0] || null;
    if (!lot || lot.state === 'withdrawn') {
      return res.status(404).json({ success: false, message: 'Lot not found' });
    }
    res.json({ success: true, data: lot });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
