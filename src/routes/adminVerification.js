'use strict';

/**
 * Admin Verification API — mounted at /api/admin/verification. Admin-only.
 * Request verification documents, review submissions, set risk, inspect
 * duplicate-warning signals, and download private documents (signed URL).
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const v = require('../services/verificationService');

function isUuid(x) { return typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x); }
function mapErr(res, err, next) {
  if (err && err.status && err.code) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
  return next(err);
}

router.use(auth, role(['admin']));

// Request documents from a seller (one request, multiple categories) + email link.
router.post('/sellers/:sellerProfileId/requests', idempotency, async (req, res, next) => {
  try {
    if (!isUuid(req.params.sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid seller id' });
    const { categories, message } = req.body || {};
    const r = await v.createRequest(req.params.sellerProfileId, { categories, message }, req.user.id);
    return res.status(201).json({ success: true, data: r });
  } catch (err) { mapErr(res, err, next); }
});

router.get('/sellers/:sellerProfileId/requests', async (req, res, next) => {
  try {
    if (!isUuid(req.params.sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid seller id' });
    return res.json({ success: true, data: await v.listForSeller(req.params.sellerProfileId) });
  } catch (err) { mapErr(res, err, next); }
});

// Risk level + internal notes + verification-required-before-publication flag.
router.patch('/sellers/:sellerProfileId/risk', idempotency, async (req, res, next) => {
  try {
    if (!isUuid(req.params.sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid seller id' });
    const row = await v.setRisk(req.params.sellerProfileId, req.user.id, req.body || {});
    return res.json({ success: true, data: row });
  } catch (err) { mapErr(res, err, next); }
});

// Passive fraud signals (never auto-blocks; admin-surfaced).
router.get('/sellers/:sellerProfileId/duplicates', async (req, res, next) => {
  try {
    if (!isUuid(req.params.sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid seller id' });
    return res.json({ success: true, data: await v.duplicateWarnings(req.params.sellerProfileId) });
  } catch (err) { mapErr(res, err, next); }
});

router.get('/sellers/:sellerProfileId/publication-gate', async (req, res, next) => {
  try {
    if (!isUuid(req.params.sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid seller id' });
    return res.json({ success: true, data: await v.publicationGate(req.params.sellerProfileId) });
  } catch (err) { mapErr(res, err, next); }
});

router.get('/requests/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    const r = await v.getRequest(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Request not found' });
    return res.json({ success: true, data: r });
  } catch (err) { mapErr(res, err, next); }
});

// Approve / reject / request-more-info at the request level.
router.post('/requests/:id/review', idempotency, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    const { status, admin_notes } = req.body || {};
    return res.json({ success: true, data: await v.reviewRequest(req.params.id, req.user.id, { status, adminNotes: admin_notes }) });
  } catch (err) { mapErr(res, err, next); }
});

// Per-document review.
router.post('/documents/:id/review', idempotency, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid document id' });
    const { status, note } = req.body || {};
    return res.json({ success: true, data: await v.reviewDocument(req.params.id, req.user.id, { status, note }) });
  } catch (err) { mapErr(res, err, next); }
});

// Short-lived signed download URL for a private document (admin only).
router.get('/documents/:id/file', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid document id' });
    return res.json({ success: true, ...(await v.documentDownloadUrl(req.params.id)) });
  } catch (err) { mapErr(res, err, next); }
});

module.exports = router;
