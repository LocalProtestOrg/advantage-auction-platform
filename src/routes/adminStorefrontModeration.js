'use strict';

/**
 * /api/admin/storefront — Professional Storefront moderation (milestone 2). Requires the 'marketplace.moderate' staff
 * permission (Super Admin only unless granted). Listing takedown/restore and report review need a written reason that is
 * kept permanently; order issues are resolved here too (optionally releasing the payout hold the issue placed).
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
router.get('/reports', h((req) => moderation.listReports({ status: req.query.status })));
router.post('/reports/:id/review', h((req) => moderation.reviewReport(req.params.id, req.user.id, { action: (req.body || {}).action, note: (req.body || {}).note })));
router.get('/issues', h((req) => issues.listForAdmin({ status: req.query.status })));
router.post('/issues/:id/resolve', h((req) => {
  const b = req.body || {};
  return issues.resolve(req.params.id, req.user.id, { status: b.status, resolution_note: b.resolution_note, release_hold: b.release_hold === true });
}));

module.exports = router;
