'use strict';

/**
 * Seller Settlement (Financial Center) routes (Increment 7). Seller-only; a seller can
 * read ONLY their own settlements (scoped by req.user.id; the detail is ownership-guarded
 * in the service and returns 404 for anything not owned). Responses are seller-safe only.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const svc = require('../services/sellerSettlementService');

// Financial summary + settlement history for the signed-in seller.
router.get('/me', auth, role(['seller']), async (req, res, next) => {
  try { res.json({ success: true, data: await svc.listSettlements(req.user.id) }); }
  catch (err) { next(err); }
});

// Storefront (fixed-price) payouts for the signed-in seller's own company (migration 213). Declared before /me/:auctionId.
router.get('/me/storefront', auth, role(['seller']), async (req, res, next) => {
  try {
    const sp = (await require('../db').query('SELECT id FROM seller_profiles WHERE user_id = $1', [req.user.id])).rows[0];
    res.json({ success: true, data: sp ? await require('../services/storefrontSettlementService').listForSeller(sp.id) : [] });
  } catch (err) { next(err); }
});

// Detailed statement for one of the seller's own auctions.
router.get('/me/:auctionId', auth, role(['seller']), async (req, res, next) => {
  try {
    const data = await svc.getDetail(req.user.id, req.params.auctionId);
    if (!data) return res.status(404).json({ success: false, message: 'Settlement not found' });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

module.exports = router;
