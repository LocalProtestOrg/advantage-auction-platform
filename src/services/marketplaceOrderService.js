'use strict';

/**
 * marketplaceOrderService — fixed-price Marketplace "Buy Now" commerce.
 *
 * This is the RETAIL order path. It is deliberately SEPARATE from auction `payments` /
 * `buyer_auction_invoices` (which are hammer + buyer-premium specific). It REUSES the platform's
 * existing certified primitives — the same Stripe client + API-version pin, the tax Calculation API
 * (taxCalculationService), the per-seller configurable platform fee (seller_profiles.platform_fee_bps +
 * the canonical cents-safe bps math), and the manual-settlement philosophy (payout is a FLAG, never an
 * automatic transfer). No second payment platform is introduced.
 *
 * Money policy (owner-decided):
 *   • Platform fee  = seller's configured platform_fee_bps applied to the ITEM PRICE only
 *                     (NOT tax, NOT shipping). One configurable Professional Seller rate; no
 *                     Marketplace-specific commission setting.
 *   • Seller proceeds = item_price + shipping − platform_fee.  Sales tax is NEVER seller proceeds.
 *   • Buyer total   = item_price + shipping + sales_tax.  The platform fee is NOT a buyer-facing charge.
 *   • Tax           = Stripe Tax (buyer address jurisdiction); flag-gated OFF → $0, no Stripe call.
 *   • Payout        = fulfillment completion sets payout_eligible=true; it moves NO money. Advantage.Bid
 *                     retains manual settlement control.
 *
 * Everything money-related is computed server-side; browser-supplied amounts are never trusted.
 */

const db = require('../db');
const Stripe = require('stripe');
const { withTransaction } = require('../utils/withTransaction');
const auditService = require('./auditService');
const taxService = require('./taxCalculationService');
const billingTerms = require('./billingTermsService');
const { isProfessional } = require('../lib/sellerBranding');
const { marketplaceCheckoutEnabled } = require('../lib/launchGuards');

const STRIPE_API_VERSION = '2026-03-25.dahlia'; // matches paymentService/taxCalculationService pin
const CLAIM_TTL_MINUTES = 30;                    // an in-flight checkout holds a one-of-one item this long

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

// ── Money ────────────────────────────────────────────────────────────────────────────────────────────
// The seller's configured Professional Seller platform rate (per-seller override; default 4%). Reused
// verbatim from the auction settlement model — ONE rate governs applicable Professional Seller sales.
function feeBpsForSeller(seller) {
  return seller.platform_fee_bps != null ? Number(seller.platform_fee_bps) : billingTerms.DEFAULT_PRO_PLATFORM_FEE_BPS;
}
// Deterministic, cents-safe breakdown. platform fee = bps of ITEM PRICE only.
function computeBreakdown({ itemPriceCents, shippingCents, taxCents, feeBps }) {
  const item = Math.max(0, Math.round(Number(itemPriceCents) || 0));
  const ship = Math.max(0, Math.round(Number(shippingCents) || 0));
  const tax = Math.max(0, Math.round(Number(taxCents) || 0));
  const platform_fee_cents = billingTerms.lotBuyerPremiumCents(item, feeBps); // canonical bps-of(itemPrice)
  const seller_proceeds_cents = item + ship - platform_fee_cents;             // tax EXCLUDED from proceeds
  const total_charge_cents = item + ship + tax;                              // buyer pays goods+shipping+tax
  return {
    item_price_cents: item, shipping_cents: ship, tax_cents: tax,
    platform_fee_bps: feeBps, platform_fee_cents, seller_proceeds_cents, total_charge_cents,
  };
}

async function loadBuyerTaxAddress(buyerUserId, runner = db) {
  const u = (await runner.query(
    `SELECT tax_address_line1, tax_address_line2, tax_city, tax_state, tax_postal_code, tax_country
       FROM users WHERE id = $1`, [buyerUserId])).rows[0];
  if (!u) return null;
  return { line1: u.tax_address_line1, line2: u.tax_address_line2, city: u.tax_city,
    state: u.tax_state, postal_code: u.tax_postal_code, country: u.tax_country || 'US' };
}

