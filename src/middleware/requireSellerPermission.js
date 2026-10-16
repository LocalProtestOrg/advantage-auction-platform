'use strict';

/**
 * requireSellerPermission — resolves WHICH seller company the signed-in person acts for, and checks a seller permission
 * (src/lib/sellerRbac.js). MUST run after authMiddleware.
 *
 * The seller is always derived from the session's user, never from the request (no seller id in a URL, body or header
 * is consulted):
 *   • the company OWNER (seller_profiles.user_id) — always;
 *   • a staff member with an ACTIVE membership (migration 199) — only while SELLER_STAFF_ENABLED is on. The membership
 *     is read on every request, so suspending, removing or changing a member's role takes effect immediately.
 * The resolved context is cached on req.sellerCtx = { sellerId, sellerType, role, userId, staff, memberId } for the
 * handler; services still verify each row belongs to that seller. Every successful change made by a staff member is
 * written to the company's append-only staff history (actor, company, action, time).
 */
const db = require('../db');
const { hasSellerPermission } = require('../lib/sellerRbac');
const { sellerStaffEnabled } = require('../lib/launchGuards');

async function resolveSellerContext(userId, runner = db, env = process.env) {
  if (!userId) return null;
  const sp = (await runner.query('SELECT id, seller_type FROM seller_profiles WHERE user_id = $1', [userId])).rows[0];
  if (sp) return { sellerId: sp.id, sellerType: sp.seller_type, role: 'owner', userId, staff: false };
  if (!sellerStaffEnabled(env)) return null;
  const m = (await runner.query(
    `SELECT m.id, m.seller_id, m.role, sp.seller_type
       FROM seller_staff_members m
       JOIN seller_profiles sp ON sp.id = m.seller_id
       JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.status = 'active' AND COALESCE(u.is_active, true) = true`, [userId])).rows[0];
  if (!m) return null;
  return { sellerId: m.seller_id, sellerType: m.seller_type, role: m.role, userId, staff: true, memberId: m.id };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function recordStaffAction(ctx, req, permission, status) {
  db.query(
    `INSERT INTO seller_staff_events (member_id, seller_id, action, actor_user_id, actor_role, data)
     VALUES ($1, $2, 'sensitive_action', $3, 'staff', $4::jsonb)`,
    [ctx.memberId, ctx.sellerId, ctx.userId, JSON.stringify({ method: req.method, path: String(req.originalUrl || req.url || '').split('?')[0].slice(0, 200),
      permission, role: ctx.role, status })])
    .catch((e) => console.error('[seller-rbac] staff history write failed:', e.message));
}

function requireSellerPermission(permission) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) return res.status(401).json({ success: false, message: 'Sign in required.' });
      const ctx = req.sellerCtx || await resolveSellerContext(req.user.id);
      if (!ctx) return res.status(403).json({ success: false, code: 'NOT_A_SELLER', message: 'No seller profile.' });
      if (!hasSellerPermission(ctx, permission)) return res.status(403).json({ success: false, code: 'SELLER_PERMISSION', message: 'Your role does not allow this.' });
      req.sellerCtx = ctx;
      if (ctx.staff && !SAFE.has(String(req.method || 'GET').toUpperCase())) {
        res.on('finish', () => { if (res.statusCode < 400) recordStaffAction(ctx, req, permission, res.statusCode); });
      }
      return next();
    } catch (e) {
      console.error('[seller-rbac] check failed:', e.message);
      return res.status(500).json({ success: false, message: 'Authorization check failed.' });
    }
  };
}

// For pages shown to every member: the seller context when there is one (null otherwise), and 403 only when the person
// belongs to a company but their role lacks the permission. Keeps the "no seller profile → empty list" behaviour.
function optionalSellerPermission(permission) {
  return async (req, res, next) => {
    try {
      const ctx = req.sellerCtx || (req.user && req.user.id ? await resolveSellerContext(req.user.id) : null);
      if (ctx && !hasSellerPermission(ctx, permission)) return res.status(403).json({ success: false, code: 'SELLER_PERMISSION', message: 'Your role does not allow this.' });
      req.sellerCtx = ctx || null;
      return next();
    } catch (e) {
      console.error('[seller-rbac] check failed:', e.message);
      return res.status(500).json({ success: false, message: 'Authorization check failed.' });
    }
  };
}

module.exports = requireSellerPermission;
module.exports.resolveSellerContext = resolveSellerContext;
module.exports.optionalSellerPermission = optionalSellerPermission;
