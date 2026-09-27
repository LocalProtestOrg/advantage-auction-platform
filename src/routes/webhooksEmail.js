'use strict';

/**
 * /api/webhooks/email — inbound campaign replies, delivered by Amazon SES.
 *
 * Replies to reply.advantage.bid are received by an SES receipt rule, stored whole in S3 and announced by an
 * SNS notification to POST /api/webhooks/email/ses-inbound. (The earlier Postmark parsed-inbound provider is
 * unavailable and has been removed.) The body is company correspondence, so it is treated as hostile input:
 *
 *   - The shared webhook secret (SES_FEEDBACK_WEBHOOK_SECRET, the same one the SES feedback subscription
 *     uses) must be presented as ?token= or x-webhook-secret, compared in constant time.
 *   - The SNS message signature must verify, AND the TopicArn must be OUR inbound topic
 *     (SES_INBOUND_TOPIC_ARN). A valid signature alone only proves the message came from SNS, not from us.
 *   - When the signature cannot be checked yet (certificate fetch failing), the callback is quarantined and
 *     retried by the quarantine worker; nothing is applied meanwhile.
 *   - SubscriptionConfirmation is never auto-confirmed: its one-time URL is written to the operator log.
 *   - A verified notification is recorded durably BEFORE it is acknowledged, then processed; each
 *     programme's own inbound switch decides whether it is processed now or held (see sesInbound).
 *   - The response never reveals which company, campaign or classification was involved.
 *
 * Nothing here sends email to a sender, and nothing here can authorize.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const signature = require('../lib/webhookSignature');
const quarantine = require('../services/webhookQuarantineService');
const sesInbound = require('../services/inboundMail/sesInbound');
const { timingSafeEqual, isAwsSnsSubscribeUrl } = require('./sesFeedback');

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false },
});

// SNS posts text/plain; accept JSON too. The notification itself is small (the message is in S3).
const body = express.text({ type: ['text/*', 'application/json'], limit: '256kb' });

// POST /api/webhooks/email/ses-inbound
router.post('/ses-inbound', webhookLimiter, body, async (req, res) => {
  const secret = process.env.SES_FEEDBACK_WEBHOOK_SECRET;
  const cfg = sesInbound.config();
  if (!secret || !cfg.topicArn || !cfg.bucket) return res.status(503).json({ ok: false });

  const presented = req.get('x-webhook-secret') || req.query.token;
  if (!timingSafeEqual(presented, secret)) return res.status(401).json({ ok: false });

  let payload = req.body;
  const rawBody = typeof payload === 'string' ? payload : null;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { return res.status(400).json({ ok: false }); } }
  if (!payload || typeof payload !== 'object' || !payload.Type || !payload.Signature) {
    console.error('[inbound] REJECTED: not a signed SNS message');
    return res.status(403).json({ ok: false });
  }
  if (payload.TopicArn !== cfg.topicArn) {
    console.error('[inbound] REJECTED: SNS topic is not the inbound topic', 'MessageId=' + (payload.MessageId || '?'));
    return res.status(403).json({ ok: false });
  }

  const verdict = await signature.verifySns(payload).catch((e) => ({ ok: false, status: 'verify_unavailable', reason: e.message }));
  if (!verdict.ok && verdict.status === 'rejected_signature') {
    console.error('[inbound] REJECTED invalid SNS signature:', verdict.reason, 'MessageId=' + (payload.MessageId || '?'));
    return res.status(403).json({ ok: false });
  }
  if (!verdict.ok) {
    const held = await quarantine.quarantine({
      provider: 'ses_inbound', payload, digest: signature.payloadDigest(rawBody || payload),
      signatureStatus: 'verify_unavailable', reason: verdict.reason,
      eventKind: payload.Type === 'Notification' ? 'ses_inbound' : payload.Type, remoteIpHash: null,
    }).catch((e) => ({ quarantined: false, error: e.message }));
    if (held && held.quarantined) {
      console.warn('[inbound] SNS signature not verifiable yet: callback quarantined, nothing applied. id=' + held.id);
      return res.status(202).json({ ok: true });
    }
    console.error('[inbound] unverifiable and quarantine failed; refusing so SNS retries');
    return res.status(503).json({ ok: false });
  }

  if (payload.Type === 'SubscriptionConfirmation' || payload.Type === 'UnsubscribeConfirmation') {
    if (payload.Type === 'SubscriptionConfirmation' && isAwsSnsSubscribeUrl(payload.SubscribeURL)) {
      console.log('[inbound] SNS SubscriptionConfirmation for the INBOUND topic (verified). An operator confirms it by opening this one-time URL EXACTLY ONCE:');
      console.log('[inbound] SubscribeURL: ' + payload.SubscribeURL);
    } else {
      console.log('[inbound] SNS control message received (not auto-confirmed):', payload.Type);
    }
    return res.status(200).json({ ok: true });
  }

  try {
    const out = await sesInbound.handleVerifiedNotification(payload);
    if (!out.accepted) {
      // A well-formed notification we will not act on. Acknowledge so SNS stops retrying; the message
      // itself is still in S3. A configuration mismatch is logged loudly for the operator.
      if (!out.ignorable) console.error('[inbound] notification refused:', out.reason, 'MessageId=' + (payload.MessageId || '?'));
      return res.status(200).json({ ok: true });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    // Recording failed (for example the database is briefly unavailable). A 500 makes SNS retry, and
    // recording is idempotent on the SES message id.
    console.error('[inbound] could not record notification:', e.message);
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
