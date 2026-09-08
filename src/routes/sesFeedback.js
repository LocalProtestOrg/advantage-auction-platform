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
 *   - SNS SubscriptionConfirmation is acknowledged but NOT auto-confirmed (no external activation). For a
 *     GENUINE, authenticated SubscriptionConfirmation we surface the one-time AWS SubscribeURL to the
 *     OPERATOR LOG ONLY (Railway logs are Owner-only) so the Owner can visit it exactly once to confirm the
 *     HTTPS subscription. We never auto-GET it, never persist it to the DB, never return it in the HTTP
 *     response, and never log the webhook secret. The SubscribeURL host is validated to be genuine AWS SNS.
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

// A SubscribeURL is only trusted (and only logged) if it is a genuine AWS SNS HTTPS endpoint. This prevents a
// forged/mistaken control message from planting an arbitrary URL in the operator log.
function isAwsSnsSubscribeUrl(u) {
  try { const p = new URL(String(u)); return p.protocol === 'https:' && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(p.hostname); }
  catch (_) { return false; }
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
    // Acknowledge but NEVER auto-confirm — subscription confirmation is an owner action, not automatic.
    const type = payload.Type;
    if (type === 'SubscriptionConfirmation' && isAwsSnsSubscribeUrl(payload.SubscribeURL)) {
      // Operator-log ONLY (Owner-only Railway logs); no DB write, not returned to the caller (AWS SNS), no secret.
      console.log('[ses] SNS SubscriptionConfirmation (authenticated). To confirm this HTTPS subscription an operator must GET the one-time SubscribeURL below EXACTLY ONCE (never shared, never auto-visited):');
      console.log('[ses] SubscribeURL: ' + payload.SubscribeURL);
      console.log('[ses] confirmation-context TopicArn=' + (payload.TopicArn || '?') + ' MessageId=' + (payload.MessageId || '?') + ' Timestamp=' + (payload.Timestamp || '?'));
      return res.status(200).json({ ok: true, acknowledged: type, auto_confirmed: false, subscribe_url_logged: true });
    }
    console.log('[ses] SNS control message received (not auto-confirmed):', type);
    return res.status(200).json({ ok: true, acknowledged: type, auto_confirmed: false });
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
