'use strict';

/**
 * /api/admin/follower-emails — admin visibility + control for Professional Seller follower campaigns.
 * Admin only. Exposes AGGREGATE campaign data (seller, event, audience size, delivered/failed, status,
 * audit) — never raw recipient lists or contact data — and can disable a seller's follower-email privilege.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const db = require('../db');
const { asyncRoute, svcErr } = require('../utils/apiError');
const { writeAuditLog } = require('../lib/auditLog');
const followerCampaignService = require('../services/followerCampaignService');

router.use(authMiddleware, roleMiddleware(['admin']));

// GET /api/admin/follower-emails/campaigns — recent campaigns with aggregate delivery stats.
router.get('/campaigns', asyncRoute(async (req, res) => {
  const rows = (await db.query(
    `SELECT fc.id, fc.status, fc.trigger_type, fc.custom_message, fc.audience_estimate, fc.targeted_count,
            fc.created_at, fc.queued_at,
            e.title AS event_title, e.slug AS event_slug, e.sale_type,
            sp.id AS seller_id, sp.display_name AS seller_name, sp.seller_type, sp.follower_email_enabled
       FROM follower_campaigns fc
       LEFT JOIN events e ON e.id = fc.event_id
       LEFT JOIN seller_profiles sp ON sp.id = fc.seller_id
      ORDER BY fc.created_at DESC LIMIT 200`)).rows;
  const campaigns = [];
  for (const c of rows) {
    const stats = c.status === 'queued' ? await followerCampaignService.campaignStats(c.id) : null;
    campaigns.push({
      id: c.id, status: c.status, trigger_type: c.trigger_type,
      custom_message: c.custom_message || null,
      audience_estimate: c.audience_estimate, targeted_count: c.targeted_count,
      delivered_count: stats ? stats.delivered : 0,
      failed_count: stats ? stats.failed : 0,
      pending_count: stats ? stats.pending : 0,
      skipped_count: stats ? stats.skipped : 0,
      created_at: c.created_at, queued_at: c.queued_at,
      event: { title: c.event_title, slug: c.event_slug, sale_type: c.sale_type },
      seller: { id: c.seller_id, name: c.seller_name, seller_type: c.seller_type,
        follower_email_enabled: c.follower_email_enabled },
    });
  }
  res.json({ success: true, campaigns });
}));

// POST /api/admin/follower-emails/sellers/:sellerId/privilege  { enabled: bool }
// Disable/enable a seller's follower-email tool. Disabling also cancels any scheduled campaigns.
router.post('/sellers/:sellerId/privilege', asyncRoute(async (req, res) => {
  const enabled = !!(req.body || {}).enabled;
  const { rows } = await db.query(
    `UPDATE seller_profiles SET follower_email_enabled=$2, updated_at=now() WHERE id=$1 RETURNING id, follower_email_enabled`,
    [req.params.sellerId, enabled]);
  if (!rows.length) throw svcErr(404, 'SELLER_NOT_FOUND', 'Seller not found.');
  if (!enabled) {
    await db.query(
      `UPDATE follower_campaigns SET status='canceled', updated_at=now() WHERE seller_id=$1 AND status='scheduled'`,
      [req.params.sellerId]);
  }
  await writeAuditLog({
    event_type: 'follower_campaign.privilege_changed', entity_type: 'seller_profile', entity_id: req.params.sellerId,
    actor_id: req.user.id, metadata: { follower_email_enabled: enabled },
  });
  res.json({ success: true, seller_id: rows[0].id, follower_email_enabled: rows[0].follower_email_enabled });
}));

module.exports = router;
