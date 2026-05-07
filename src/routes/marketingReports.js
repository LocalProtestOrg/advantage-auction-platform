const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const marketingReportService = require('../services/marketingReportService');

// GET /api/seller/marketing-report/:auctionId
// Returns the marketing performance report for a seller's auction.
// Sellers may only retrieve reports for auctions they own; admins may access any.
router.get('/:auctionId', auth, role(['seller', 'admin']), async (req, res, next) => {
  try {
    const { auctionId } = req.params;

    // Verify ownership for non-admins; fetch title in the same query to avoid a second round-trip
    let auctionTitle = null;
    if (req.user.role !== 'admin') {
      const { rows } = await db.query(
        `SELECT a.id, a.title FROM auctions a
         JOIN seller_profiles sp ON sp.id = a.seller_id
         WHERE a.id = $1 AND sp.user_id = $2`,
        [auctionId, req.user.id]
      );
      if (!rows[0]) {
        return res.status(403).json({ success: false, message: 'Auction not found or not owned by seller' });
      }
      auctionTitle = rows[0].title;
    } else {
      const { rows } = await db.query('SELECT title FROM auctions WHERE id = $1', [auctionId]);
      auctionTitle = rows[0]?.title ?? null;
    }

    const job = await marketingReportService.getMarketingJobByAuctionId(auctionId);

    if (!job) {
      return res.status(404).json({ success: false, message: 'No marketing job found for this auction' });
    }

    return res.json({
      success: true,
      data: {
        auction_title:       auctionTitle,
        package_type:        job.package_type,
        status:              job.status,
        views_count:         job.views_count,
        clicks_count:        job.clicks_count,
        reach_count:         job.reach_count,
        watchlist_adds:      job.watchlist_adds,
        bidder_conversions:  job.bidder_conversions,
        target_radius_miles: job.target_radius_miles,
        campaign_created_at: job.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
