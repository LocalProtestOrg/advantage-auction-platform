const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const marketingService = require('../services/marketingService');

// GET /api/marketing/auctions/:auctionId/package
// Returns the most recent marketing job for this auction, or null if none.
router.get('/auctions/:auctionId/package', auth, role(['seller', 'admin']), async (req, res, next) => {
  try {
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