// Load an item joined to its seller, with the purchase-eligibility validations that don't need a lock.
async function loadItemForPurchase(itemId, buyerUserId, fulfillmentMethod, runner = db) {
  const row = (await runner.query(
    `SELECT mi.*, sp.user_id AS seller_user_id, sp.seller_type, sp.platform_fee_bps
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.id = $1`, [itemId])).rows[0];
  if (!row) throw err(404, 'ITEM_NOT_FOUND', 'This item is no longer available.');
  if (!isProfessional(row.seller_type)) throw err(409, 'NOT_PROFESSIONAL', 'This item is not purchasable.');
  if (row.seller_user_id === buyerUserId) throw err(403, 'CANNOT_BUY_OWN', 'You cannot purchase your own listing.');
  if (!(Number(row.price_cents) > 0)) throw err(422, 'PRICE_INVALID', 'This item has no valid price.');
  const method = fulfillmentMethod === 'shipping' ? 'shipping' : 'pickup';
  if (method === 'shipping' && !row.shippable) throw err(422, 'SHIPPING_UNAVAILABLE', 'This item is not available for shipping.');
  const shippingCents = method === 'shipping' ? Math.max(0, parseInt(row.shipping_cost_cents, 10) || 0) : 0;
  return { item: row, method, shippingCents, feeBps: feeBpsForSeller(row) };
}

// ── Read-only quote (no inventory claim, no PaymentIntent) — powers the buyer's order-review screen ────
async function quote(itemId, buyerUserId, opts = {}) {
  const { item, method, shippingCents, feeBps } = await loadItemForPurchase(itemId, buyerUserId, opts.fulfillment_method);
  if (item.status !== 'active') throw err(409, 'NOT_AVAILABLE', 'This item is no longer available for purchase.');
  const address = opts.address || await loadBuyerTaxAddress(buyerUserId);
  const taxable = item.price_cents + shippingCents;
  const tax = await taxService.computeTax({
    buyerUserId, taxableBaseCents: taxable, address, reference: 'marketplace-quote:' + itemId,
  });
  const b = computeBreakdown({ itemPriceCents: item.price_cents, shippingCents, taxCents: tax.taxCents, feeBps });
  return {
    item: { id: item.id, title: item.title, thumbnail_url: item.thumbnail_url, seller_id: item.seller_id },
    fulfillment_method: method, tax_enabled: tax.enabled, tax_exempt: tax.exempt, breakdown: b,
  };
}

