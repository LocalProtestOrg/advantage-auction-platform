'use strict';

/**
 * /api/admin/owner-alerts — Super-Admin control for OPERATIONAL owner SMS alerts.
 *
 *   GET  /status — is the owner-alert pipe configured? (booleans only — NEVER returns the phone number,
 *                  Twilio secrets, or any value; just presence + validity flags for the admin UI).
 *   POST /test   — send ONE controlled, clearly-labeled TEST SMS to OWNER_ALERT_PHONE_E164 through the real
 *                  transport. Creates NO auction/estate-sale/marketing/financial record. Audited.
 *
 * Super-Admin-only (role='admin'), mirroring adminAgreements. This is an OPERATIONAL (transactional) alert,
 * not customer marketing — customer marketing SMS is out of scope and remains prohibited here.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const ownerAlerts = require('../services/ownerAlertService');
const smsService = require('../services/smsService');
const { writeAuditLog } = require('../lib/auditLog');

router.use(auth, role(['admin']));

// Presence/validity only — no secret values ever leave the server (no phone number, no SID, no token).
router.get('/status', (req, res) => {
  const messagingServicePresent = !!process.env.TWILIO_MESSAGING_SERVICE_SID;
  // COUNT of validated recipients only — never the numbers themselves.
  const recipientCount = ownerAlerts.recipientsFor(ownerAlerts.ALERT_TYPES.AUCTION_SUBMITTED).length;
  return res.json({
    success: true,
    data: {
      owner_recipient_count: recipientCount,
      multi_recipient_configured: !!process.env.OWNER_ALERT_PHONE_E164S,
      twilio_configured: smsService.isConfigured(),
      sender_mode: messagingServicePresent ? 'messaging_service' : (process.env.TWILIO_FROM_NUMBER ? 'from_number' : 'none'),
      ready: ownerAlerts.ownerAlertConfigured() && smsService.isConfigured(),
    },
  });
});

// Controlled test send. Never throws to the client; reports the outcome. Body is optional { note }.
router.post('/test', async (req, res, next) => {
  try {
    const note = (req.body && typeof req.body.note === 'string') ? req.body.note : 'admin console test';
    const result = await ownerAlerts.sendTestAlert({ note });
    await writeAuditLog({
      event_type: 'owner_alert_test_sent', entity_type: 'owner_alert', entity_id: req.user.id,
      actor_id: req.user.id,
      metadata: { attempted: result.attempted || 0, sent: result.sent || 0, failed: result.failed || 0, skipped: !!result.skipped, reason: result.reason || null },
    });
    return res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

module.exports = router;
