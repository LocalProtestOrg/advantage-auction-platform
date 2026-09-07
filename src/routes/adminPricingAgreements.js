'use strict';

/**
 * /api/admin/pricing-agreements — Admin authoring of Professional Seller NEGOTIATED-PRICING agreements.
 *
 * Reuses the EXISTING RBAC/Finance authority (no new authority invented), mirroring /api/admin/pricing:
 *   • VIEW  → seller_platform_fee.view   (Super Admin + Finance staff).
 *   • WRITE → seller_platform_fee.manage (Super Admin only in practice).
 * Negotiated pricing is seller/company-scoped, versioned, and audited. Issuing a new agreement never
 * mutates an executed one — acceptance (by the seller) is a separate, seller-authenticated action.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const svc = require('../services/sellerPricingAgreementService');

router.use(auth);

// Standard sitewide auction pricing (Professional): platform + processing SEPARATE.
router.get('/standard', requirePermission('seller_platform_fee.view'), async (req, res, next) => {
  try { return res.json({ success: true, data: await svc.standardPricing() }); }
  catch (err) { next(err); }
});

// Seller record summary: standard vs negotiated, current executed agreement, pending, effective rate, basis.
router.get('/sellers/:sellerProfileId', requirePermission('seller_platform_fee.view'), async (req, res, next) => {
  try {
    const summary = await svc.getSellerSummary(req.params.sellerProfileId);
    const history = await svc.listForSeller(req.params.sellerProfileId);
    return res.json({ success: true, data: { ...summary, history } });
  } catch (err) { next(err); }
});

// Full agreement history for a seller (versioned).
router.get('/sellers/:sellerProfileId/history', requirePermission('seller_platform_fee.view'), async (req, res, next) => {
  try { return res.json({ success: true, data: await svc.listForSeller(req.params.sellerProfileId) }); }
  catch (err) { next(err); }
});

// Issue a PROPOSED agreement to a professional seller (Super Admin / Finance-manage). Audited.
router.post('/sellers/:sellerProfileId/issue', requirePermission('seller_platform_fee.manage'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await svc.issue({
      sellerProfileId: req.params.sellerProfileId,
      platform_fee_bps: b.platform_fee_bps,
      platform_fee_percent: b.platform_fee_percent,
      effective_date: b.effective_date,
      terms_summary: b.terms_summary,
      legal_terms_version: b.legal_terms_version,
      expires_in_days: b.expires_in_days,
      actorId: req.user.id,
    });
    return res.status(201).json({ success: true, data: row });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    next(err);
  }
});

// One agreement's detail (any status).
router.get('/agreements/:id', requirePermission('seller_platform_fee.view'), async (req, res, next) => {
  try {
    const row = await svc.getById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Agreement not found' });
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// Revoke a pending offer (Super Admin / Finance-manage). Executed agreements are immutable.
router.post('/agreements/:id/revoke', requirePermission('seller_platform_fee.manage'), async (req, res, next) => {
  try {
    const out = await svc.revoke(req.params.id, { reason: (req.body || {}).reason }, req.user.id);
    return res.json({ success: true, data: out });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    next(err);
  }
});

module.exports = router;
