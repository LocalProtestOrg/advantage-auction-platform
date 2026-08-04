'use strict';

/**
 * /api/estate-sale — Individual Estate Sale Promotion (Phase 2B, Stripe TEST).
 *
 * Homeowner-facing. All endpoints require an authenticated user. The $39 price is server-selected
 * from env (STRIPE_ESTATE_SALE_PRICE_ID) — the client can never submit a price. Creating a listing
 * requires a paid promotion; submitting consumes it (the paywall gate). Draft editing + photos reuse
 * the existing /api/org/events/* endpoints (the customer never sees "organization").
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { strictLimiter } = require('../middleware/rateLimit');
const idempotency = require('../middleware/idempotency');
const svc = require('../services/estateSalePromotionService');

function originOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return host ? `${proto}://${host}` : null;
}
function fail(res, e, fallback) {
  console.error('[estate-sale] ' + (e && e.code ? e.code : 'error') + ':', e && e.message);
  res.status((e && e.status) || 500).json({ success: false, message: (e && e.expose) ? e.message : fallback });
}

router.use(authMiddleware);

// Homeowner dashboard: available promotions + their estate sales and statuses.
router.get('/promotion', async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ success: true, ...(await svc.statusForUser(req.user.id)) }); }
  catch (e) { fail(res, e, 'Unable to load your Estate Sale Promotion.'); }
});

// Start the $39 one-time checkout → Stripe-hosted Checkout Session URL.
router.post('/checkout-session', strictLimiter, idempotency, async (req, res) => {
  try {
    if (!process.env.STRIPE_ESTATE_SALE_PRICE_ID) return res.status(503).json({ success: false, message: 'Estate Sale Promotion is not available yet. Please try again later.' });
    const { url } = await svc.createCheckoutSession(req.user.id, originOf(req));
    res.json({ success: true, url });
  } catch (e) { fail(res, e, 'Unable to start checkout. Please try again.'); }
});

// Create the estate sale draft (requires a paid promotion; software sets sale_type=estate_sale).
router.post('/events', strictLimiter, async (req, res) => {
  try { const event = await svc.createEstateSale(req.user.id, req.body || {}); res.status(201).json({ success: true, event }); }
  catch (e) { fail(res, e, 'Unable to create your estate sale. Please try again.'); }
});

// Submit for review — consumes the promotion.
router.post('/events/:id/submit', strictLimiter, async (req, res) => {
  try { const event = await svc.submitEstateSale(req.user.id, req.params.id); res.json({ success: true, event }); }
  catch (e) { fail(res, e, 'Unable to submit your estate sale. Please try again.'); }
});

module.exports = router;
