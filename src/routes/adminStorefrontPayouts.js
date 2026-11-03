'use strict';

/**
 * /api/admin/storefront-payouts — storefront (fixed-price) seller payouts (migration 213; storefrontSettlementService).
 * Administrators only. Reading is always allowed; preparing, holding, voiding and paying require seller settlements to
 * be switched on, and paying (a transfer to the seller's connected account) also requires Stripe Connect, the same
 * switches as auction settlements (adminSettlements.js).
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const svc = require('../services/storefrontSettlementService');
const { sellerSettlementsEnabled, stripeConnectEnabled } = require('../lib/launchGuards');

router.use(auth, role(['admin']), express.json({ limit: '16kb' }));
const needSettlements = (req, res, next) => (sellerSettlementsEnabled(process.env) ? next()
  : res.status(409).json({ success: false, message: 'Seller settlements are not enabled. Storefront payouts are read-only until settlements are turned on.' }));
const needConnect = (req, res, next) => (stripeConnectEnabled(process.env) ? next()
  : res.status(409).json({ success: false, message: 'Stripe Connect Direct Deposit is not enabled.' }));
const send = (fn) => async (req, res, next) => {
  try { return res.json({ success: true, data: await fn(req) }); }
  catch (e) { if (e && e.status) return res.status(e.status).json({ success: false, code: e.code, message: e.message }); return next(e); }
};

router.get('/', send((req) => svc.listForAdmin({ status: req.query.status || null })));
router.get('/cutoff', send(() => ({ cutoff: svc.cutoffFor().toISOString() })));
router.get('/:id', send((req) => svc.getForAdmin(req.params.id)));
// Prepare now (the weekly worker does this on Thursday; safe to repeat).
router.post('/prepare', needSettlements, send((req) => svc.prepareWeek({ actorId: req.user.id })));
router.post('/:id/hold', needSettlements, send((req) => svc.setHold(req.params.id, req.user.id, { hold: true, reason: (req.body || {}).reason })));
router.post('/:id/release', needSettlements, send((req) => svc.setHold(req.params.id, req.user.id, { hold: false })));
router.post('/:id/void', needSettlements, send((req) => svc.voidPayout(req.params.id, req.user.id, { reason: (req.body || {}).reason })));
router.post('/:id/pay', needSettlements, needConnect, send((req) => svc.payPayout(req.params.id, { actorId: req.user.id,
  confirmedCompleted: (req.body || {}).confirmed_completed === true, finalAmountCents: (req.body || {}).final_amount_cents })));

module.exports = router;
