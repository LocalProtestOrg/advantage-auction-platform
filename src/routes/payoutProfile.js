'use strict';

/**
 * Seller Payout Profile routes (Increment 5). Access control:
 *   - A seller may read + edit ONLY their own profile (/me uses req.user.id).
 *   - An admin may READ payout readiness (/seller/:id) but CANNOT edit seller banking.
 * Every response is the masked summary — confidential banking data is never returned.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const svc = require('../services/payoutProfileService');
const { maskedPayoutSummary, payoutProfileStatus } = require('../lib/payoutProfile');

function serialize(pref) {
  return {
    profile: maskedPayoutSummary(pref),
    status: payoutProfileStatus(pref),
    tax_status: (pref && pref.tax_status) || 'not_started',
    setup_completed_at: (pref && pref.setup_completed_at) || null,
  };
}

// Seller reads their OWN profile (masked).
router.get('/me', auth, role(['seller']), async (req, res, next) => {
  try { res.json({ success: true, data: serialize(await svc.getProfile(req.user.id)) }); }
  catch (err) { next(err); }
});

// Seller saves their OWN check details. (ACH uses the Stripe SetupIntent endpoints below.)
router.put('/me', auth, role(['seller']), async (req, res, next) => {
  try {
    const method = (req.body || {}).payout_method;
    if (method !== 'check') {
      return res.status(422).json({ success: false, message: "payout_method must be 'check' here; use the ACH setup endpoints for ACH." });
    }
    const pref = await svc.saveCheckProfile(req.user.id, req.body);
    res.json({ success: true, data: serialize(pref) });
  } catch (err) {
    if (/required|Invalid/i.test(err.message)) return res.status(422).json({ success: false, message: err.message });
    next(err);
  }
});

// ACH via Stripe (current flow: SetupIntent + us_bank_account / Financial Connections).
// Step 1: seller starts ACH setup — server returns a SetupIntent client_secret.
router.post('/me/ach/setup-intent', auth, role(['seller']), async (req, res, next) => {
  try { res.json({ success: true, data: await svc.createAchSetupIntent(req.user.id) }); }
  catch (err) { if (/configured/i.test(err.message)) return res.status(503).json({ success: false, message: 'Bank connection is temporarily unavailable.' }); next(err); }
});
// Step 2: after Stripe.js completes collection/confirmation, seller confirms — server
// retrieves the SetupIntent and stores only the Stripe reference + safe display.
router.post('/me/ach/confirm', auth, role(['seller']), async (req, res, next) => {
  try { res.json({ success: true, data: serialize(await svc.confirmAchSetupIntent(req.user.id, (req.body || {}).setup_intent_id)) }); }
  catch (err) {
    if (/required|No US bank|does not belong/i.test(err.message)) return res.status(422).json({ success: false, message: err.message });
    next(err);
  }
});

// Seller sets the future tax placeholder status (no functional impact today).
router.put('/me/tax-status', auth, role(['seller']), async (req, res, next) => {
  try { res.json({ success: true, data: serialize(await svc.setTaxStatus(req.user.id, (req.body || {}).tax_status)) }); }
  catch (err) {
    if (/Invalid/i.test(err.message)) return res.status(422).json({ success: false, message: err.message });
    next(err);
  }
});

// Admin reads a seller's payout READINESS (masked, READ-ONLY). No admin edit path exists.
router.get('/seller/:sellerId', auth, role(['admin']), async (req, res, next) => {
  try { res.json({ success: true, data: serialize(await svc.getProfile(req.params.sellerId)) }); }
  catch (err) { next(err); }
});

module.exports = router;
