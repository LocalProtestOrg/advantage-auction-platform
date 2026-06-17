'use strict';

/**
 * requireSellerAgreement — server-authoritative seller dashboard gate.
 *
 * Blocks a seller from gated endpoints until they hold dashboard access
 * (current signed agreement, OR admin-waived, OR grandfathered). Admins always
 * bypass. Non-sellers (no seller_profile) pass through untouched — this gate is
 * only about seller onboarding, not general authorization.
 *
 * Must run AFTER authMiddleware (needs req.user). On block, returns 403 with
 * code AGREEMENT_REQUIRED and the agreement_id to sign (when one exists).
 */
const db = require('../db/index');
const agreementService = require('../services/agreementService');

module.exports = async function requireSellerAgreement(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (req.user.role === 'admin') return next(); // admin override preserved
    const sp = (await db.query('SELECT id FROM seller_profiles WHERE user_id = $1', [req.user.id])).rows[0];
    if (!sp) return next(); // not a seller — nothing to gate here
    const gate = await agreementService.dashboardAccess(sp.id);
    if (gate.access) return next();
    return res.status(403).json({
      success: false,
      code: 'AGREEMENT_REQUIRED',
      message: 'Please review and sign your seller agreement to access the seller dashboard.',
      agreement_id: gate.agreement_id,
    });
  } catch (err) { return next(err); }
};
