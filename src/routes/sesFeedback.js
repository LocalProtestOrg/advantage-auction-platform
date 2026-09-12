'use strict';

/**
 * SES feedback webhook — application-side ingestion of Amazon SES bounce/complaint/delivery notifications
 * (typically via SNS). Mounted at /api/ses.
 *
 * SECURITY (fail-closed):
 *   - DISABLED unless SES_FEEDBACK_WEBHOOK_SECRET is configured → 503. Nothing here activates sending.
 *   - Every request must present the shared secret (header x-webhook-secret or ?token=), compared with a
 *     timing-safe check → 401 otherwise.
 *   - SNS MESSAGE SIGNATURE VERIFICATION (added with migration 154, closing the Phase 2 audit finding):
 *     an SNS-shaped payload is cryptographically verified against the AWS signing certificate — the
 *     canonical string-to-sign is rebuilt per AWS's specification, the SigningCertURL host is validated
 *     as AWS-owned before it is ever fetched, and RSA-SHA1/RSA-SHA256 is checked. A signature that is
 *     PRESENT and WRONG is always refused (403); no configuration can override that. A failure to FETCH
 *     the certificate is an infrastructure fault rather than evidence of forgery, so it is recorded as
 *     `verify_unavailable` — and the callback is then QUARANTINED rather than ingested (migration 155).
 *     An unverified callback must never apply suppression, complaint, bounce, deliverability or
 *     consent state, because those are recipient-affecting and effectively irreversible. The payload is
 *     persisted whole and idempotently, verification is retried with backoff, and it is processed
 *     EXACTLY ONCE once authenticity is established. Nothing is ever silently discarded. The shared
 *     secret is required in every case.
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
const webhookSignature = require('../lib/webhookSignature');
const configService = require('../services/configService');
const quarantine = require('../services/webhookQuarantineService');
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
  // Keep the exact bytes: the quarantine digest must be of what arrived, not of a re-serialization.
  const rawBody = typeof payload === 'string' ? payload : null;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { return res.status(400).json({ error: 'Malformed payload' }); } }
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'Malformed payload' });

  // ── SNS message signature ────────────────────────────────────────────────────────────────────
  // Applies to any payload carrying an SNS envelope (both control messages and notifications). A
  // non-SNS payload has no signature to check and falls through to the parser, which rejects anything
  // it does not recognise.
  if (payload.Type && payload.Signature) {
    const required = await configService.get(null, 'event_partners.webhook_signature_required').catch(() => true);
    const result = await webhookSignature.verifySns(payload).catch((e) => ({ ok: false, status: 'verify_unavailable', reason: e.message }));
    if (!result.ok && result.status === 'rejected_signature') {
      // Authenticity failed. Always refused.
      console.error('[ses] REJECTED forged/invalid SNS signature:', result.reason,
        'TopicArn=' + (payload.TopicArn || '?'), 'MessageId=' + (payload.MessageId || '?'));
      return res.status(403).json({ error: 'Invalid message signature' });
    }
    if (!result.ok && result.status === 'verify_unavailable') {
      if (required === false) {
        console.warn('[ses] SNS signature not verified (verification disabled by policy):', result.reason);
      } else {
        // FAIL-SAFE, not fail-open: hold the callback, apply nothing, retry verification later.
        // Acknowledge with 202 so SNS stops retrying — we now own the retry, and the payload is durable.
        const held = await quarantine.quarantine({
          provider: 'ses_sns', payload, digest: webhookSignature.payloadDigest(rawBody || payload),
          signatureStatus: 'verify_unavailable', reason: result.reason,
          eventKind: payload.Type === 'Notification' ? 'ses_feedback' : payload.Type,
          remoteIpHash: null,
        }).catch((e) => ({ quarantined: false, error: e.message }));
        if (held && held.quarantined) {
          console.warn('[ses] SNS signature VERIFY UNAVAILABLE — callback QUARANTINED, no state applied:',
            result.reason, 'quarantine_id=' + held.id, held.duplicate ? '(already held)' : '');
          return res.status(202).json({ ok: true, quarantined: true, applied: false });
        }
        // Quarantine itself failed. Refuse rather than apply unverified state; SNS will retry.
        console.error('[ses] SNS unverifiable AND quarantine failed — refusing:', (held && held.error) || 'unknown');
        return res.status(503).json({ error: 'Verification unavailable' });
      }
    }
  } else if (payload.Type && !payload.Signature) {
    // An SNS-shaped payload with no signature at all is not a genuine SNS delivery — real SNS always
    // signs. Refused by default; an operator may allow it by setting the policy flag false.
    const required = await configService.get(null, 'event_partners.webhook_signature_required').catch(() => true);
    if (required !== false) {
      console.error('[ses] REJECTED SNS-shaped payload with no Signature field');
      return res.status(403).json({ error: 'Invalid message signature' });
    }
    console.warn('[ses] SNS-shaped payload accepted WITHOUT a signature (verification disabled by policy)');
  }

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
