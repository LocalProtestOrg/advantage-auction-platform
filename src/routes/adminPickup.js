'use strict';

/**
 * /api/admin/pickup — admin operations for Buyer-Centric Global Pickup Scheduling. Admin-only.
 * The plan is generated automatically at auction close; these endpoints let staff regenerate
 * (e.g. after refunds/withdrawals), view it, mark a buyer's consolidated pickup complete, and
 * scan for no-shows.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const db = require('../db');
const plan = require('../services/pickupPlanService');
const { asyncRoute, svcErr } = require('../utils/apiError');

router.use(authMiddleware, roleMiddleware(['admin']));

// Regenerate the buyer-centric plan for an auction.
router.post('/:auctionId/generate', asyncRoute(async (req, res) => {
  res.json({ success: true, result: await plan.generatePlanAtClose(req.params.auctionId) });
}));

// View the plan: buyers with their consolidated tier, slot, lots, and status.
router.get('/:auctionId', asyncRoute(async (req, res) => {
  const { rows } = await db.query(
    `SELECT pa.buyer_user_id, u.email, pa.assigned_tier, pa.slot_start, pa.slot_end, pa.pickup_status,
            count(*)::int AS lot_count, min(pa.completed_at) AS completed_at
       FROM pickup_assignments pa
       JOIN pickup_schedules ps ON ps.id = pa.pickup_schedule_id
       LEFT JOIN users u ON u.id = pa.buyer_user_id
      WHERE ps.auction_id = $1
      GROUP BY pa.buyer_user_id, u.email, pa.assigned_tier, pa.slot_start, pa.slot_end, pa.pickup_status
      ORDER BY pa.slot_start ASC NULLS LAST, u.email ASC`, [req.params.auctionId]);
  res.json({ success: true, buyers: rows });
}));

// Mark a buyer's consolidated pickup complete (all their lots for the auction).
router.post('/:auctionId/complete', asyncRoute(async (req, res) => {
  const buyerUserId = (req.body || {}).buyerUserId;
  if (!buyerUserId) throw svcErr(400, 'BUYER_REQUIRED', 'buyerUserId is required.');
  res.json({ success: true, result: await plan.markCompleted(req.user.id, req.params.auctionId, buyerUserId) });
}));

// Scan for no-shows (assignments whose slot ended while still scheduled).
router.post('/scan-missed', asyncRoute(async (req, res) => {
  res.json({ success: true, result: await plan.detectMissed() });
}));

module.exports = router;
