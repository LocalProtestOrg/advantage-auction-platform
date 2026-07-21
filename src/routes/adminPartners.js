'use strict';

/**
 * /api/admin/partners — admin management of Partner Organizations (Constitution §11, §9):
 * effective capabilities (grant/revoke as 'override'), and per-organization config overrides.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const db = require('../db');
const capabilityService = require('../services/capabilityService');
const configService = require('../services/configService');
const organizationsService = require('../services/organizationsService');
const orgLifecycle = require('../services/organizationLifecycleService');
const { asyncRoute, svcErr } = require('../utils/apiError');

router.use(authMiddleware, roleMiddleware(['admin']));

// Organization picker for the memberships UI (name search; returns the current tier).
router.get('/organizations', asyncRoute(async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = []; let where = '';
  if (q) { params.push('%' + q + '%'); where = 'WHERE name ILIKE $1'; }
  params.push(Math.min(parseInt(req.query.limit, 10) || 50, 200));
  const { rows } = await db.query(
    `SELECT id, name, city, state, plan_tier FROM organizations ${where}
      ORDER BY name ASC LIMIT $${params.length}`, params);
  res.json({ success: true, organizations: rows });
}));

// Assignable membership plans/tiers (for the admin picker)
router.get('/plans', asyncRoute(async (req, res) => {
  const plans = await organizationsService.listPlans();
  res.json({ success: true, plans });
}));

// Assign an organization's membership tier (plan). Re-syncs the org's plan capabilities.
router.put('/:orgId/plan', asyncRoute(async (req, res) => {
  const planTier = (req.body || {}).plan_tier;
  if (!planTier) throw svcErr(400, 'PLAN_REQUIRED', 'plan_tier is required.');
  const org = await organizationsService.setPlanTier(req.user.id, req.params.orgId, planTier);
  res.json({ success: true, organization: { id: org.id, name: org.name, plan_tier: org.plan_tier } });
}));

// Effective capabilities for an organization
router.get('/:orgId/capabilities', asyncRoute(async (req, res) => {
  const caps = await capabilityService.getEffectiveCapabilities(req.params.orgId);
  res.json({ success: true, capabilities: Array.from(caps).sort() });
}));

// Grant/revoke a capability (admin override beyond plan)
router.post('/:orgId/capabilities', asyncRoute(async (req, res) => {
  const { capability, enabled } = req.body || {};
  if (!capability) throw svcErr(400, 'CAPABILITY_REQUIRED', 'capability is required.');
  await capabilityService.setCapability(req.params.orgId, capability, enabled !== false, 'override');
  res.json({ success: true });
}));

// Set an organization config override
router.put('/:orgId/config', asyncRoute(async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) throw svcErr(400, 'KEY_REQUIRED', 'key is required.');
  await configService.setOrgConfig(req.params.orgId, key, value, req.user.id);
  res.json({ success: true });
}));

// Lifecycle transition (Phase 3A): verify | activate. Admin-only; audited in the service.
router.post('/:orgId/lifecycle', asyncRoute(async (req, res) => {
  const action = (req.body || {}).action;
  let org;
  if (action === 'verify') org = await orgLifecycle.verify(req.user.id, req.params.orgId);
  else if (action === 'activate') org = await orgLifecycle.activate(req.user.id, req.params.orgId);
  else throw svcErr(400, 'INVALID_ACTION', "action must be 'verify' or 'activate'.");
  res.json({ success: true, organization: {
    id: org.id, slug: org.slug, lifecycle_state: org.lifecycle_state, verification_status: org.verification_status,
  } });
}));

module.exports = router;
