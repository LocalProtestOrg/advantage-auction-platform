const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const db = require('../db');

// GET /api/sellers/me
// Returns the seller profile for the authenticated user. seller_type is
// included so the lot studio frontend can client-side gate fields that are
// only appropriate for business sellers (e.g., reserve pricing). This is a
// stopgap until full capability-based gating lands; private/other sellers
// must not see fields they cannot actually use.
router.get('/me', auth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, user_id, seller_type FROM seller_profiles WHERE user_id = $1',
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

// GET /api/sellers/me/audience
// Returns lightweight audience summary for the authenticated seller.
// Combines follower metrics and active-lot watcher counts in three parallel queries.
router.get('/me/audience', auth, async (req, res, next) => {
  try {
    const spRes = await db.query(
      'SELECT id FROM seller_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (!spRes.rows[0]) {
      return res.status(404).json({ success: false, message: 'Seller profile not found' });
    }
    const sellerId = spRes.rows[0].id;

    const [follRes, watchRes, lotsRes] = await Promise.all([
      // Followers total + 7-day growth in one pass
      db.query(
        `SELECT COUNT(*)::int AS followers_total,
                COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END)::int AS followers_7d
           FROM seller_followers
          WHERE seller_id = $1`,
        [sellerId]
      ),
      // Unique buyers watching any open lot across the seller's live auctions
      db.query(
        `SELECT COUNT(DISTINCT w.user_id)::int AS count
           FROM watchlists w
           JOIN lots l    ON l.id    = w.lot_id
           JOIN auctions a ON a.id   = l.auction_id
          WHERE a.seller_id = $1
            AND l.state      = 'open'
            AND a.state      IN ('published', 'active')`,
        [sellerId]
      ),
      // Open lots in live auctions
      db.query(
        `SELECT COUNT(*)::int AS count
           FROM lots l
           JOIN auctions a ON a.id = l.auction_id
          WHERE a.seller_id = $1
            AND l.state      = 'open'
            AND a.state      IN ('published', 'active')`,
        [sellerId]
      ),
    ]);

    return res.json({
      success: true,
      data: {
        followers_total:  follRes.rows[0].followers_total,
        followers_7d:     follRes.rows[0].followers_7d,
        active_watchers:  watchRes.rows[0].count,
        active_lot_count: lotsRes.rows[0].count,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Seller Followers ──────────────────────────────────────────────────────────
// GET /api/sellers/following — list sellers the authenticated buyer follows.
// Must be declared before /:sellerId routes to avoid "following" matching as a param.
router.get('/following', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT sf.seller_id,
              sf.created_at AS followed_at,
              u.email       AS seller_email,
              sp.seller_type,
              COUNT(a.id)::int AS active_auction_count
         FROM seller_followers sf
         JOIN seller_profiles sp ON sp.id = sf.seller_id
         JOIN users u             ON u.id  = sp.user_id
         LEFT JOIN auctions a     ON a.seller_id = sp.id
                                 AND a.state IN ('published', 'active')
        WHERE sf.user_id = $1
        GROUP BY sf.seller_id, sf.created_at, u.email, sp.seller_type
        ORDER BY sf.created_at DESC`,
      [req.user.id]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/sellers/:sellerId/followers/count — public; follower count for a seller.
router.get('/:sellerId/followers/count', async (req, res, next) => {
  try {
    const { sellerId } = req.params;
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM seller_followers WHERE seller_id = $1`,
      [sellerId]
    );
    return res.json({ success: true, data: { seller_id: sellerId, count: rows[0].count } });
  } catch (err) {
    next(err);
  }
});

// POST /api/sellers/:sellerId/follow — buyer follows a seller. Idempotent.
router.post('/:sellerId/follow', auth, async (req, res, next) => {
  try {
    const { sellerId } = req.params;

    // Verify the seller profile exists before inserting.
    const check = await db.query(
      'SELECT id FROM seller_profiles WHERE id = $1',
      [sellerId]
    );
    if (!check.rows[0]) {
      return res.status(404).json({ success: false, message: 'Seller not found' });
    }

    await db.query(
      `INSERT INTO seller_followers (user_id, seller_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, seller_id) DO NOTHING`,
      [req.user.id, sellerId]
    );
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/sellers/:sellerId/follow — buyer unfollows a seller. Idempotent.
router.delete('/:sellerId/follow', auth, async (req, res, next) => {
  try {
    const { sellerId } = req.params;
    await db.query(
      `DELETE FROM seller_followers WHERE user_id = $1 AND seller_id = $2`,
      [req.user.id, sellerId]
    );
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
