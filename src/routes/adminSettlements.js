'use strict';

/**
 * Admin Settlement Review routes (Increment 6). Admin-only. READ is always available for
 * reconciliation/visibility; every state-changing settlement operation is gated behind
 * SELLER_SETTLEMENTS_ENABLED (a launch safeguard) and returns 409 until settlements are
 * enabled. Banking is never editable here (separation of duties — use the payout profile).
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const review = require('../services/settlementReviewService');
const engine = require('../services/settlementEngine');
const adjustments = require('../services/settlementAdjustmentService');
const { sellerSettlementsEnabled } = require('../lib/launchGuards');

function requireSettlementsEnabled(req, res, next) {
  if (!sellerSettlementsEnabled(process.env)) {
    return res.status(409).json({ success: false, message: 'Seller settlements are not enabled. Review is read-only until settlements are turned on.' });
  }
  next();
}

// READ — the full settlement review (admin; allowed regardless of the flag).
router.get('/:auctionId', auth, role(['admin']), async (req, res, next) => {
  try {
    const data = await review.assembleSettlementReview(req.params.auctionId);
    if (!data) return res.status(404).json({ success: false, message: 'Auction not found' });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// Recalculate (new versioned snapshot).
router.post('/:auctionId/recalculate', auth, role(['admin']), requireSettlementsEnabled, async (req, res, next) => {
  try { res.json({ success: true, data: await engine.recalculateSettlement(req.params.auctionId, req.user.id) }); }
  catch (err) { next(err); }
});

// Add a manual Credit/Debit, then recalculate.
router.post('/:auctionId/adjustments', auth, role(['admin']), requireSettlementsEnabled, async (req, res, next) => {
  try {
    const { type, amount_cents, reason, category = null, notes = null } = req.body || {};
    await adjustments.addAdjustment({ auctionId: req.params.auctionId, type, amountCents: amount_cents, reason, category, notes, actorId: req.user.id });
    res.json({ success: true, data: await engine.recalculateSettlement(req.params.auctionId, req.user.id) });
  } catch (err) {
    if (/invalid|required|positive|immutable/i.test(err.message)) return res.status(422).json({ success: false, message: err.message });
    next(err);
  }
});

// Void an adjustment (kept in history), then recalculate.
router.post('/:auctionId/adjustments/:adjId/void', auth, role(['admin']), requireSettlementsEnabled, async (req, res, next) => {
  try {
    const voided = await adjustments.voidAdjustment({ adjustmentId: req.params.adjId, actorId: req.user.id, voidReason: (req.body || {}).void_reason || null });
    if (!voided) return res.status(404).json({ success: false, message: 'Adjustment not found or already voided' });
    res.json({ success: true, data: await engine.recalculateSettlement(req.params.auctionId, req.user.id) });
  } catch (err) {
    if (/immutable/i.test(err.message)) return res.status(422).json({ success: false, message: err.message });
    next(err);
  }
});

// Mark Paid (records a completed MANUAL payment; freezes the immutable final snapshot).
router.post('/:auctionId/mark-paid', auth, role(['admin']), requireSettlementsEnabled, async (req, res, next) => {
  try {
    const { payment_method, payment_reference, paid_at, payment_note = null, final_amount_cents, confirmed_completed } = req.body || {};
    const result = await engine.markSettlementPaid(req.params.auctionId, {
      paymentMethod: payment_method, paymentReference: payment_reference, paidAt: paid_at, paymentNote: payment_note,
      finalAmountCents: final_amount_cents, confirmedCompleted: confirmed_completed, actorId: req.user.id,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof engine.MarkPaidError) return res.status(422).json({ success: false, message: err.message });
    next(err);
  }
});

module.exports = router;
