const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const marketingService = require('../services/marketingService');

// GET /api/marketing/auctions/:auctionId/package
// Returns the most recent marketing job for this auction, or null if none.
// Sellers may only view packages for auctions they own.
router.get('/auctions/:auctionId/package', auth, role(['seller', 'admin']), async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      const { rows } = await db.query(
        `SELECT 1 FROM auctions a
         JOIN seller_profiles sp ON sp.id = a.seller_id
         WHERE a.id = $1 AND sp.user_id = $2`,
        [req.params.auctionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: 'Auction not found' });
    }
    const job = await marketingService.getMarketingJobForAuction(req.params.auctionId);
    return res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketing/auctions/:auctionId/package
// Seller selects a marketing package for their auction — creates a marketing_job record.
router.post('/auctions/:auctionId/package', auth, role(['seller', 'admin']), async (req, res, next) => {
  try {
    const { auctionId } = req.params;
    const { package_type, budget, target_radius_miles } = req.body;

    const job = await marketingService.createMarketingJob(
      req.user.id,
      auctionId,
      { package_type, budget, target_radius_miles },
      req.user.role === 'admin'
    );

    return res.status(201).json({ success: true, data: job });
  } catch (err) {
    if (err.message === 'Auction not found' || err.message === 'Auction not found or not owned by seller') {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (err.message === 'package_type is required') {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

module.exports = router;
