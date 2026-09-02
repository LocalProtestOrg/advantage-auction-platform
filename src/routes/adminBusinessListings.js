'use strict';

/**
 * /api/admin/business-listings — admin review + one-click APPROVE & PUBLISH for native Free Business
 * Listings. Admin-only. The heavy lifting (capability grant, geocode, lifecycle, published flag, audit)
 * lives in businessListingReviewService so the routes stay thin and the workflow is one server-side path.
 * Approval emails are best-effort and never block the transition.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const { asyncRoute } = require('../utils/apiError');
const db = require('../db');
const review = require('../services/businessListingReviewService');

router.use(authMiddleware, roleMiddleware(['admin']));

// Best-effort owner-email lookup + lifecycle email (never blocks the response).
async function emailOwner(orgId, buildFn) {
  try {
    const row = (await db.query(
      `SELECT u.email FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.role = 'owner' AND m.status = 'active' LIMIT 1`, [orgId])).rows[0];
    if (row && row.email) await require('../services/emailService').sendEmail({ to: row.email, ...buildFn() });
  } catch (e) { console.error('[admin-listings] owner email best-effort failed:', e.message); }
}

// GET /api/admin/business-listings?status=submitted — the review queue.
router.get('/', asyncRoute(async (req, res) => {
  const status = ['submitted', 'changes_requested', 'rejected', 'published'].includes(req.query.status) ? req.query.status : 'submitted';
  res.json({ success: true, status, listings: await review.listQueue(status) });
}));

// GET /api/admin/business-listings/:orgId — full review detail (profile, owner, caps, dup warnings).
router.get('/:orgId', asyncRoute(async (req, res) => {
  res.json({ success: true, ...(await review.getDetail(req.params.orgId)) });
}));

// POST /api/admin/business-listings/:orgId/approve — APPROVE & PUBLISH (the one-click workflow).
router.post('/:orgId/approve', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const out = await review.approveAndPublish(req.user.id, req.params.orgId, { type: b.type, lat: b.lat, lng: b.lng });
  emailOwner(req.params.orgId, () => require('../services/businessListingEmails').buildApprovedEmail({ companyName: out.name, slug: out.slug }));
  res.json({ success: true, ...out });
}));

// POST /api/admin/business-listings/:orgId/request-changes — send it back with a note.
router.post('/:orgId/request-changes', asyncRoute(async (req, res) => {
  const out = await review.requestChanges(req.user.id, req.params.orgId, (req.body || {}).reason);
  emailOwner(req.params.orgId, () => require('../services/businessListingEmails').buildChangesRequestedEmail({ companyName: out.name, reason: (req.body || {}).reason }));
  res.json({ success: true, ...out });
}));

// POST /api/admin/business-listings/:orgId/reject — decline (record preserved + audited).
router.post('/:orgId/reject', asyncRoute(async (req, res) => {
  const out = await review.reject(req.user.id, req.params.orgId, (req.body || {}).reason);
  emailOwner(req.params.orgId, () => require('../services/businessListingEmails').buildRejectedEmail({ companyName: out.name, reason: (req.body || {}).reason }));
  res.json({ success: true, ...out });
}));

module.exports = router;
