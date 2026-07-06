'use strict';

/**
 * requireOrgCapability(capability) — gate a route on the ACTING organization's capability
 * (the org the logged-in user operates as). Platform admins bypass (unrestricted override,
 * Constitution permission model). Capability-based authz per §11.
 *
 * Mount AFTER authMiddleware. Attaches req.actingOrg on success. Distinct from
 * requireCapability (which checks the host/platform tenant).
 */

const orgsService = require('../services/organizationsService');
const capabilityService = require('../services/capabilityService');

function requireOrgCapability(capability) {
  return async function requireOrgCapabilityMiddleware(req, res, next) {
    try {
      if (req.user && req.user.role === 'admin') return next(); // admin override
      // Prefer the resolved acting org (Phase 3B); fall back to the user's single/primary org.
      const org = req.actingOrg || await orgsService.getPrimaryOrgForUser(req.user.id);
      if (!org) {
        return res.status(403).json({ success: false, code: 'NO_ORGANIZATION', message: 'No organization is associated with this account.' });
      }
      req.actingOrg = org;
      if (!(await capabilityService.hasCapability(org.id, capability))) {
        return res.status(403).json({ success: false, code: 'CAPABILITY_REQUIRED', message: `Your organization does not have the "${capability}" capability enabled.` });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = requireOrgCapability;
