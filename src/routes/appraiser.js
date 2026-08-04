'use strict';

/**
 * /api/appraiser — Railway-native Appraiser membership (Phase 2A, Stripe TEST).
 *
 * All endpoints require an authenticated Advantage.Bid user (Bearer or session cookie). The Price ID
 * is server-selected from env (STRIPE_APPRAISER_PRICE_ID) — the client can never submit a price or
 * amount. Session creation reuses the platform's financial guards (strictLimiter + Idempotency-Key).
 * Membership status is authoritative from the Stripe webhook, never from the success redirect.
 */

const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const { strictLimiter } = require('../middleware/rateLimit');
const idempotency = require('../middleware/idempotency');
const svc = require('../services/appraiserMembershipService');

// Same-origin base for success/cancel/return URLs (falls back to APP_BASE_URL in the service).
function originOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return host ? `${proto}://${host}` : null;
}

router.use(authMiddleware);

// Current user's membership status (authoritative source for the account/welcome UI).
router.get('/membership', async (req, res) => {
  try {
    const m = await svc.getForUser(req.user.id);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, membership: svc.publicView(m) });
  } catch (e) {
    console.error('[appraiser] membership read failed:', e.message);
    res.status(500).json({ success: false, message: 'Unable to load membership status.' });
  }
});

// Start checkout → returns the Stripe-hosted Checkout Session URL (subscription mode).
router.post('/checkout-session', strictLimiter, idempotency, async (req, res) => {
  try {
    if (!process.env.STRIPE_APPRAISER_PRICE_ID) {
      return res.status(503).json({ success: false, message: 'Membership checkout is not available yet. Please try again later.' });
    }
    const { url } = await svc.createCheckoutSession(req.user.id, originOf(req));
    res.json({ success: true, url });
  } catch (e) {
    console.error('[appraiser] checkout-session failed:', e.message);
    res.status(e.status || 500).json({ success: false, message: e.expose ? e.message : 'Unable to start checkout. Please try again.' });
  }
});

// Open the Stripe Customer Portal for the authenticated member (own customer only).
router.post('/billing-portal', strictLimiter, async (req, res) => {
  try {
    const { url } = await svc.createBillingPortalSession(req.user.id, originOf(req));
    res.json({ success: true, url });
  } catch (e) {
    console.error('[appraiser] billing-portal failed:', e.message);
    res.status(e.status || 500).json({ success: false, message: e.code === 'NO_CUSTOMER' ? 'No billing account found yet.' : 'Unable to open billing. Please try again.' });
  }
});

module.exports = router;
