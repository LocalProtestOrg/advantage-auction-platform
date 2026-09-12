'use strict';

/**
 * /api/webhooks/email — inbound Event Partner mail from the parsed-inbound provider.
 *
 * This endpoint receives company correspondence, so it is treated as hostile input throughout:
 *
 *   - The provider callback must authenticate. Postmark does not sign payloads, so authenticity rests
 *     on a secret only we and Postmark know (URL token, `x-webhook-secret`, or HTTP Basic), compared
 *     in constant time, plus an optional source-address allowlist.
 *   - A rejected callback is RECORDED as rejected, not silently dropped, so a forgery attempt is
 *     visible in `event_partner_webhook_deliveries`.
 *   - Replay is blocked twice: on the digest of the exact payload, and on the provider's message id.
 *   - The master gate `event_partners.inbound_enabled` ships OFF; until the Owner turns it on this
 *     endpoint answers 404 and stores nothing.
 *   - The response is always a bare acknowledgement. It never reflects back which company, thread or
 *     classification was involved, so the endpoint cannot be used as an oracle.
 *
 * Nothing here sends email, and nothing here can authorize: `inboundEmailService` performs only the
 * safe stopping/recording actions and escalates the rest.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const configService = require('../services/configService');
const signature = require('../lib/webhookSignature');
const inbound = require('../services/eventPartners/inboundEmailService');

// Postmark retries, but a legitimate inbound volume is small. This is generous for real traffic and
// tight enough to make brute-forcing the secret pointless.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false },
});

// Capture the exact bytes so the digest is of what actually arrived, not of a re-serialization.
const captureRaw = express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf && buf.length ? buf.toString('utf8') : ''; },
});

const allowedIps = () => String(process.env.POSTMARK_INBOUND_IPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// POST /api/webhooks/email/inbound
router.post('/inbound', webhookLimiter, captureRaw, async (req, res) => {
  const remoteIp = req.headers['x-forwarded-for'] || req.ip || '';
  const digest = signature.payloadDigest(req.rawBody || req.body || null);

  // The gate is checked before authentication so a disabled endpoint reveals nothing at all.
  const enabled = await configService.get(null, 'event_partners.inbound_enabled').catch(() => false);
  if (enabled !== true) return res.status(404).json({ ok: false });

  const secret = process.env.EVENT_PARTNER_INBOUND_SECRET || '';
  const verdict = signature.verifyPostmark(req, {
    expectedSecret: secret, remoteIp, allowedIps: allowedIps(),
  });

  if (!verdict.ok) {
    // Recorded, then refused. An attacker learns only that they were refused.
    await inbound.recordRejection({
      provider: 'postmark', digest, signatureStatus: verdict.status,
      remoteIp, reason: verdict.reason,
    });
    return res.status(403).json({ ok: false });
  }

  try {
    const normalized = inbound.fromPostmark(req.body || {});
    const result = await inbound.ingest(normalized, {
      digest, signatureStatus: verdict.status, remoteIp, provider: 'postmark',
    });
    // 200 for a duplicate too: the provider must stop retrying something we already have.
    return res.status(200).json({ ok: true, duplicate: !!result.duplicate });
  } catch (e) {
    if (e && e.code === 'INBOUND_DISABLED') return res.status(404).json({ ok: false });
    // A 500 tells the provider to retry, which is right for a transient fault on our side. The
    // payload digest makes that retry idempotent.
    console.error('[event-partner-inbound]', e && e.message);
    return res.status(500).json({ ok: false });
  }
});

// GET /api/webhooks/email/inbound — provider setup probes expect a reachable URL, and a health check
// must not require the secret. Reveals nothing beyond whether the endpoint exists.
router.get('/inbound', webhookLimiter, async (req, res) => {
  const enabled = await configService.get(null, 'event_partners.inbound_enabled').catch(() => false);
  if (enabled !== true) return res.status(404).json({ ok: false });
  res.json({ ok: true, accepts: 'POST' });
});

module.exports = router;
