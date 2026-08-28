'use strict';

/**
 * /api/marketplace — fixed-price Marketplace Buy Now checkout + order management.
 *
 * Buyer:  quote → create order (PaymentIntent) → confirm card client-side → poll order.
 * Seller: view own orders, advance fulfillment, relist a refunded/removed item.
 * Admin:  refund an order (Stripe refund + Stripe Tax reversal).
 *
 * Ownership is ALWAYS derived server-side from req.user.id. All money is computed server-side; the
 * browser never supplies price/tax/fee/proceeds. Checkout is gated by MARKETPLACE_CHECKOUT_ENABLED and,
 * for real money, by the Stripe environment — this router creates no live charge on its own.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const orders = require('../services/marketplaceOrderService');
const { marketplaceCheckoutEnabled } = require('../lib/launchGuards');

router.use(authMiddleware);

const fail = (res, e, next) => {
  if (e && e.status) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
  console.error('[marketplaceOrders]', e && e.message);
  return next ? next(e) : res.status(500).json({ success: false, message: 'Server error' });
};

// Public config the buyer UI reads to know whether Buy Now is live in this environment.
router.get('/config', (req, res) => res.json({ success: true, data: {
  checkout_enabled: marketplaceCheckoutEnabled(),
  stripe_publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
} }));

// ── Buyer ─────────────────────────────────────────────────────────────────────────────────────────────
// Read-only quote (no inventory claim, no PaymentIntent) — powers the order-review screen.
router.post('/orders/quote', async (req, res, next) => {
  try {
    const { item_id, fulfillment_method, address } = req.body || {};
    if (!item_id) return res.status(400).json({ success: false, message: 'item_id is required.' });
    return res.json({ success: true, data: await orders.quote(item_id, req.user.id, { fulfillment_method, address }) });
  } catch (e) { fail(res, e, next); }
});

// Create the order + PaymentIntent (claims the one-of-one item). Idempotency-Key header collapses retries.
router.post('/orders', async (req, res, next) => {
  try {
    const { item_id, fulfillment_method, ship_to, address } = req.body || {};
    if (!item_id) return res.status(400).json({ success: false, message: 'item_id is required.' });
    const idempotencyKey = req.get('Idempotency-Key') || undefined;
    const result = await orders.createOrder(item_id, req.user.id, { fulfillment_method, ship_to, address, idempotencyKey });
    return res.json({ success: true, data: result });
  } catch (e) { fail(res, e, next); }
});

router.get('/orders/mine', async (req, res, next) => {
  try { return res.json({ success: true, data: await orders.listForBuyer(req.user.id) }); }
  catch (e) { fail(res, e, next); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const o = await orders.getForBuyer(req.params.id, req.user.id);
    if (!o) return res.status(404).json({ success: false, message: 'Order not found.' });
    return res.json({ success: true, data: o });
  } catch (e) { fail(res, e, next); }
});

// ── Seller ────────────────────────────────────────────────────────────────────────────────────────────
router.get('/seller/orders', async (req, res, next) => {
  try { return res.json({ success: true, data: await orders.listForSeller(req.user.id) }); }
  catch (e) { fail(res, e, next); }
});

// Advance fulfillment: ready_for_pickup | picked_up | shipped | complete. Seller cannot touch any money field.
router.post('/seller/orders/:id/fulfillment', async (req, res, next) => {
  try {
    const { action, tracking_carrier, tracking_number } = req.body || {};
    const o = await orders.updateFulfillment(req.params.id, req.user.id, action, { tracking_carrier, tracking_number });
    return res.json({ success: true, data: o });
  } catch (e) { fail(res, e, next); }
});

// Explicitly relist a refunded/removed/draft item back to the public Marketplace (never automatic).
router.post('/seller/items/:itemId/relist', async (req, res, next) => {
  try { return res.json({ success: true, data: await orders.relistItem(req.params.itemId, req.user.id) }); }
  catch (e) { fail(res, e, next); }
});

// ── Admin ─────────────────────────────────────────────────────────────────────────────────────────────
router.post('/admin/orders/:id/refund', roleMiddleware(['admin']), async (req, res, next) => {
  try { return res.json({ success: true, data: await orders.refundOrder(req.params.id, { adminId: req.user.id }) }); }
  catch (e) { fail(res, e, next); }
});

module.exports = router;
