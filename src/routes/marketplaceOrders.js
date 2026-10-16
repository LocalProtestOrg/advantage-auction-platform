'use strict';

/**
 * /api/marketplace — fixed-price Marketplace Buy Now checkout + order management.
 *
 * Buyer:  quote → create order (PaymentIntent, server-confirmed) → post card → server checks + confirms → poll.
 * Seller: view own orders, advance fulfillment, relist a refunded/removed item.
 * Admin:  list storefront orders; refund an order (refund + sales-tax reversal).
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
const issues = require('../services/marketplaceOrderIssueService');
const moderation = require('../services/marketplaceModerationService');
// Seller routes pass through one checkpoint that resolves the seller company from the session (never the request).
const seller = require('../middleware/requireSellerPermission');
const { marketplaceCheckoutEnabled } = require('../lib/launchGuards');

// PUBLIC (no login): the buyer UI reads this to decide whether to show Buy Now to every visitor, including
// logged-out ones. It exposes only the checkout flag and the publishable (browser-safe) key. Registered BEFORE
// the auth middleware; every other route below keeps its auth unchanged.
router.get('/config', (req, res) => res.json({ success: true, data: {
  checkout_enabled: marketplaceCheckoutEnabled(),
  stripe_publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
} }));

router.use(authMiddleware);

const fail = (res, e, next) => {
  if (e && e.status) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
  console.error('[marketplaceOrders]', e && e.message);
  return next ? next(e) : res.status(500).json({ success: false, message: 'Server error' });
};

// ── Buyer ─────────────────────────────────────────────────────────────────────────────────────────────
// Read-only quote (no inventory claim, no PaymentIntent) — powers the order-review screen. Gated behind the
// checkout flag in the service (it calls tax calculation).
router.post('/orders/quote', async (req, res, next) => {
  try {
    const { item_id, fulfillment_method, address, ship_to } = req.body || {};
    if (!item_id) return res.status(400).json({ success: false, message: 'item_id is required.' });
    return res.json({ success: true, data: await orders.quote(item_id, req.user.id, { fulfillment_method, address, ship_to }) });
  } catch (e) { fail(res, e, next); }
});

// Create the order + PaymentIntent (claims the one-of-one item). Idempotency-Key header collapses retries.
router.post('/orders', async (req, res, next) => {
  try {
    const { item_id, fulfillment_method, ship_to, address, expected_item_price_cents, expected_shipping_cents, policies_acknowledged } = req.body || {};
    if (!item_id) return res.status(400).json({ success: false, message: 'item_id is required.' });
    const idempotencyKey = req.get('Idempotency-Key') || undefined;
    // expected_*: what the buyer saw on the review screen. Used ONLY to refuse a changed price — never to set one.
    const result = await orders.createOrder(item_id, req.user.id, { fulfillment_method, ship_to, address, idempotencyKey,
      expectedItemPriceCents: expected_item_price_cents, expectedShippingCents: expected_shipping_cents,
      policiesAcknowledged: policies_acknowledged === true });
    return res.json({ success: true, data: result });
  } catch (e) { fail(res, e, next); }
});

// Pay an order: the browser posts a PaymentMethod id (created from the card field); the server checks the card
// (prepaid refused with 422) and confirms server-side. With no payment_method_id it finalizes after the browser
// completed card authentication. Idempotency-Key header collapses retries of the same click.
router.post('/orders/:id/pay', async (req, res, next) => {
  try {
    const { payment_method_id } = req.body || {};
    const idempotencyKey = req.get('Idempotency-Key') || undefined;
    const out = await orders.payOrder(req.params.id, req.user.id, { paymentMethodId: payment_method_id, idempotencyKey });
    return res.json({ success: true, data: out });
  } catch (e) { fail(res, e, next); }
});

router.get('/orders/mine', async (req, res, next) => {
  try { return res.json({ success: true, data: await orders.listForBuyer(req.user.id) }); }
  catch (e) { fail(res, e, next); }
});

// Buyer issues (complaints) — always on the buyer's OWN order; the seller is taken from the order, never from the request.
router.get('/issues/mine', async (req, res, next) => {
  try { return res.json({ success: true, data: await issues.listForBuyer(req.user.id) }); }
  catch (e) { fail(res, e, next); }
});
router.post('/orders/:id/issues', async (req, res, next) => {
  try {
    const { category, message } = req.body || {};
    return res.status(201).json({ success: true, data: await issues.openIssue(req.params.id, req.user.id, { category, message }) });
  } catch (e) { fail(res, e, next); }
});
router.get('/orders/:id/history', async (req, res, next) => {
  try {
    const h = await orders.orderHistory(req.params.id, { buyerUserId: req.user.id });
    if (!h) return res.status(404).json({ success: false, message: 'Order not found.' });
    return res.json({ success: true, data: h });
  } catch (e) { fail(res, e, next); }
});

// Report a public listing (signed-in buyers). The report is tied to the listing's own seller.
router.post('/items/:id/report', async (req, res, next) => {
  try {
    const { category, message } = req.body || {};
    return res.status(201).json({ success: true, data: await moderation.reportItem(req.params.id, req.user.id, { category, message }) });
  } catch (e) { fail(res, e, next); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const o = await orders.getForBuyer(req.params.id, req.user.id);
    if (!o) return res.status(404).json({ success: false, message: 'Order not found.' });
    return res.json({ success: true, data: o });
  } catch (e) { fail(res, e, next); }
});

// ── Seller ────────────────────────────────────────────────────────────────────────────────────────────
router.get('/seller/orders', seller('company.orders.view'), async (req, res, next) => {
  try { return res.json({ success: true, data: await orders.listForSeller(req.sellerCtx) }); }
  catch (e) { fail(res, e, next); }
});

// Advance fulfillment: ready_for_pickup | picked_up | shipped | complete. Seller cannot touch any money field.
router.post('/seller/orders/:id/fulfillment', seller('company.orders.fulfil'), async (req, res, next) => {
  try {
    const { action, tracking_carrier, tracking_number } = req.body || {};
    const o = await orders.updateFulfillment(req.params.id, req.sellerCtx, action, { tracking_carrier, tracking_number });
    return res.json({ success: true, data: o });
  } catch (e) { fail(res, e, next); }
});

router.get('/seller/orders/:id/history', seller('company.orders.view'), async (req, res, next) => {
  try {
    const h = await orders.orderHistory(req.params.id, { seller: req.sellerCtx });
    if (!h) return res.status(404).json({ success: false, message: 'Order not found.' });
    return res.json({ success: true, data: h });
  } catch (e) { fail(res, e, next); }
});
router.get('/seller/issues', seller('company.issues.view'), async (req, res, next) => {
  try { return res.json({ success: true, data: await issues.listForSeller(req.sellerCtx) }); }
  catch (e) { fail(res, e, next); }
});
router.post('/seller/issues/:id/respond', seller('company.issues.respond'), async (req, res, next) => {
  try { return res.json({ success: true, data: await issues.respond(req.params.id, req.sellerCtx, { response: (req.body || {}).response }) }); }
  catch (e) { fail(res, e, next); }
});

// Explicitly relist a refunded/removed/draft item back to the public Marketplace (never automatic).
router.post('/seller/items/:itemId/relist', seller('company.inventory.edit'), async (req, res, next) => {
  try { return res.json({ success: true, data: await orders.relistItem(req.params.itemId, req.sellerCtx) }); }
  catch (e) { fail(res, e, next); }
});

// ── Admin ─────────────────────────────────────────────────────────────────────────────────────────────
// Storefront order list: status, amounts, fee, proceeds, fulfillment, payout flag, refund state. Read-only;
// payout stays a manual settlement step (no money moves from here).
router.get('/admin/orders', roleMiddleware(['admin']), async (req, res, next) => {
  try { return res.json({ success: true, data: await orders.listForAdmin({ status: req.query.status, limit: req.query.limit }) }); }
  catch (e) { fail(res, e, next); }
});

// Admin overrides: a named administrator and a written reason, both kept in the order's permanent history.
router.post('/admin/orders/:id/refund', roleMiddleware(['admin']), async (req, res, next) => {
  try { return res.json({ success: true, data: await orders.refundOrder(req.params.id, { adminId: req.user.id, reason: (req.body || {}).reason }) }); }
  catch (e) { fail(res, e, next); }
});
router.post('/admin/orders/:id/payout-hold', roleMiddleware(['admin']), async (req, res, next) => {
  try {
    const { hold, reason } = req.body || {};
    return res.json({ success: true, data: await orders.setPayoutHold(req.params.id, req.user.id, { hold: hold !== false, reason }) });
  } catch (e) { fail(res, e, next); }
});
router.get('/admin/orders/:id/history', roleMiddleware(['admin']), async (req, res, next) => {
  try {
    const h = await orders.orderHistory(req.params.id, { admin: true });
    if (!h) return res.status(404).json({ success: false, message: 'Order not found.' });
    return res.json({ success: true, data: h });
  } catch (e) { fail(res, e, next); }
});
router.get('/admin/issues', roleMiddleware(['admin']), async (req, res, next) => {
  try { return res.json({ success: true, data: await issues.listForAdmin({ status: req.query.status }) }); }
  catch (e) { fail(res, e, next); }
});
router.post('/admin/issues/:id/resolve', roleMiddleware(['admin']), async (req, res, next) => {
  try {
    const { status, resolution_note } = req.body || {};
    return res.json({ success: true, data: await issues.resolve(req.params.id, req.user.id, { status, resolution_note }) });
  } catch (e) { fail(res, e, next); }
});

module.exports = router;