// ── Create order + PaymentIntent (claims the one-of-one item atomically) ──────────────────────────────
// tx1: lock item, verify available (or reclaim an EXPIRED pending claim), fail any stale live order,
//      INSERT the order (pending, intent NULL), flip item → pending_purchase with an expiry. COMMIT.
// then: compute tax (grows total), create Stripe PaymentIntent OUTSIDE any tx.
// tx2: attach intent id + tax calc id + final tax/total. On Stripe failure: release item, fail order.
async function createOrder(itemId, buyerUserId, opts = {}) {
  if (!marketplaceCheckoutEnabled()) throw err(403, 'CHECKOUT_DISABLED', 'Marketplace checkout is not currently available.');
  const pre = await loadItemForPurchase(itemId, buyerUserId, opts.fulfillment_method);
  const { method, shippingCents, feeBps } = pre;

  let order;
  await withTransaction(async (client) => {
    const item = (await client.query('SELECT * FROM marketplace_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0];
    if (!item) throw err(404, 'ITEM_NOT_FOUND', 'This item is no longer available.');
    const available = item.status === 'active'
      || (item.status === 'pending_purchase' && item.pending_expires_at && new Date(item.pending_expires_at) < new Date());
    if (!available) throw err(409, 'NOT_AVAILABLE', 'This item is no longer available for purchase.');
    // Reclaiming an expired claim: retire the stale live order so the partial unique index frees up.
    if (item.status === 'pending_purchase') {
      await client.query(
        `UPDATE marketplace_orders SET payment_status = 'failed', updated_at = now()
          WHERE marketplace_item_id = $1 AND payment_status IN ('pending','processing')`, [itemId]);
    }
    const b = computeBreakdown({ itemPriceCents: item.price_cents, shippingCents, taxCents: 0, feeBps });
    const shipTo = method === 'shipping' && opts.ship_to ? JSON.stringify(opts.ship_to) : null;
    const inserted = await client.query(
      `INSERT INTO marketplace_orders
         (marketplace_item_id, seller_id, buyer_user_id, item_price_cents, shipping_cents, tax_cents,
          platform_fee_bps, platform_fee_cents, seller_proceeds_cents, total_charge_cents,
          fulfillment_method, ship_to, payment_status, is_demo, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11::jsonb,'pending',$12,$13)
       RETURNING *`,
      [itemId, item.seller_id, buyerUserId, b.item_price_cents, b.shipping_cents,
       b.platform_fee_bps, b.platform_fee_cents, b.seller_proceeds_cents, b.total_charge_cents,
       method, shipTo, !!item.is_demo, opts.idempotencyKey || null]);
    order = inserted.rows[0];
    await client.query(
      `UPDATE marketplace_items
          SET status = 'pending_purchase', pending_order_id = $2,
              pending_expires_at = now() + interval '${CLAIM_TTL_MINUTES} minutes', updated_at = now()
        WHERE id = $1`, [itemId, order.id]);
    await auditService.logEvent(client, {
      eventType: 'marketplace_order.created', entityType: 'marketplace_order', entityId: order.id,
      actorId: buyerUserId, metadata: { item_id: itemId, total_charge_cents: b.total_charge_cents, method },
    });
  });

  // ── Sales tax (flag-gated). Grow the total before creating the intent. Fail-safe: on tax error, release. ──
  const address = opts.address || await loadBuyerTaxAddress(buyerUserId);
  const taxableBase = order.item_price_cents + order.shipping_cents;
  let tax;
  try {
    tax = await taxService.computeTax({ buyerUserId, taxableBaseCents: taxableBase, address,
      reference: 'marketplace-order:' + order.order_number });
  } catch (taxErr) {
    await releaseOrder(order.id, 'tax:' + (taxErr.code || 'error'));
    throw taxErr;
  }
  const finalB = computeBreakdown({ itemPriceCents: order.item_price_cents, shippingCents: order.shipping_cents,
    taxCents: tax.taxCents, feeBps: order.platform_fee_bps });

  // ── Stripe PaymentIntent OUTSIDE any tx (idempotent by the client key or the order id) ──
  let intent;
  try {
    const stripe = getStripe();
    intent = await stripe.paymentIntents.create({
      amount: finalB.total_charge_cents, currency: 'usd',
      payment_method_types: ['card'], // platform policy: only debit/credit cards are accepted
      metadata: { product_type: 'marketplace_order', marketplace_order_id: order.id,
        order_number: order.order_number, marketplace_item_id: itemId, buyer_user_id: buyerUserId, seller_id: order.seller_id },
    }, { timeout: 15000, idempotencyKey: opts.idempotencyKey || ('mo:' + order.id) });
  } catch (stripeErr) {
    await releaseOrder(order.id, 'stripe:intent_create_failed');
    throw err(502, 'PAYMENT_INIT_FAILED', 'Could not start checkout. Please try again.');
  }

  const updated = (await db.query(
    `UPDATE marketplace_orders
        SET stripe_payment_intent_id = $2, stripe_tax_calculation_id = $3,
            tax_cents = $4, total_charge_cents = $5, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [order.id, intent.id, tax.calculationId, finalB.tax_cents, finalB.total_charge_cents])).rows[0];

  return { order: publicOrder(updated), client_secret: intent.client_secret, breakdown: finalB,
    tax_enabled: tax.enabled, tax_exempt: tax.exempt };
}

// Release an order's inventory claim + mark it failed (used by tax/stripe fail-safes and cancel webhooks).
async function releaseOrder(orderId, reason) {
  try {
    await withTransaction(async (client) => {
      const o = (await client.query('SELECT * FROM marketplace_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
      if (!o || o.payment_status === 'paid' || o.payment_status === 'refunded') return; // never disturb a settled order
      await client.query(`UPDATE marketplace_orders SET payment_status = 'failed', updated_at = now() WHERE id = $1`, [orderId]);
      await client.query(
        `UPDATE marketplace_items SET status = 'active', pending_order_id = NULL, pending_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'pending_purchase' AND pending_order_id = $2`, [o.marketplace_item_id, orderId]);
    });
  } catch (e) { console.error('[marketplace] releaseOrder failed', { orderId, reason, error: e.message }); }
}

// ── Webhook: PaymentIntent lifecycle for marketplace orders (routed from paymentService dispatcher) ───
async function handleIntentEvent(type, intent) {
  if (type === 'payment_intent.succeeded') return markOrderPaid(intent);
  if (type === 'payment_intent.payment_failed' || type === 'payment_intent.canceled') {
    const o = (await db.query('SELECT id FROM marketplace_orders WHERE stripe_payment_intent_id = $1', [intent.id])).rows[0];
    if (o) await releaseOrder(o.id, 'stripe:' + type);
    return;
  }
}

async function markOrderPaid(intent) {
  const chargeId = (intent.latest_charge && (intent.latest_charge.id || intent.latest_charge)) || null;
  let paidOrder = null;
  await withTransaction(async (client) => {
    const o = (await client.query(
      'SELECT * FROM marketplace_orders WHERE stripe_payment_intent_id = $1 FOR UPDATE', [intent.id])).rows[0];
    if (!o) throw new Error('No marketplace order for intent ' + intent.id); // orphan → event marked failed, operator reconciles
    if (o.payment_status === 'paid') return;                                 // idempotent
    await client.query(
      `UPDATE marketplace_orders
          SET payment_status = 'paid', stripe_charge_id = $2, paid_at = now(), updated_at = now()
        WHERE id = $1`, [o.id, chargeId]);
    await client.query(
      `UPDATE marketplace_items SET status = 'sold', pending_order_id = NULL, pending_expires_at = NULL, updated_at = now()
        WHERE id = $1`, [o.marketplace_item_id]);
    await auditService.logEvent(client, {
      eventType: 'marketplace_order.paid', entityType: 'marketplace_order', entityId: o.id,
      metadata: { intent_id: intent.id, total_charge_cents: o.total_charge_cents },
    });
    paidOrder = o;
  });
  if (!paidOrder) return; // was already paid
  // Record the authoritative Stripe Tax transaction (no-op when tax flag off / exempt / $0).
  try {
    const txId = await taxService.recordTransaction({ calculationId: paidOrder.stripe_tax_calculation_id, reference: 'marketplace-order:' + paidOrder.order_number });
    if (txId) await db.query('UPDATE marketplace_orders SET stripe_tax_transaction_id = $2 WHERE id = $1', [paidOrder.id, txId]);
  } catch (e) { console.error('[marketplace] tax transaction record failed', paidOrder.id, e.message); }
  // Buyer receipt + seller "item sold" notice (best-effort; never breaks the webhook ack).
  try { await require('./marketplaceOrderNotifier').sendPaid(paidOrder.id); }
  catch (e) { console.error('[marketplace] paid notification failed', paidOrder.id, e.message); }
}

// charge.refunded reconcile for out-of-band (Stripe Dashboard) refunds. Returns true if it was ours.
async function tryHandleChargeRefunded(charge) {
  const intentId = charge.payment_intent && (charge.payment_intent.id || charge.payment_intent);
  if (!intentId) return false;
  const o = (await db.query('SELECT * FROM marketplace_orders WHERE stripe_payment_intent_id = $1', [intentId])).rows[0];
  if (!o) return false;
  if (charge.refunded && o.refund_status !== 'refunded') {
    await applyRefundState(o.id, Number(charge.amount_refunded) || o.total_charge_cents, null);
  }
  return true;
}

// ── Admin refund (full) — reuses the existing Stripe refund + Stripe Tax reversal primitives ──────────
async function refundOrder(orderId, opts = {}) {
  const o = (await db.query('SELECT * FROM marketplace_orders WHERE id = $1', [orderId])).rows[0];
  if (!o) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (o.payment_status !== 'paid') throw err(409, 'NOT_REFUNDABLE', 'Only a paid order can be refunded.');
  if (o.refund_status === 'refunded') return publicOrder(o); // idempotent
  if (!o.stripe_payment_intent_id) throw err(409, 'NO_INTENT', 'Order has no payment to refund.');

  const stripe = getStripe();
  await stripe.refunds.create(
    { payment_intent: o.stripe_payment_intent_id, amount: o.total_charge_cents },
    { idempotencyKey: 'mo-refund:' + o.id });
  let reversalId = null;
  try {
    reversalId = await taxService.reverseFullTransaction({ originalTransactionId: o.stripe_tax_transaction_id, reference: 'marketplace-order:' + o.order_number });
  } catch (e) { console.error('[marketplace] tax reversal failed', o.id, e.message); }

  const updated = await applyRefundState(o.id, o.total_charge_cents, reversalId, opts.adminId);
  try { await require('./marketplaceOrderNotifier').sendRefunded(o.id); } catch (e) { /* best-effort */ }
  return updated;
}

// Persist refunded state: money reversed, payout eligibility removed, item moved to a NON-PUBLIC state
// (relist-required — never auto-relisted). Historical order/refund records are preserved (no deletes).
async function applyRefundState(orderId, refundedCents, reversalId, adminId) {
  let out;
  await withTransaction(async (client) => {
    const o = (await client.query('SELECT * FROM marketplace_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!o || o.refund_status === 'refunded') { out = o; return; }
    const upd = (await client.query(
      `UPDATE marketplace_orders
          SET payment_status = 'refunded', refund_status = 'refunded', refunded_amount_cents = $2,
              stripe_tax_reversal_id = COALESCE($3, stripe_tax_reversal_id),
              payout_eligible = false, payout_eligible_at = NULL, refunded_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`, [orderId, refundedCents, reversalId])).rows[0];
    // Item → non-public 'removed'. Seller must explicitly RELIST (its physical disposition may be uncertain).
    await client.query(
      `UPDATE marketplace_items SET status = 'removed', pending_order_id = NULL, pending_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('sold','pending_purchase')`, [o.marketplace_item_id]);
    await auditService.logEvent(client, {
      eventType: 'marketplace_order.refunded', entityType: 'marketplace_order', entityId: orderId,
      actorId: adminId || null, metadata: { refunded_amount_cents: refundedCents, reversal_id: reversalId } });
    out = upd;
  });
  return publicOrder(out);
}

// Seller explicitly relists a refunded/removed/draft item. Preserves all historical orders.
async function relistItem(itemId, sellerUserId) {
  return withTransaction(async (client) => {
    const seller = (await client.query('SELECT id FROM seller_profiles WHERE user_id = $1', [sellerUserId])).rows[0];
    if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
    const item = (await client.query('SELECT * FROM marketplace_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0];
    if (!item) throw err(404, 'ITEM_NOT_FOUND', 'Item not found.');
    if (item.seller_id !== seller.id) throw err(403, 'NOT_OWNER', 'Not your listing.');
    if (!['removed', 'draft'].includes(item.status)) throw err(409, 'NOT_RELISTABLE', 'Only a removed or draft item can be relisted.');
    const upd = (await client.query(
      `UPDATE marketplace_items SET status = 'active', pending_order_id = NULL, pending_expires_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`, [itemId])).rows[0];
    return upd;
  });
}

// ── Seller fulfillment transitions → payout ELIGIBILITY (never money movement) ────────────────────────
const FULFILL = {
  ready_for_pickup: { method: 'pickup', from: ['unfulfilled'], to: 'ready_for_pickup', eligible: false },
  picked_up:        { method: 'pickup', from: ['unfulfilled', 'ready_for_pickup'], to: 'picked_up', eligible: true },
  shipped:          { method: 'shipping', from: ['unfulfilled'], to: 'shipped', eligible: false },
  complete:         { method: 'shipping', from: ['shipped'], to: 'completed', eligible: true },
};
async function updateFulfillment(orderId, sellerUserId, action, opts = {}) {
  const spec = FULFILL[action];
  if (!spec) throw err(400, 'BAD_ACTION', 'Unknown fulfillment action.');
  return withTransaction(async (client) => {
    const seller = (await client.query('SELECT id FROM seller_profiles WHERE user_id = $1', [sellerUserId])).rows[0];
    if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
    const o = (await client.query('SELECT * FROM marketplace_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
    if (o.seller_id !== seller.id) throw err(403, 'NOT_OWNER', 'Not your order.');
    if (o.payment_status !== 'paid') throw err(409, 'NOT_PAID', 'Order is not paid.');
    if (o.fulfillment_method !== spec.method) throw err(409, 'WRONG_METHOD', 'That action does not apply to this order.');
    if (!spec.from.includes(o.fulfillment_status)) throw err(409, 'BAD_TRANSITION', 'That fulfillment step is not available now.');
    const carrier = action === 'shipped' ? (opts.tracking_carrier || null) : null;
    const tracking = action === 'shipped' ? (opts.tracking_number || null) : null;
    const upd = (await client.query(
      `UPDATE marketplace_orders
          SET fulfillment_status = $2,
              tracking_carrier = COALESCE($3, tracking_carrier),
              tracking_number  = COALESCE($4, tracking_number),
              payout_eligible    = CASE WHEN $5 THEN true ELSE payout_eligible END,
              payout_eligible_at = CASE WHEN $5 AND payout_eligible_at IS NULL THEN now() ELSE payout_eligible_at END,
              updated_at = now()
        WHERE id = $1 RETURNING *`, [orderId, spec.to, carrier, tracking, spec.eligible])).rows[0];
    await auditService.logEvent(client, {
      eventType: 'marketplace_order.fulfillment', entityType: 'marketplace_order', entityId: orderId,
      actorId: sellerUserId, metadata: { action, to: spec.to, payout_eligible: upd.payout_eligible } });
    return publicOrder(upd);
  });
}

// ── Read models ───────────────────────────────────────────────────────────────────────────────────────
// Buyer/seller-facing order shape. NEVER lets a seller see internal-only fields beyond what they need to
// fulfill; money fields are read-only snapshots.
function publicOrder(o) {
  if (!o) return null;
  return {
    id: o.id, order_number: o.order_number, marketplace_item_id: o.marketplace_item_id,
    item_price_cents: o.item_price_cents, shipping_cents: o.shipping_cents, tax_cents: o.tax_cents,
    platform_fee_bps: o.platform_fee_bps, platform_fee_cents: o.platform_fee_cents,
    seller_proceeds_cents: o.seller_proceeds_cents, total_charge_cents: o.total_charge_cents, currency: o.currency,
    fulfillment_method: o.fulfillment_method, fulfillment_status: o.fulfillment_status,
    tracking_carrier: o.tracking_carrier, tracking_number: o.tracking_number,
    payment_status: o.payment_status, refund_status: o.refund_status, refunded_amount_cents: o.refunded_amount_cents,
    payout_eligible: o.payout_eligible, ship_to: o.ship_to || null,
    created_at: o.created_at, paid_at: o.paid_at,
  };
}

async function listForBuyer(buyerUserId) {
  const { rows } = await db.query(
    `SELECT o.*, mi.title AS item_title, mi.thumbnail_url,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name,
            sp.storefront_slug
       FROM marketplace_orders o
       JOIN marketplace_items mi ON mi.id = o.marketplace_item_id
       JOIN seller_profiles sp ON sp.id = o.seller_id
      WHERE o.buyer_user_id = $1 AND o.payment_status IN ('paid','refunded')
      ORDER BY o.created_at DESC`, [buyerUserId]);
  return rows.map((r) => ({ ...publicOrder(r), item_title: r.item_title, thumbnail_url: r.thumbnail_url,
    seller_name: r.seller_name, storefront_slug: r.storefront_slug }));
}

async function listForSeller(sellerUserId) {
  const seller = (await db.query('SELECT id FROM seller_profiles WHERE user_id = $1', [sellerUserId])).rows[0];
  if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  const { rows } = await db.query(
    `SELECT o.*, mi.title AS item_title, mi.thumbnail_url,
            bu.email AS buyer_email, bu.full_name AS buyer_full_name
       FROM marketplace_orders o
       JOIN marketplace_items mi ON mi.id = o.marketplace_item_id
       JOIN users bu ON bu.id = o.buyer_user_id
      WHERE o.seller_id = $1 AND o.payment_status IN ('paid','refunded')
      ORDER BY o.created_at DESC`, [seller.id]);
  // Seller sees only the buyer contact necessary to fulfill (name/email + shipping snapshot). No payment PII.
  return rows.map((r) => ({ ...publicOrder(r), item_title: r.item_title, thumbnail_url: r.thumbnail_url,
    buyer_name: r.buyer_full_name || null, buyer_email: r.buyer_email }));
}

// Single-order fetch, ownership-scoped (used by the buyer confirmation poll + seller/admin detail).
async function getForBuyer(orderId, buyerUserId) {
  const o = (await db.query('SELECT * FROM marketplace_orders WHERE id = $1 AND buyer_user_id = $2', [orderId, buyerUserId])).rows[0];
  return o ? publicOrder(o) : null;
}
async function getForSeller(orderId, sellerUserId) {
  const o = (await db.query(
    `SELECT o.* FROM marketplace_orders o JOIN seller_profiles sp ON sp.id = o.seller_id
      WHERE o.id = $1 AND sp.user_id = $2`, [orderId, sellerUserId])).rows[0];
  return o ? publicOrder(o) : null;
}

module.exports = {
  feeBpsForSeller, computeBreakdown, loadItemForPurchase, quote, createOrder,
  handleIntentEvent, tryHandleChargeRefunded, markOrderPaid, refundOrder, applyRefundState,
  relistItem, updateFulfillment, releaseOrder, listForBuyer, listForSeller,
  getForBuyer, getForSeller, publicOrder,
};
