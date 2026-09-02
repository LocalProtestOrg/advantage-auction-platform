'use strict';

/**
 * /api/admin/compliance — Admin-only auction compliance review (decision-support). Surfaces recent
 * Professional auctions + their compliance flags, and records audited review/moderation outcomes. All
 * data here is INTERNAL moderation information — never exposed on public/seller/widget surfaces.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const { asyncRoute } = require('../utils/apiError');
const compliance = require('../services/complianceService');

router.use(authMiddleware, roleMiddleware(['admin']));

// GET /api/admin/compliance/auctions?filter=all|needs_review|flagged|reviewed&limit=
router.get('/auctions', asyncRoute(async (req, res) => {
  const list = await compliance.recentProfessionalAuctions({ filter: req.query.filter, limit: req.query.limit });
  res.json({ success: true, filter: req.query.filter || 'all', auctions: list });
}));

// GET /api/admin/compliance/auctions/:auctionId — flags detail for one auction.
router.get('/auctions/:auctionId', asyncRoute(async (req, res) => {
  const d = await compliance.getAuctionFlags(req.params.auctionId);
  if (!d) return res.status(404).json({ success: false, message: 'Auction not found' });
  res.json({ success: true, ...d });
}));

// POST /api/admin/compliance/auctions/:auctionId/rescan — re-run the screening engine.
router.post('/auctions/:auctionId/rescan', asyncRoute(async (req, res) => {
  const r = await compliance.scanAuction(req.params.auctionId);
  res.json({ success: !!r.ok, result: r });
}));

// POST /api/admin/compliance/flags/:flagId/review — record a review outcome (cleared / reviewed_allowed / etc.).
router.post('/flags/:flagId/review', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const out = await compliance.reviewFlag(req.user.id, req.params.flagId, { status: b.status, notes: b.notes });
  res.json({ success: true, flag: out });
}));

// POST /api/admin/compliance/lots/:lotId/withdraw — remove a single lot (reuses lots.state='withdrawn').
router.post('/lots/:lotId/withdraw', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const out = await compliance.withdrawLot(req.user.id, req.params.lotId, { flagId: b.flag_id, notes: b.notes });
  res.json({ success: true, lot: out });
}));

// POST /api/admin/compliance/auctions/:auctionId/unpublish — unpublish the whole auction (state→draft).
router.post('/auctions/:auctionId/unpublish', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const out = await compliance.unpublishAuction(req.user.id, req.params.auctionId, { notes: b.notes });
  res.json({ success: true, auction: out });
}));

module.exports = router;
