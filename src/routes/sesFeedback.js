'use strict';

/**
 * SES feedback webhook — application-side ingestion of Amazon SES bounce/complaint/delivery notifications
 * (typically via SNS). Mounted at /api/ses.
 *
 * SECURITY (fail-closed):
 *   - DISABLED unless SES_FEEDBACK_WEBHOOK_SECRET is configured → 503. Nothing here activates sending.
 *   - Every request must present the shared secret (header x-webhook-secret or ?token=), compared with a
 *     timing-safe check → 401 otherwise. (SNS signature verification can be layered on later; the shared
 *     secret is required regardless.)
 *   - Malformed/unparseable payloads → 400.
 *   - SNS SubscriptionConfirmation is acknowledged but NOT auto-confirmed (no external activation).
 *
 * Ingestion is idempotent (provider_event_id) inside sesFeedbackService.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { parse, isSnsControl } = require('../lib/sesNotificationParser');
const sesFeedback = require('../services/sesFeedbackService');

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Capture text/plain bodies (SNS default content type) that the global JSON parser leaves untouched.
router.use(express.text({ type: ['text/*', 'application/json'], limit: '512kb' }));

router.post('/feedback', async (req, res) => {
  const secret = process.env.SES_FEEDBACK_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'SES feedback ingestion is not configured' });

  const presented = req.get('x-webhook-secret') || req.query.token;
  if (!timingSafeEqual(presented, secret)) return res.status(401).json({ error: 'Unauthorized' });

  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { return res.status(400).json({ error: 'Malformed payload' }); } }
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'Malformed payload' });

  if (isSnsControl(payload)) {
    // Acknowledge but do not auto-confirm — subscription confirmation is an owner action, not automatic.
    console.log('[ses] SNS control message received (not auto-confirmed):', payload.Type);
    return res.status(200).json({ ok: true, acknowledged: payload.Type, auto_confirmed: false });
  }

  const events = parse(payload);
  if (!events.length) return res.status(400).json({ error: 'No recognizable SES events in payload' });

  const results = [];
  try {
    for (const evt of events) results.push(await sesFeedback.ingestEvent(evt));
  } catch (e) {
    console.error('[ses] ingestion failed:', e.message);
    return res.status(500).json({ error: 'Ingestion failed' });
  }
  return res.status(200).json({ ok: true, ingested: results.length, results });
});

module.exports = router;
