const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const db = require('../db');

// GET /api/sellers/me
// Returns the seller profile for the authenticated user.
router.get('/me', auth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, user_id FROM seller_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: 'Seller profile not found' });
    }
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/sellers/me/dashboard
// Returns all auctions for the authenticated seller with aggregated marketing metrics.
router.get('/me/dashboard', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         a.id,
         a.title,
         a.state,
         a.end_time,
         a.created_at,
         mj.package_type,
         mj.status           AS marketing_status,
         COALESCE(mj.views_count,        0) AS views_count,
         COALESCE(mj.clicks_count,       0) AS clicks_count,
         COALESCE(mj.reach_count,        0) AS reach_count,
         COALESCE(mj.watchlist_adds,     0) AS watchlist_adds,
         COALESCE(mj.bidder_conversions, 0) AS bidder_conversions
       FROM auctions a
       JOIN seller_profiles sp ON sp.id = a.seller_id
       LEFT JOIN LATERAL (
         SELECT package_type, status, views_count, clicks_count,
                reach_count, watchlist_adds, bidder_conversions
         FROM marketing_jobs
         WHERE auction_id = a.id
         ORDER BY created_at DESC
         LIMIT 1
       ) mj ON true
       WHERE sp.user_id = $1
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );

    const summary = {
      active_count:           rows.filter(r => r.state === 'published').length,
      closed_count:           rows.filter(r => r.state === 'closed').length,
      total_views:            rows.reduce((s, r) => s + Number(r.views_count), 0),
      total_clicks:           rows.reduce((s, r) => s + Number(r.clicks_count), 0),
      total_watchlist_adds:   rows.reduce((s, r) => s + Number(r.watchlist_adds), 0),
      total_bidder_conversions: rows.reduce((s, r) => s + Number(r.bidder_conversions), 0),
    };

    return res.json({ success: true, data: { summary, auctions: rows } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
