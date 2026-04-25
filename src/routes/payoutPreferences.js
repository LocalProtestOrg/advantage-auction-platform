const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const role    = require('../middleware/roleMiddleware');
const { upsertSellerPayoutPreference, getSellerPayoutPreference } = require('../services/payoutPreferenceService');

// GET /api/payout-preferences/me
// Seller reads their own preference. Admin can read any seller's via the :userId variant below.
router.get('/me', auth, role(['seller', 'admin']), async (req, res, next) => {
  try {
    const pref = await getSellerPayoutPreference(req.user.id);
    return res.json({ success: true, data: pref });
  } catch (err) {
    next(err);
  }
});

// GET /api/payout-preferences/seller/:sellerId  (admin only)
router.get('/seller/:sellerId', auth, role(['admin']), async (req, res, next) => {
  try {
    const pref = await getSellerPayoutPreference(req.params.sellerId);
    return res.json({ success: true, data: pref });
  } catch (err) {
    next(err);
  }
});

// PUT /api/payout-preferences/me
// Seller saves or updates their own payout preference.
router.put('/me', auth, role(['seller', 'admin']), async (req, res, next) => {
  try {
    const pref = await upsertSellerPayoutPreference(req.user.id, req.body);
    return res.json({ success: true, data: pref });
  } catch (err) {
    if (err.message.startsWith('Invalid payout_method')) {
      return res.status(422).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// PUT /api/payout-preferences/seller/:sellerId  (admin only — set on behalf of seller)
router.put('/seller/:sellerId', auth, role(['admin']), async (req, res, next) => {
  try {
    const pref = await upsertSellerPayoutPreference(req.params.sellerId, req.body);
    return res.json({ success: true, data: pref });
  } catch (err) {
    if (err.message.startsWith('Invalid payout_method')) {
      return res.status(422).json({ success: false, message: err.message });
    }
    next(err);
  }
});

module.exports = router;
