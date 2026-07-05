'use strict';

/**
 * /api/config — configuration hierarchy surface (Constitution §9).
 * Public branding read; admin platform config; partner self-service org config.
 * Business-rule config values are stored/edited here but NOT consumed by settlement yet.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const configService = require('../services/configService');
const orgsService = require('../services/organizationsService');
const { asyncRoute, svcErr } = require('../utils/apiError');

// Public: effective branding (platform defaults; future: resolved per host).
router.get('/branding', asyncRoute(async (req, res) => {
  res.json({ success: true, branding: await configService.getAll(null, 'branding') });
}));

// Admin: platform config get/set.
router.get('/platform', authMiddleware, roleMiddleware(['admin']), asyncRoute(async (req, res) => {
  res.json({ success: true, config: await configService.getAll(null) });
}));
router.put('/platform', authMiddleware, roleMiddleware(['admin']), asyncRoute(async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) throw svcErr(400, 'KEY_REQUIRED', 'key is required.');
  await configService.setPlatformConfig(key, value);
  res.json({ success: true });
}));

// Partner self-service: the acting org's effective config + overrides.
router.get('/org', authMiddleware, asyncRoute(async (req, res) => {
  const org = await orgsService.getPrimaryOrgForUser(req.user.id);
  if (!org) throw svcErr(404, 'NO_ORGANIZATION', 'No organization for this account.');
  res.json({ success: true, organization: { id: org.id, slug: org.slug }, config: await configService.getAll(org.id) });
}));
router.put('/org', authMiddleware, asyncRoute(async (req, res) => {
  const org = await orgsService.getPrimaryOrgForUser(req.user.id);
  if (!org) throw svcErr(404, 'NO_ORGANIZATION', 'No organization for this account.');
  const { key, value } = req.body || {};
  if (!key) throw svcErr(400, 'KEY_REQUIRED', 'key is required.');
  await configService.setOrgConfig(org.id, key, value, req.user.id);
  res.json({ success: true });
}));

module.exports = router;
