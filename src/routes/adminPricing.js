'use strict';

/**
 * /api/admin/pricing — internal Pricing & Fees control center. Reads the centralized authoritative
 * pricing; allows a Super Admin to change ONLY the two editable auction rates (professional platform
 * fee + card-processing fee). Platform and processing are ALWAYS kept SEPARATE — there is no combined
 * "7%" setting; the total is derived for display only. Individual buyer premium (18%), Storefront (11%),
 * Estate Sale ($39) and Appraiser ($19.99) are shown read-only here (governed elsewhere / by Stripe).
 *
 * Authorization (existing RBAC, no new authority invented):
 *   • VIEW  → seller_platform_fee.view  (Super Admin + Finance).
 *   • WRITE → seller_platform_fee.manage (Super Admin only in practice).
 * Every change is written to the existing audit_log with old/new value + actor.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const db = require('../db');
const auditService = require('../services/auditService');
const pricingConfig = require('../services/pricingConfigService');

// The ONLY keys an admin may edit through this interface. Everything else is derived or governed elsewhere.
const EDITABLE = {
  'pricing.auction.professional.platform_fee_bps': 'Professional platform/software fee',
  'pricing.auction.processing_fee_bps': 'Credit-card/payment-processing fee',
};

router.use(auth);

// GET the full current pricing model (components separate; totals derived).
router.get('/', requirePermission('seller_platform_fee.view'), async (req, res, next) => {
  try {
    const pricing = await pricingConfig.getPricing();
    return res.json({ success: true, data: pricing, editable_keys: Object.keys(EDITABLE) });
  } catch (err) { next(err); }
});

// PUT a single editable rate (bps). Super-Admin only (seller_platform_fee.manage). Audited.
router.put('/', requirePermission('seller_platform_fee.manage'), async (req, res, next) => {
  try {
    const key = String((req.body || {}).key || '');
    const bps = (req.body || {}).bps;
    if (!Object.prototype.hasOwnProperty.call(EDITABLE, key)) {
      return res.status(400).json({ success: false, message: 'That pricing value cannot be edited here.' });
    }
    const oldVal = await pricingConfig.getInt(key);           // pre-change value for the audit trail
    const newVal = await pricingConfig.setBps(key, bps);      // validates range; throws 400 on bad input
    await auditService.logEvent(db, {
      eventType: 'pricing.rate_changed', entityType: 'platform_config', entityId: null,
      actorId: req.user.id,
      metadata: { key, label: EDITABLE[key], old_bps: oldVal, new_bps: newVal },
    });
    const pricing = await pricingConfig.getPricing();
    return res.json({ success: true, data: pricing, changed: { key, old_bps: oldVal, new_bps: newVal } });
  } catch (err) {
    if (err && err.status === 400) return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
});

module.exports = router;
