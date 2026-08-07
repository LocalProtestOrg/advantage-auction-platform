'use strict';

/**
 * Buyer Tax-Exemption API — mounted at /api/tax-exemption. Buyer-facing.
 *   GET  /        the authenticated buyer's exemption status (buyer-safe fields only)
 *   POST /        submit/replace an exemption request + certificate document (base64)
 * Uploading a certificate does NOT make the buyer tax-exempt — only an admin approval does.
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const idempotency = require('../middleware/idempotency');
const svc = require('../services/taxExemptionService');

function mapErr(res, err, next) {
  if (err && err.status && err.code) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
  return next(err);
}

router.get('/', auth, async (req, res, next) => {
  try { return res.json({ success: true, data: await svc.getForBuyer(req.user.id) }); }
  catch (err) { mapErr(res, err, next); }
});

router.post('/', auth, idempotency, async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await svc.submitExemption(req.user.id, {
      exemption_type: b.exemption_type,
      jurisdiction_state: b.jurisdiction_state,
      certificate_number: b.certificate_number,
      effective_date: b.effective_date,
      expiration_date: b.expiration_date,
      filename: b.filename,
      contentType: b.content_type,
      dataBase64: b.data_base64,
    });
    return res.status(201).json({ success: true, data: out });
  } catch (err) { mapErr(res, err, next); }
});

module.exports = router;
