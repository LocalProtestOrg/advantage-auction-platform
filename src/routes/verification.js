'use strict';

/**
 * Seller-facing Verification API — mounted at /api/verification.
 *   GET  /requests/mine        open requests for the authenticated seller (banner)
 *   GET  /requests/:id         seller's own request view (no admin_notes)
 *   POST /requests/:id/documents  secure upload (base64) for a requested category
 * Verification is admin-requested only and never gates the dashboard.
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const idempotency = require('../middleware/idempotency');
const v = require('../services/verificationService');

function mapErr(res, err, next) {
  if (err && err.status && err.code) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
  return next(err);
}

router.get('/requests/mine', auth, async (req, res, next) => {
  try { return res.json({ success: true, data: await v.openRequestsForUser(req.user.id) }); }
  catch (err) { mapErr(res, err, next); }
});

router.get('/requests/:id', auth, async (req, res, next) => {
  try {
    const r = await v.getRequest(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Not found' });
    const myId = await v.sellerProfileIdForUser(req.user.id);
    if (r.seller_profile_id !== myId) return res.status(403).json({ success: false, message: 'Forbidden' });
    delete r.admin_notes; // internal-only
    return res.json({ success: true, data: r });
  } catch (err) { mapErr(res, err, next); }
});

router.post('/requests/:id/documents', auth, idempotency, async (req, res, next) => {
  try {
    const { category, filename, content_type, data_base64 } = req.body || {};
    const doc = await v.uploadDocument(req.params.id, req.user.id, { category, filename, contentType: content_type, dataBase64: data_base64 });
    return res.status(201).json({ success: true, data: doc });
  } catch (err) { mapErr(res, err, next); }
});

module.exports = router;
