'use strict';

/**
 * /api/watchdog — results from the scheduled browser watchdog (scripts/watchdog-browser.js). HMAC-authenticated with
 * WATCHDOG_INGEST_KEY (src/services/watchdog/ingestAuth.js); refused entirely while the key is not configured. Reads
 * its own raw body (the global JSON parser skips this path) because the signature covers the exact bytes.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../db');
const auth = require('../services/watchdog/ingestAuth');
const runner = require('../services/watchdog/runner');

const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many submissions.' } });

router.post('/ingest', limiter, express.raw({ type: '*/*', limit: '512kb' }), async (req, res, next) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const v = auth.verify({ timestamp: req.get('x-watchdog-timestamp'), signature: req.get('x-watchdog-signature'), rawBody: raw });
    if (!v.ok) return res.status(v.status).json({ success: false, code: v.code });
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ success: false, code: 'BODY_INVALID' }); }
    const out = await runner.recordExternal({ db, source: 'browser', results: payload && payload.results });
    await runner.sendAlerts({ db }).catch((e) => console.error('[watchdog] alert failed:', e.message));
    return res.json({ success: true, data: out });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ success: false, code: 'RESULTS_INVALID', message: e.message });
    next(e);
  }
});

module.exports = router;
