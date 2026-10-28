'use strict';

/**
 * /api/admin/storefront — Professional Storefront moderation (milestone 2). Requires the 'marketplace.moderate' staff
 * permission (Super Admin only unless granted). Listing takedown/restore and report review need a written reason that is
 * kept permanently; order issues are resolved here too (optionally releasing the payout hold the issue placed); item
 * messages held for review are released or declined here (milestone Q).
 */
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const moderation = require('../services/marketplaceModerationService');
const issues = require('../services/marketplaceOrderIssueService');

router.use(authMiddleware, requirePermission('marketplace.moderate'));
const fail = (res, e, next) => (e && e.status ? res.status(e.status).json({ success: false, code: e.code, message: e.message }) : next(e));
const h = (fn) => async (req, res, next) => { try { return res.json({ success: true, data: await fn(req) }); } catch (e) { return fail(res, e, next); } };

router.get('/items', h((req) => moderation.listItemsForAdmin(req.query || {})));
router.get('/items/:id/history', async (req, res, next) => {
  try {
    const rows = await moderation.itemHistory(req.params.id);
    if (!rows) return res.status(404).json({ success: false, message: 'Listing not found.' });
    return res.json({ success: true, data: rows });
  } catch (e) { return fail(res, e, next); }
});
router.post('/items/:id/takedown', h((req) => moderation.takedown(req.params.id, req.user.id, { reason: (req.body || {}).reason })));
router.post('/items/:id/restore', h((req) => moderation.restore(req.params.id, req.user.id, { reason: (req.body || {}).reason })));
router.post('/items/:id/correct-sold', h((req) => moderation.correctSold(req.params.id, req.user.id, { reason: (req.body || {}).reason })));
router.get('/reports', h((req) => moderation.listReports({ status: req.query.status })));
// Seller store policies: review and, with a written reason, withdraw a published policy from public view (text kept).
router.get('/policies', h((req) => require('../services/sellerPolicyService').listPublishedForAdmin(req.query || {})));
router.post('/policies/:id/withdraw', h((req) => require('../services/sellerPolicyService').withdraw(req.params.id, req.user.id, { reason: (req.body || {}).reason })));
router.post('/reports/:id/review', h((req) => moderation.reviewReport(req.params.id, req.user.id, { action: (req.body || {}).action, note: (req.body || {}).note })));
// Item messages held by the safety rules (milestone Q). Every conversation shown or opened here is written to the access log.
router.get('/messages', h((req) => require('../services/storefrontMessagingService').listForReview({ status: req.query.status }, req.user.id)));
router.get('/conversations/:id', async (req, res, next) => {
  try {
    const c = await require('../services/storefrontMessagingService').conversationForReview(req.params.id, req.user.id);
    if (!c) return res.status(404).json({ success: false, message: 'Conversation not found.' });
    return res.json({ success: true, data: c });
  } catch (e) { return fail(res, e, next); }
});
router.post('/messages/:id/review', h((req) => require('../services/storefrontMessagingService').review(req.params.id, req.user.id,
  { decision: (req.body || {}).decision, note: (req.body || {}).note })));
router.post('/messages/:id/hide', h((req) => require('../services/storefrontMessagingService').hideMessage(req.params.id, req.user.id, { reason: (req.body || {}).reason })));
router.get('/issues', h((req) => issues.listForAdmin({ status: req.query.status })));
router.post('/issues/:id/resolve', h((req) => {
  const b = req.body || {};
  return issues.resolve(req.params.id, req.user.id, { status: b.status, resolution_note: b.resolution_note, release_hold: b.release_hold === true });
}));

module.exports = router;
