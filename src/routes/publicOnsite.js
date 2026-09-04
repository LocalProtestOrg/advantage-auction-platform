'use strict';

/**
 * Public onsite personalization. Mounted at /api/public/onsite. No auth (visitor-scoped). Returns AT MOST
 * ONE treatment for the current page, gated by: personalization consent + the execution authorization
 * service + marketing.onsite.enabled. No consent or not authorized → { treatment: null } (page unaffected).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const onsite = require('../services/onsiteService');
const consentService = require('../services/consentService');
const execAuth = require('../services/executionAuthorizationService');
const pageIntentRegistry = require('../lib/pageIntentRegistry');

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const oneLine = (v, n = 512) => String(v == null ? '' : v).replace(/[\r\n\t\x00-\x1F\x7F]+/g, '').trim().slice(0, n);

// GET /api/public/onsite/treatment?visitor_id=&path=
router.get('/treatment', limiter, async (req, res, next) => {
  try {
    const visitorId = oneLine(req.query.visitor_id, 64);
    const path = oneLine(req.query.path, 512) || '/';
    if (!visitorId) return res.json({ treatment: null });

    // Personalization consent required for a targeted onsite treatment.
    const cur = await consentService.current('visitor', visitorId);
    const auth = await execAuth.authorize({ channel: 'onsite', scopeType: 'visitor', scopeId: visitorId, pagePath: path,
      consentState: consentService.snapshot(cur) });
    if (!auth.authorized) return res.json({ treatment: null, refused: auth.reasons });

    const cls = pageIntentRegistry.classify(path);
    const treatment = await onsite.treatmentFor({ scopeType: 'visitor', scopeId: visitorId, pagePath: path,
      pageIntent: cls ? cls.intent : null, hasMatchingInventory: false });
    return res.json({ treatment: treatment || null });
  } catch (e) { next(e); }
});

module.exports = router;
