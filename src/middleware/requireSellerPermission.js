'use strict';

/**
 * requireSellerPermission — resolves WHICH seller company the signed-in person acts for, and checks a seller permission
 * (src/lib/sellerRbac.js). MUST run after authMiddleware.
 *
 * The seller is always derived from the session's user, never from the request (no seller id in a URL, body or header
 * is consulted). Today the person must be the company owner (seller_profiles.user_id); staff membership will resolve here
 * once approved, so every seller route already passes through one chokepoint. The resolved context is cached on
 * req.sellerCtx = { sellerId, role, userId } for the handler; services still verify each row belongs to that seller.
 */
const db = require('../db');
const { hasSellerPermission } = require('../lib/sellerRbac');

async function resolveSellerContext(userId, runner = db) {
  if (!userId) return null;
  const sp = (await runner.query('SELECT id, seller_type FROM seller_profiles WHERE user_id = $1', [userId])).rows[0];
  if (sp) return { sellerId: sp.id, sellerType: sp.seller_type, role: 'owner', userId };
  return null;   // (staff membership resolves here after the design is approved)
}

function requireSellerPermission(permission) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) return res.status(401).json({ success: false, message: 'Sign in required.' });
      const ctx = req.sellerCtx || await resolveSellerContext(req.user.id);
      if (!ctx) return res.status(403).json({ success: false, code: 'NOT_A_SELLER', message: 'No seller profile.' });
      if (!hasSellerPermission(ctx, permission)) return res.status(403).json({ success: false, code: 'SELLER_PERMISSION', message: 'Your role does not allow this.' });
      req.sellerCtx = ctx;
      return next();
    } catch (e) {
      console.error('[seller-rbac] check failed:', e.message);
      return res.status(500).json({ success: false, message: 'Authorization check failed.' });
    }
  };
}

module.exports = requireSellerPermission;
module.exports.resolveSellerContext = resolveSellerContext;
