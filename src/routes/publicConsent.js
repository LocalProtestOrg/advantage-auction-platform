'use strict';

/**
 * Public consent endpoints — first-party, visitor-scoped. Mounted at /api/public/consent. No auth (a
 * visitor is identified by their first-party visitor_id). GET returns current state; POST appends a
 * decision. essential is always granted; advertising defaults denied. No dark patterns.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const consent = require('../services/consentService');

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const oneLine = (v, n = 64) => String(v == null ? '' : v).replace(/[\r\n\t\x00-\x1F\x7F]+/g, '').trim().slice(0, n);

// GET /api/public/consent?visitor_id=...
router.get('/', limiter, async (req, res, next) => {
  try {
    const vid = oneLine(req.query.visitor_id);
    if (!vid) return res.json({ success: true, consent: await consent.current('visitor', '') });
    res.json({ success: true, consent: await consent.current('visitor', vid), policy_version: consent.POLICY_VERSION });
  } catch (e) { next(e); }
});

// POST /api/public/consent  { visitor_id, categories: { analytics, personalization, advertising } }
router.post('/', limiter, express.json({ limit: '8kb' }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const vid = oneLine(b.visitor_id);
    if (!vid) return res.status(400).json({ success: false, message: 'visitor_id required' });
    const cats = (b.categories && typeof b.categories === 'object') ? b.categories : {};
    // Only accept the three optional categories from the public banner; essential is implicit.
    const clean = {};
    ['analytics', 'personalization', 'advertising'].forEach((c) => {
      if (cats[c] === 'granted' || cats[c] === 'denied' || cats[c] === 'withdrawn') clean[c] = cats[c];
    });
    await consent.record({ scopeType: 'visitor', scopeId: vid, categories: clean, source: oneLine(b.source) || 'banner' });
    res.json({ success: true, consent: await consent.current('visitor', vid), policy_version: consent.POLICY_VERSION });
  } catch (e) { next(e); }
});

module.exports = router;
