'use strict';

/**
 * /api/admin/marketplace — admin-only marketplace visibility controls (Constitution §7).
 * Partners cannot control visibility; only Platform Admins may hide/show/remove/restore/
 * feature/promote. Every action is audited (marketplaceService → audit_log).
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const marketplaceService = require('../services/marketplaceService');
const { asyncRoute } = require('../utils/apiError');

router.use(authMiddleware, roleMiddleware(['admin']));

const visibility = (action) => asyncRoute(async (req, res) => {
  const auction = await marketplaceService.setVisibility(req.user.id, req.params.auctionId, action, (req.body || {}).reason);
  res.json({ success: true, auction });
});
router.post('/:auctionId/hide', visibility('hide'));
router.post('/:auctionId/show', visibility('show'));
router.post('/:auctionId/remove', visibility('remove'));
router.post('/:auctionId/restore', visibility('restore'));

const flag = (f, v) => asyncRoute(async (req, res) => {
  const auction = await marketplaceService.setFlag(req.user.id, req.params.auctionId, f, v);
  res.json({ success: true, auction });
});
router.post('/:auctionId/feature', flag('feature', true));
router.post('/:auctionId/unfeature', flag('feature', false));
router.post('/:auctionId/promote', flag('promote', true));
router.post('/:auctionId/unpromote', flag('promote', false));

module.exports = router;
