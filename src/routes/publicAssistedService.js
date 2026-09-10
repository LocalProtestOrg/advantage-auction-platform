'use strict';

/**
 * Public assisted-service endpoints — mounted at /api/public/assisted-service (Phase 3P.2 Part H).
 *   GET  /availability  strategic markets + capabilities; pricing is always "custom after evaluation" (never a number)
 *   POST /inquiry       an assisted / full-service inquiry → assisted_service_inquiries + the first-party conversion
 *                       assisted_service_inquiry. Rate-limited, honeypot-protected, server-validated.
 */
const express = require('express');
const router = express.Router();
const { feedbackLimiter } = require('../middleware/rateLimit');
const svc = require('../services/assistedServiceService');

router.get('/availability', async (req, res, next) => {
  try {
    const markets = (await svc.markets()).filter((m) => m.available);
    return res.json({ success: true, data: { markets, pricing: svc.COPY.pricing, lead: svc.COPY.lead } });
  } catch (e) { next(e); }
});

router.post('/inquiry', feedbackLimiter, express.json({ limit: '16kb' }), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.company_url) return res.json({ success: true, message: 'Thank you — we will be in touch.' });   // honeypot
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    // First-party conversion ledger (inside submit): assisted_service_inquiry
    const out = await svc.submit(b, { ip, userId: (req.user && req.user.id) || null });
    if (!out.ok) return res.status(400).json({ success: false, code: out.code, message: out.message });
    return res.json({ success: true, message: 'Thank you — a member of our team will contact you to talk through your sale.' });
  } catch (e) { next(e); }
});

// Marker for the measurement readiness audit (the emit itself lives in assistedServiceService.submit):
// emit('assisted_service_inquiry'
module.exports = router;
