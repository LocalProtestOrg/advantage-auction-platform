'use strict';

/**
 * /api/pricing-agreements — SELLER-facing view + acceptance of a negotiated pricing agreement.
 *
 * Acceptance is JWT-authenticated and the accepting user_id is SERVER-derived (never client-asserted); the
 * service additionally verifies the user owns the agreement's seller_profile, so a seller can never accept
 * or view another company's agreement. Sellers can NEVER modify pricing — they can only accept what was
 * issued to them, and view their executed agreement later.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const db = require('../db');
const svc = require('../services/sellerPricingAgreementService');

// Resolve the authenticated user's own seller_profile_id (or null).
async function myProfileId(userId) {
  const r = await db.query(`SELECT id FROM seller_profiles WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`, [userId]);
  return r.rows[0] ? r.rows[0].id : null;
}

// The seller's current pricing picture: standard, current executed agreement, any pending offer.
router.get('/mine', auth, async (req, res, next) => {
  try {
    const pid = await myProfileId(req.user.id);
    if (!pid) return res.json({ success: true, data: { seller_profile: null, standard: await svc.standardPricing(), current_agreement: null, pending_agreement: null } });
    const view = await svc.getSellerView(pid);
    return res.json({ success: true, data: { seller_profile: pid, ...view } });
  } catch (err) { next(err); }
});

// Full history for the seller's own record (read-only).
router.get('/mine/history', auth, async (req, res, next) => {
  try {
    const pid = await myProfileId(req.user.id);
    if (!pid) return res.json({ success: true, data: [] });
    return res.json({ success: true, data: await svc.listForSeller(pid) });
  } catch (err) { next(err); }
});

// Accept a pending agreement. Ownership + status verified server-side; audited.
router.post('/:id/accept', auth, async (req, res, next) => {
  try {
    const out = await svc.accept(req.params.id, {
      userId: req.user.id,
      ip: req.headers['x-forwarded-for'] || req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    });
    return res.json({ success: true, data: out });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    next(err);
  }
});

module.exports = router;
