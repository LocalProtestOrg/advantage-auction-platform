'use strict';

/**
 * Meta webhook receiver — mounted at /api/meta. server.js skips the global JSON parser for
 * /api/meta/webhook so this router receives the RAW body needed for X-Hub-Signature-256 verification.
 *
 *   GET  /api/meta/webhook  — Meta verification handshake (hub.mode/hub.verify_token/hub.challenge).
 *   POST /api/meta/webhook  — authenticated deliveries → metaWebhookService.processDelivery (idempotent, bounded).
 *
 * Fail-closed: 503 when META_APP_SECRET / META_WEBHOOK_VERIFY_TOKEN are unset; 401 on a bad signature.
 * Always 200 after successful authentication (Meta retries non-2xx; processing errors are recorded durably,
 * not re-thrown). Nothing here publishes, replies, or alters Page settings.
 */
const express = require('express');
const router = express.Router();
const svc = require('../services/metaWebhookService');

router.get('/webhook', (req, res) => {
  const out = svc.verifyChallenge(req.query || {});
  res.status(out.status).type('text/plain').send(out.body);
});

router.post('/webhook', express.raw({ type: () => true, limit: '512kb' }), async (req, res) => {
  const sig = svc.verifySignature(req.body, req.get('x-hub-signature-256'));
  if (!sig.ok) return res.status(sig.status).json({ error: sig.error });
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'Malformed payload' }); }
  try {
    const summary = await svc.processDelivery(payload);
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('[meta-webhook] processing failed:', e.message);
    return res.status(200).json({ ok: false, recorded: false });
  }
});

module.exports = router;
