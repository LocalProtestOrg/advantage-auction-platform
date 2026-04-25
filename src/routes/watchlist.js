'use strict';

const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const db      = require('../db');

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

// GET /api/watchlist
router.get('/', auth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT w.lot_id, w.created_at,
              l.title, l.status, l.current_bid_cents, l.closes_at
       FROM watchlists w
       JOIN lots l ON l.id = w.lot_id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
