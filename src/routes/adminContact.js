'use strict';

/**
 * Admin Quick-Contact — resolve a user's authoritative deliverable contact info for one-click admin
 * outreach (Email / Call / Copy Email / Copy Phone / gated Text). Mounted at /api/admin/contact.
 *
 * - Email is resolved through recipientService (the BD-bridge rule), so admins never see or mail a
 *   namespaced placeholder login address.
 * - Phone comes from users.phone (there is no seller_profiles.phone column).
 * - SMS is GATED: sms_enabled reflects marketing.admin_sms_enabled (false; Twilio pending). This endpoint
 *   NEVER sends SMS — it only reports whether the Text action is active. No Twilio integration here.
 * - RBAC: existing roles only. Admins (super admin) pass; staff need members.view. Access is audit-logged.
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const db = require('../db');
const { recipientEmailSql } = require('../services/recipientService');
const marketingConfig = require('../services/marketingConfigService');
const { writeAuditLog } = require('../lib/auditLog');

router.use(auth, requirePermission('members.view'));

// GET /api/admin/contact/:userId — authoritative resolved contact info for quick-contact actions.
router.get('/:userId', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.phone, u.role,
              ${recipientEmailSql('u')} AS email,
              sp.display_name AS seller_name
         FROM users u
         LEFT JOIN seller_profiles sp ON sp.user_id = u.id
        WHERE u.id = $1`,
      [req.params.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    const smsEnabled = await marketingConfig.adminSmsEnabled();

    await writeAuditLog({
      event_type: 'admin.contact.view', entity_type: 'user', entity_id: u.id,
      actor_id: req.user.id, metadata: { role: u.role },
    }).catch(() => {});

    return res.json({
      user_id: u.id,
      name: u.full_name || u.seller_name || null,
      email: u.email || null,
      phone: u.phone || null,
      sms_enabled: !!smsEnabled,           // false until Twilio is registered/verified
      sms_status_note: smsEnabled ? 'SMS active' : 'SMS activation pending',
    });
  } catch (e) { next(e); }
});

module.exports = router;
