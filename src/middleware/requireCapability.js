'use strict';

/**
 * requireCapability(capability) — Express middleware gating a route on a tenant capability.
 *
 * Resolves the tenant (Organization) via tenantContext, attaches it as req.tenant, and
 * allows the request only if that tenant has the capability enabled. Per Constitution §11,
 * authorization is capability-based (not plan-name or user-type based).
 *
 * Phase 1: the tenant is always the platform tenant (Advantage), which holds ALL
 * capabilities — so this never blocks today. It becomes meaningful for Partners in later
 * phases. NOT yet applied to any existing route (additive infrastructure).
 *
 * Usage (future): router.post('/things', authMiddleware, requireCapability('events'), handler)
 */

const { resolveTenant, hasCapability } = require('../lib/tenantContext');

function requireCapability(capability) {
  return async function requireCapabilityMiddleware(req, res, next) {
    try {
      const tenant = await resolveTenant(req);
      if (!tenant) {
        return res.status(503).json({ success: false, code: 'NO_TENANT', message: 'No tenant could be resolved for this request.' });
      }
      req.tenant = tenant;
      if (!(await hasCapability(tenant.id, capability))) {
        return res.status(403).json({ success: false, code: 'CAPABILITY_REQUIRED', message: `This capability is not enabled: ${capability}.` });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = requireCapability;
