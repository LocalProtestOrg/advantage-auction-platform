'use strict';

/**
 * /api/admin/partners — admin management of Partner Organizations (Constitution §11, §9):
 * effective capabilities (grant/revoke as 'override'), and per-organization config overrides.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const capabilityService = require('../services/capabilityService');
const configService = require('../services/configService');
const { asyncRoute, svcErr } = require('../utils/apiError');

router.use(authMiddleware, roleMiddleware(['admin']));

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

module.exports = router;
