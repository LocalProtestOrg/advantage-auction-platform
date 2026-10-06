'use strict';

/**
 * /api/auction-partner — the invitation-only acceptance path for the Advantage.Bid Auction Partner Program.
 *   GET  /invite/:token         public: the invitation (company, program, Seller Agreement + Addendum text)
 *   POST /invite/:token/accept  signed-in professional seller: bind the invitation, issue the agreements to sign
 *   GET  /status                signed-in seller: Seller Agreement / Addendum / verification / activation checklist
 * Signing itself is the existing authenticated flow (/sign-agreement.html → POST /api/agreements/:id/sign).
 * Nothing here applies a fee; staff activate the partner after reviewing the signed addendum and verification.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const db = require('../db');
const ap = require('../services/auctionPartnerAgreementService');

const send = (res, e, next) => {
  if (e && e.status && e.code) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
  return next(e);
};

router.get('/invite/:token', async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store'); return res.json({ success: true, data: await ap.publicView(req.params.token) }); }
  catch (e) { return send(res, e, next); }
});

router.post('/invite/:token/accept', auth, async (req, res, next) => {
  try { return res.json({ success: true, data: await ap.accept(req.params.token, { userId: req.user.id }) }); }
  catch (e) { return send(res, e, next); }
});

router.get('/status', auth, async (req, res, next) => {
  try {
    const sp = (await db.query('SELECT id FROM seller_profiles WHERE user_id = $1', [req.user.id])).rows[0];
    if (!sp) return res.json({ success: true, data: { program: ap.PROGRAM_NAME, is_seller: false } });
    return res.json({ success: true, data: Object.assign({ is_seller: true }, await ap.statusFor(sp.id)) });
  } catch (e) { return send(res, e, next); }
});

module.exports = router;
