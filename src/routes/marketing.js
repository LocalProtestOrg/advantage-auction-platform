const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const marketingService = require('../services/marketingService');
const marketingEligibilityService = require('../services/marketingEligibilityService');

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

// GET /api/marketing/auctions/:auctionId/packages
// Server-authoritative list of purchasable marketing packages for THIS auction right now. Enforces the
// 48-hour cutoff + the clothing/apparel >50% rule so a stale UI cannot present a package that isn't
// actually purchasable. Returns available:false + a neutral seller-facing message (no internal economics)
// with an empty package list when unavailable.
router.get('/auctions/:auctionId/packages', auth, role(['seller', 'admin']), async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      const owns = await db.query(
        `SELECT 1 FROM auctions a JOIN seller_profiles sp ON sp.id = a.seller_id WHERE a.id = $1 AND sp.user_id = $2`,
        [req.params.auctionId, req.user.id]);
      if (!owns.rows.length) return res.status(404).json({ success: false, message: 'Auction not found' });
    }
    const e = await marketingEligibilityService.evaluateAuction(req.params.auctionId);
    const SELLER_MESSAGE = {
      ok: null,
      past_cutoff: 'Marketing packages are available until 48 hours before the auction closes.',
      too_much_clothing: "Marketing packages aren't available for auctions where more than half of the catalog is clothing/apparel.",
      no_close_time: 'Marketing packages become available once your auction has a scheduled close time.',
      no_lots: 'Add lots to your auction to see marketing options.',
      auction_not_found: 'Auction not found',
    };
    if (!e.available) {
      return res.json({ success: true, available: false, message: SELLER_MESSAGE[e.reason] || SELLER_MESSAGE.past_cutoff, packages: [] });
    }
    const { rows } = await db.query(
      `SELECT id, name, description, price_cents, features FROM marketing_packages
        WHERE is_active = true ORDER BY display_order ASC`);
    return res.json({ success: true, available: true, message: null, packages: rows });
  } catch (err) { next(err); }
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
    if (err.code === 'MARKETING_UNAVAILABLE') {
      return res.status(409).json({ success: false, code: err.code, message: err.message });
    }
    next(err);
  }
});

module.exports = router;
