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
// Any admin may write an ordinary platform key; a SENSITIVE key (src/lib/sensitiveConfig.js) is platform owner only.
// Every write is audited and sensitive changes notify the owner (configService.setPlatformConfig is the choke point).
router.put('/platform', authMiddleware, roleMiddleware(['admin']), asyncRoute(async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || typeof key !== 'string') throw svcErr(400, 'KEY_REQUIRED', 'key is required.');
  if (value === undefined) throw svcErr(400, 'VALUE_REQUIRED', 'value is required.');
  await configService.setPlatformConfig(key.trim(), value, { actor: req.user, source: 'PUT /api/config/platform', adminPath: '/admin/' });
  res.json({ success: true, sensitive: require('../lib/sensitiveConfig').isSensitive(key) });
}));

// Admin: the platform setting audit trail (newest first; values were masked when recorded).
router.get('/platform/audit', authMiddleware, roleMiddleware(['admin']), asyncRoute(async (req, res) => {
  const key = req.query.key ? String(req.query.key).slice(0, 200) : null;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = (await require('../db').query(
    `SELECT a.id, a.config_key, a.previous_value, a.new_value, a.sensitive, a.actor_kind, a.actor_label, a.source,
            a.owner_notified_at, a.created_at, u.email AS actor_email
       FROM platform_setting_audit a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ($1::text IS NULL OR a.config_key = $1) ORDER BY a.created_at DESC LIMIT $2`, [key, limit])).rows;
  res.json({ success: true, audit: rows });
}));

// Partner self-service: the acting org's effective config + overrides. Org/partner management is a
// seller/admin capability — a plain buyer must not read or write org config even for their own org.
router.get('/org', authMiddleware, roleMiddleware(['seller', 'admin']), asyncRoute(async (req, res) => {
  const org = await orgsService.getPrimaryOrgForUser(req.user.id);
  if (!org) throw svcErr(404, 'NO_ORGANIZATION', 'No organization for this account.');
  res.json({ success: true, organization: { id: org.id, slug: org.slug }, config: await configService.getAll(org.id) });
}));
router.put('/org', authMiddleware, roleMiddleware(['seller', 'admin']), asyncRoute(async (req, res) => {
  const org = await orgsService.getPrimaryOrgForUser(req.user.id);
  if (!org) throw svcErr(404, 'NO_ORGANIZATION', 'No organization for this account.');
  const { key, value } = req.body || {};
  if (!key) throw svcErr(400, 'KEY_REQUIRED', 'key is required.');
  // An organization override can never shadow a sensitive platform setting (pricing, paid advertising, programme
  // switches, owner settings). Those are platform owner decisions made on the platform record only.
  if (require('../lib/sensitiveConfig').isSensitive(key)) throw svcErr(403, 'PLATFORM_SETTING', 'This setting is managed by Advantage.Bid and cannot be changed here.');
  await configService.setOrgConfig(org.id, key, value, req.user.id);
  res.json({ success: true });
}));

module.exports = router;
