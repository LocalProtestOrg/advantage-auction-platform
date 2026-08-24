'use strict';

/**
 * requirePermission — permission-based authorization middleware for internal staff.
 *
 * MUST run after authMiddleware (needs req.user.id/role). It loads the user's CURRENT staff_role,
 * staff_active, and overrides from the DB (so a deactivation or role change takes effect immediately,
 * not at token expiry) and checks the required permission via rbac.js.
 *
 *   - Super Admin (role='admin' OR staff_role='super_admin') → always allowed.
 *   - Otherwise → allowed only if the resolved permission set includes `permission`.
 *   - No/invalid user → 401 (defensive; authMiddleware normally handles this first).
 *   - Authenticated but lacking the permission → 403.
 *
 * The resolved staff context is cached on req.staff so a route/nav can reuse it.
 */
const db = require('../db');
const rbac = require('../lib/rbac');

// Load and cache the staff context for the authenticated user.
async function loadStaffContext(req) {
  if (req.staff) return req.staff;
  if (!req.user || !req.user.id) return null;
  const u = (await db.query(
    'SELECT id, role, staff_role, staff_active FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!u) return null;
  const ov = (await db.query(
    'SELECT permission, effect FROM staff_permission_overrides WHERE user_id = $1', [req.user.id])).rows;
  const ctx = { id: u.id, role: u.role, staff_role: u.staff_role, staff_active: u.staff_active, overrides: ov };
  ctx.permissions = Array.from(rbac.permissionsForUser(ctx));
  ctx.is_super_admin = rbac.isSuperAdmin(ctx);
  req.staff = ctx;
  return ctx;
}

function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const ctx = await loadStaffContext(req);
      if (!ctx) return res.status(401).json({ error: 'Authentication required' });
      if (rbac.hasPermission(ctx, permission)) return next();
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    } catch (err) {
      console.error('[rbac] permission check failed:', err.message);
      return res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

module.exports = requirePermission;
module.exports.loadStaffContext = loadStaffContext;
