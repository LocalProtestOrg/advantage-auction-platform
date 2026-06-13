'use strict';

const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const db      = require('../db');
const { annotateViewerBidState } = require('../lib/viewerBidState'); // #6
const { redactRealizedPrice }    = require('../lib/realizedPrice');  // #20.1

// POST /api/watchlist/add
router.post('/add', auth, async (req, res, next) => {
  try {
    const { lotId } = req.body;
    if (!lotId) return res.status(400).json({ success: false, message: 'lotId required' });

    await db.query(
      `INSERT INTO watchlists (user_id, lot_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, lot_id) DO NOTHING`,
      [req.user.id, lotId]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/watchlist/remove
router.post('/remove', auth, async (req, res, next) => {
  try {
    const { lotId } = req.body;
    if (!lotId) return res.status(400).json({ success: false, message: 'lotId required' });

    await db.query(
      `DELETE FROM watchlists WHERE user_id = $1 AND lot_id = $2`,
      [req.user.id, lotId]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/watchlist — watched lots with enough to monitor + return to them (#6):
// lot #, photo, current bid, close time, and the viewer's own bid status.
router.get('/', auth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.id, l.auction_id, l.lot_number, l.title, l.state,
              l.current_bid_cents, l.winning_amount_cents, l.bid_count,
              l.closes_at, l.extended_until, l.thumbnail_url,
              l.current_winner_user_id, l.winning_buyer_user_id,
              pb.max_amount_cents AS viewer_max,
              w.created_at AS watched_at
       FROM watchlists w
       JOIN lots l ON l.id = w.lot_id
       LEFT JOIN lot_proxy_bids pb ON pb.lot_id = w.lot_id AND pb.bidder_user_id = w.user_id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );
    const data = result.rows.map(r => redactRealizedPrice(annotateViewerBidState(r, req.user.id, r.viewer_max), true));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
