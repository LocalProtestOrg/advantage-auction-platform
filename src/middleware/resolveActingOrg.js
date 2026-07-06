'use strict';

/**
 * resolveActingOrg — sets req.actingOrg for a request (Phase 3B).
 *
 * A user may belong to several organizations (owner of one, staff/claimant of others), so
 * "primary org" is no longer sufficient. The acting org is selected via the `X-Acting-Org-Id`
 * header (or body `actingOrgId`), validated against active membership; admins may act on any
 * org. With no selection it falls back to the user's single/primary org (backward-compatible).
 *
 * Mount AFTER authMiddleware. Never throws for anonymous requests.
 */

const orgsService = require('../services/organizationsService');
const db = require('../db');

async function resolveActingOrg(req, res, next) {
  try {
    if (!req.user || !req.user.id) return next();
    const wanted = req.get('X-Acting-Org-Id') || (req.body && req.body.actingOrgId) || null;
    if (wanted) {
      if (req.user.role === 'admin') { req.actingOrg = await orgsService.getById(wanted); return next(); }
      const { rows } = await db.query(
        `SELECT o.* FROM organizations o JOIN organization_members m ON m.organization_id = o.id
          WHERE o.id = $1 AND m.user_id = $2 AND m.status = 'active' LIMIT 1`, [wanted, req.user.id]);
      if (!rows.length) return res.status(403).json({ success: false, code: 'NOT_A_MEMBER', message: 'You are not a member of that organization.' });
      req.actingOrg = rows[0];
      return next();
    }
    req.actingOrg = await orgsService.getPrimaryOrgForUser(req.user.id); // back-compat fallback
    return next();
  } catch (err) { return next(err); }
}

module.exports = resolveActingOrg;
