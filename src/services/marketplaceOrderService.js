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
 *   • Tax           = Stripe Tax; jurisdiction = seller pickup location (pickup) or the order ship-to (shipping);
 *                     flag-gated OFF → $0, no Stripe call.
 *   • Payout        = fulfillment completion sets payout_eligible=true; it moves NO money. Advantage.Bid
 *                     retains manual settlement control.
 *
 * Everything money-related is computed server-side; browser-supplied amounts are never trusted.
 */

const db = require('../db');
const sellerActor = require('../lib/sellerActor');
const shipping = require('../lib/storefrontShipping');
const sellerPolicies = require('./sellerPolicyService');
const { brandingVisible } = require('../lib/sellerBranding');
const Stripe = require('stripe');
const { withTransaction } = require('../utils/withTransaction');
const auditService = require('./auditService');
const taxService = require('./taxCalculationService');
// Storefronts are a Professional Seller feature (owner decision 2026-10-12): eligibility uses the canonical seller-type rule,
// never the buyer-branding list (which also includes the self-serve 'business' Individual Seller type).
const { isProfessional } = require('./sellerTypeRules');
const { marketplaceCheckoutEnabled } = require('../lib/launchGuards');
const saleLocation = require('../lib/saleLocation');

const STRIPE_API_VERSION = '2026-03-25.dahlia'; // matches paymentService/taxCalculationService pin
const CLAIM_TTL_MINUTES = 30;                    // an in-flight checkout holds a one-of-one item this long

// FLAT Professional Storefront selling fee (owner-authoritative): 11% of the ITEM PRICE, INCLUSIVE of
// credit-card/payment processing. Customer-facing promise: "Flat 11% selling fee, including credit card
// processing." The 8% Advantage.Bid + 3% processing split is an internal BUSINESS ALLOCATION only — the
// seller is never charged 11% + a separate processing %. This is DECOUPLED from the auction professional
// fee (seller_profiles.platform_fee_bps, ~4% of hammer, used by billingTermsService for AUCTION
// settlement): storefront/Buy-Now sales use this flat rate, so auction economics are unaffected.
const STOREFRONT_FEE_BPS = 1100; // 11.00%
// Internal accounting allocation of the flat fee (reporting only; NOT extra deductions).
const STOREFRONT_FEE_ADVANTAGE_BPS = 800; // 8% Advantage.Bid
const STOREFRONT_FEE_PROCESSING_BPS = 300; // 3% processing allocation (Advantage.Bid absorbs any real-cost delta)

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

// ── Money ────────────────────────────────────────────────────────────────────────────────────────────
// The Professional Storefront selling fee is a FLAT 11% for every fixed-price sale — NOT the per-seller
// auction platform_fee_bps (which stays exclusively an auction-settlement input). The `seller` arg is
// accepted for call-site compatibility but the storefront rate is intentionally uniform.
function feeBpsForSeller(/* seller */) {
  return STOREFRONT_FEE_BPS;
}
// STOREFRONT PRICING IS SEPARATE FROM AUCTION PRICING (owner rule 2026-10-16). A fixed-price Buy Now purchase NEVER has a
// buyer's premium: the buyer pays the listed item price + shipping + sales tax, and the seller pays the flat 11% fee on the
// item price only. This module deliberately does not load any auction pricing module (billing terms, seller terms, pricing
// config), so no auction buyer's premium, auction fee or auction default can reach a storefront total.
const STOREFRONT_BUYER_PREMIUM_BPS = 0;
// Cents-safe basis points of an amount (half-up), local to the storefront.
function bpsOf(cents, bps) { return Math.floor((Math.max(0, Math.round(Number(cents) || 0)) * (Number(bps) || 0)) / 10000 + 0.5); }

// Deterministic, cents-safe breakdown. platform fee = bps of ITEM PRICE only.
function computeBreakdown({ itemPriceCents, shippingCents, taxCents, feeBps }) {
  const item = Math.max(0, Math.round(Number(itemPriceCents) || 0));
  const ship = Math.max(0, Math.round(Number(shippingCents) || 0));
  const tax = Math.max(0, Math.round(Number(taxCents) || 0));
  const platform_fee_cents = bpsOf(item, feeBps);                            // seller fee: bps of the item price only
  const seller_proceeds_cents = item + ship - platform_fee_cents;             // tax EXCLUDED from proceeds
  const total_charge_cents = item + ship + tax;                              // buyer pays goods+shipping+tax
  return {
    item_price_cents: item, shipping_cents: ship, tax_cents: tax,
    platform_fee_bps: feeBps, platform_fee_cents, seller_proceeds_cents, total_charge_cents,
  };
}

// What a buyer is shown of a breakdown: what they pay. The seller's fee and proceeds are the seller's business.
function buyerBreakdown(b) {
  return { item_price_cents: b.item_price_cents, shipping_cents: b.shipping_cents, tax_cents: b.tax_cents, total_charge_cents: b.total_charge_cents };
}

function taxActive() {
  return typeof taxService.taxEnabled === 'function' ? !!taxService.taxEnabled() : false;
}
function parseJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}
function normalizeAddress(a) {
  if (!a || typeof a !== 'object') return null;
  const s = (v) => (v == null ? '' : String(v).trim());
  return { line1: s(a.line1), line2: s(a.line2) || undefined, city: s(a.city), state: s(a.state).toUpperCase(),
    postal_code: s(a.postal_code), country: (s(a.country) || 'US').toUpperCase() };
}
// ── Sale location for sales tax (owner rule; src/lib/saleLocation.js) ───────────────────────────────────
//   PICKUP   → the item's pickup location is where the buyer takes possession (customer address + origin).
//   SHIPPING → destination = the ship-to address stored on the order; origin = the item's pickup location.
// Never the buyer's billing address, the seller's legal address or Advantage.Bid's own address. A missing or
// incomplete location blocks the sale; the seller and admin are told what is missing (once per item).
// Returns { address, shipFrom } for taxService.computeTax, or null when tax is off. Only consulted when tax is ON.
async function resolveTaxLocation({ method, item, shipTo }) {
  if (!taxActive()) return null;
  // The item's effective location: its own (auction-inherited or changed for this item) or the seller's confirmed default.
  const eff = saleLocation.forItem(item);
  const origin = eff.address;
  const missing = eff.missing || [];
  if (missing.length) {
    await require('./saleLocationAlerts').reportMissingSaleLocation({ entityType: 'marketplace_item', entityId: item.id,
      missing, sellerId: item.seller_id });
    throw saleLocation.locationError('PICKUP_LOCATION_MISSING', 'buyer', missing, 409);
  }
  if (method === 'shipping') {
    const a = normalizeAddress(parseJson(shipTo));
    if (!a || !taxService.addressComplete(a)) {
      throw err(422, 'SHIP_TO_REQUIRED', 'A complete shipping address is required.');
    }
    return { address: a, shipFrom: origin };
  }
  return { address: origin, shipFrom: origin };
}

// Load an item joined to its seller, with the purchase-eligibility validations that don't need a lock.
// Shipping is decided ONLY by src/lib/storefrontShipping.js: pickup-only items cannot be shipped, incomplete shipping
// terms refuse shipping (a blank price is never $0), and a destination the seller does not serve is refused. The seller
// fee (computeBreakdown) stays on the item price only.
// The seller company may receive a storefront order only when it is an active, verified Professional Seller (roadmap §13.A;
// sellerSaleEligibility uses the same verification gate as a Professional Seller's first auction). Checked on the server
// for every quote, order and payment; the item page and buttons are never the gate.
const { assertSellerCanSell } = require('./sellerSaleEligibility');

async function loadItemForPurchase(itemId, buyerUserId, fulfillmentMethod, runner = db, { shipToState, shipToCountry } = {}) {
  const row = (await runner.query(
    `SELECT mi.*, sp.user_id AS seller_user_id, sp.seller_type, sp.platform_fee_bps, sp.storefront_slug, sp.show_branding_to_buyers,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_display_name,
            sp.default_pickup_address_line1, sp.default_pickup_address_line2, sp.default_pickup_city, sp.default_pickup_state,
            sp.default_pickup_postal_code, sp.default_pickup_country, sp.default_pickup_confirmed_at
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.id = $1`, [itemId])).rows[0];
  if (!row) throw err(404, 'ITEM_NOT_FOUND', 'This item is no longer available.');
  if (!isProfessional(row.seller_type)) throw err(409, 'NOT_PROFESSIONAL', 'This item is not purchasable.');
  if (row.seller_user_id === buyerUserId) throw err(403, 'CANNOT_BUY_OWN', 'You cannot purchase your own listing.');
  await assertSellerCanSell(row.seller_id, runner);
  if (!(Number(row.price_cents) > 0)) throw err(422, 'PRICE_INVALID', 'This item has no valid price.');
  const method = fulfillmentMethod === 'shipping' ? 'shipping' : 'pickup';
  const { shippingCents } = shipping.shippingChargeFor(row, method, shipToState, shipToCountry);
  return { item: row, method, shippingCents, feeBps: feeBpsForSeller(row) };
}

// The fixed record of what was bought and from whom, captured from the locked item at purchase (migration 197 rejects an
// order whose snapshot names a different item or seller, and never lets it change afterwards).
function purchaseSnapshot(item, method = 'pickup', shippingCents = 0) {
  const eff = saleLocation.forItem(item);
  return {
    item: { item_id: item.id, title: item.title, description: item.description || null, category: item.category || null,
      condition: item.condition || null, thumbnail_url: item.thumbnail_url || null, images: Array.isArray(item.images) ? item.images : [],
      shippable: !!item.shippable, shipping_cost_cents: item.shipping_cost_cents == null ? null : Number(item.shipping_cost_cents),
      shipping_notes: item.shipping_notes || null, source_lot_id: item.source_lot_id || null, listed_price_cents: Number(item.price_cents),
      inventory_number: item.inventory_number || null,   // the seller's own number, fixed with the sale (migration 204)
      // the shipping or pickup terms offered and the one the buyer chose, fixed at purchase (migration 201)
      shipping_terms: shipping.snapshotTerms(item, method, shippingCents) },
    seller: { seller_profile_id: item.seller_id, seller_user_id: item.seller_user_id, display_name: item.seller_display_name || null,
      seller_type: item.seller_type, storefront_slug: item.storefront_slug || null },
    pickup: eff && eff.address && eff.address.line1 ? { source: eff.source, ...eff.address } : null,
  };
}

// Append to the order's permanent history. The seller and buyer always come from the order row itself, never from the
// caller, so a history entry can never be attributed to anyone else.
async function recordEvent(runner, orderId, eventType, { actorUserId = null, actorRole = 'system', data = {} } = {}) {
  await runner.query(
    `INSERT INTO marketplace_order_events (order_id, seller_id, buyer_user_id, event_type, actor_user_id, actor_role, data)
     SELECT o.id, o.seller_id, o.buyer_user_id, $2, $3, $4, $5::jsonb FROM marketplace_orders o WHERE o.id = $1`,
    [orderId, eventType, actorUserId, actorRole, JSON.stringify(data || {})]);
}

// ── Read-only quote (no inventory claim, no PaymentIntent) — powers the buyer's order-review screen ────
// Gated behind the checkout flag: it calls the tax calculation service, which must not be reachable while
// checkout is off.
async function quote(itemId, buyerUserId, opts = {}) {
  if (!marketplaceCheckoutEnabled()) throw err(403, 'CHECKOUT_DISABLED', 'Marketplace checkout is not currently available.');
  const qShip = opts.fulfillment_method === 'shipping' ? normalizeAddress(parseJson(opts.ship_to || opts.address)) : null;
  const { item, method, shippingCents, feeBps } = await loadItemForPurchase(itemId, buyerUserId, opts.fulfillment_method, db,
    qShip ? { shipToState: qShip.state || '', shipToCountry: qShip.country } : {});
  if (item.status !== 'active') throw err(409, 'NOT_AVAILABLE', 'This item is no longer available for purchase.');
  // Shipping: destination = the address the buyer will ship to; origin = the item's pickup location. Pickup: the item's pickup location.
  const loc = await resolveTaxLocation({ method, item, shipTo: opts.ship_to || opts.address });
  const taxable = item.price_cents + shippingCents;
  const tax = await taxService.computeTax({
    buyerUserId, taxableBaseCents: taxable, address: loc && loc.address, shipFrom: loc && loc.shipFrom,
    addressSource: 'shipping', reference: 'marketplace-quote:' + itemId,
  });
  const b = computeBreakdown({ itemPriceCents: item.price_cents, shippingCents, taxCents: tax.taxCents, feeBps });
  return {
    item: { id: item.id, title: item.title, thumbnail_url: item.thumbnail_url, seller_id: item.seller_id },
    fulfillment_method: method, tax_enabled: tax.enabled, tax_exempt: tax.exempt, breakdown: buyerBreakdown(b),
  };
}

// ── PaymentIntent helpers ─────────────────────────────────────────────────────────────────────────────
// Intent states in which money has moved or may still move without further buyer action: an item held by such
// an order is NEVER released and its intent is NEVER canceled.
const INTENT_IN_FLIGHT = ['succeeded', 'processing', 'requires_capture'];
// Intent states in which the SAME PaymentIntent can still be paid (the buyer may retry with another card).
const INTENT_REUSABLE = ['requires_payment_method', 'requires_confirmation', 'requires_action'];

// Cancel an intent unless it has succeeded / is processing. Idempotent: an already-canceled intent is fine.
// Returns { canceled: true } when the intent can no longer take money, { canceled: false, status } otherwise.
async function safeCancelIntent(intentId) {
  const stripe = getStripe();
  const current = await stripe.paymentIntents.retrieve(intentId);
  if (INTENT_IN_FLIGHT.includes(current.status)) return { canceled: false, status: current.status, intent: current };
  if (current.status === 'canceled') return { canceled: true, status: 'canceled', intent: current };
  try {
    const c = await stripe.paymentIntents.cancel(intentId, {}, { idempotencyKey: 'mo-cancel:' + intentId });
    return { canceled: c.status === 'canceled', status: c.status, intent: c };
  } catch (e) {
    // A state race (e.g. it just succeeded, or was canceled elsewhere) — re-read and decide from the truth.
    const again = await stripe.paymentIntents.retrieve(intentId);
    if (again.status === 'canceled') return { canceled: true, status: 'canceled', intent: again };
    return { canceled: false, status: again.status, intent: again };
  }
}

function sameShipTo(a, b) {
  const x = normalizeAddress(parseJson(a)); const y = normalizeAddress(parseJson(b));
  if (!x && !y) return true;
  return JSON.stringify(x) === JSON.stringify(y);
}

// ── Create order + PaymentIntent (claims the one-of-one item atomically) ──────────────────────────────
// pre: if the item is held by THIS buyer's own in-progress order, reuse it (same method + ship-to) or retire it;
//      if the hold has expired, release it through the same safe path the sweeper uses.
// tx1: lock item, verify available, INSERT the order (pending, intent NULL), flip item → pending_purchase. COMMIT.
// then: compute tax (grows total), create the PaymentIntent OUTSIDE any tx. The intent uses MANUAL confirmation,
//      so only the server (after inspecting the card) can confirm it — the browser cannot charge an unchecked card.
// tx2: attach intent id + tax calc id + final tax/total. On failure: release item, fail order.
async function createOrder(itemId, buyerUserId, opts = {}) {
  if (!marketplaceCheckoutEnabled()) throw err(403, 'CHECKOUT_DISABLED', 'Marketplace checkout is not currently available.');
  // The buyer must confirm they had access to the seller's Store Terms and Shipping & Pickup Policy and the Advantage.Bid
  // Buyer Terms (migration 203). The exact versions are recorded on the order below and can never change.
  if (opts.policiesAcknowledged !== true) {
    throw err(422, 'POLICIES_ACK_REQUIRED', "Please confirm you have read the seller's store policies and the Advantage.Bid Buyer Terms.");
  }
  const wantShip = opts.fulfillment_method === 'shipping';
  const shipToObj = wantShip && opts.ship_to ? normalizeAddress(opts.ship_to) : null;
  const dest = shipToObj ? { shipToState: shipToObj.state || '', shipToCountry: shipToObj.country } : {};
  const pre = await loadItemForPurchase(itemId, buyerUserId, opts.fulfillment_method, db, dest);
  const { method, shippingCents, feeBps } = pre;
  if (method === 'shipping' && !shipToObj) throw err(422, 'SHIP_TO_REQUIRED', 'A shipping address is required.');
  // Check the sale location BEFORE the item is held, so a blocked sale never claims inventory.
  if (taxActive()) await resolveTaxLocation({ method, item: pre.item, shipTo: shipToObj });

  if (pre.item.status === 'pending_purchase') {
    const reused = await reuseOrRetireHold(pre.item, buyerUserId, method, shipToObj);
    if (reused) return reused;
  }

  let order;
  await withTransaction(async (client) => {
    const locked = (await client.query('SELECT * FROM marketplace_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0];
    if (!locked) throw err(404, 'ITEM_NOT_FOUND', 'This item is no longer available.');
    if (locked.status !== 'active') throw err(409, 'NOT_AVAILABLE', 'This item is no longer available for purchase.');
    // Everything the order records comes from the LOCKED item and its owning seller, re-checked here: the seller, price,
    // shipping and pickup terms cannot change between the eligibility check above and this order.
    const { item, method: lockedMethod, shippingCents: lockedShipping } = await loadItemForPurchase(itemId, buyerUserId, method, client, dest);
    // 5. The buyer confirmed a price and shipping charge on the review screen: if the seller changed either since, stop and
    // ask the buyer to review again instead of charging an amount they did not see.
    if ((opts.expectedItemPriceCents != null && Number(opts.expectedItemPriceCents) !== Number(item.price_cents))
        || (opts.expectedShippingCents != null && Number(opts.expectedShippingCents) !== Number(lockedShipping))) {
      throw err(409, 'PRICE_CHANGED', 'The price or shipping for this item changed since you reviewed it. Please review your order again.');
    }
    if (lockedMethod !== method) throw err(409, 'NOT_AVAILABLE', 'This item is no longer available for purchase.');
    const b = computeBreakdown({ itemPriceCents: item.price_cents, shippingCents: lockedShipping, taxCents: 0, feeBps });
    const shipTo = shipToObj ? JSON.stringify(shipToObj) : null;
    const snap = purchaseSnapshot(item, lockedMethod, lockedShipping);
    // The seller's policies apply only when the buyer could see them (seller branding shown). The buyer confirmed the
    // versions on the review screen: if the seller published a different version since, ask the buyer to review again.
    // Share-lock the seller company: publishing or withdrawing a policy takes the same row FOR UPDATE, so the versions
    // read here are still the published ones when the order is inserted.
    await client.query('SELECT id FROM seller_profiles WHERE id = $1 FOR SHARE', [item.seller_id]);
    const policySnap = await sellerPolicies.snapshotFor(item.seller_id, client, { shown: brandingVisible(item.seller_type, item.show_branding_to_buyers) });
    if (opts.expectedPolicyVersions && typeof opts.expectedPolicyVersions === 'object') {
      for (const k of ['store_terms', 'shipping_pickup']) {
        const want = opts.expectedPolicyVersions[k] == null ? null : Number(opts.expectedPolicyVersions[k]);
        const have = policySnap[k] ? Number(policySnap[k].version) : null;
        if (want !== have) throw err(409, 'POLICIES_CHANGED', "The seller updated their store policies since you reviewed them. Please review them again.");
      }
    }
    // The database allows one live order per item (uq_marketplace_orders_live_item); if one already exists the buyer
    // gets a clean "not available" instead of a server error.
    const inserted = await client.query(
      `INSERT INTO marketplace_orders
         (marketplace_item_id, seller_id, buyer_user_id, item_price_cents, shipping_cents, tax_cents,
          platform_fee_bps, platform_fee_cents, seller_proceeds_cents, total_charge_cents,
          fulfillment_method, ship_to, payment_status, is_demo, idempotency_key,
          item_snapshot, seller_snapshot, pickup_snapshot, policy_snapshot, policies_acknowledged_at)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11::jsonb,'pending',$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb, now())
       RETURNING *`,
      [itemId, item.seller_id, buyerUserId, b.item_price_cents, b.shipping_cents,
       b.platform_fee_bps, b.platform_fee_cents, b.seller_proceeds_cents, b.total_charge_cents,
       method, shipTo, !!item.is_demo, opts.idempotencyKey || null,
       JSON.stringify(snap.item), JSON.stringify(snap.seller), snap.pickup ? JSON.stringify(snap.pickup) : null,
       JSON.stringify(policySnap)])
      .catch((e) => {
        if (e && e.code === '23505' && /live_item/.test(e.constraint || e.message || '')) throw err(409, 'NOT_AVAILABLE', 'This item is no longer available for purchase.');
        if (e && e.code === '23514' && /own seller/.test(e.message || '')) throw err(409, 'POLICIES_CHANGED', 'The seller updated their store policies since you reviewed them. Please review them again.');
        throw e;
      });
    order = inserted.rows[0];
    await recordEvent(client, order.id, 'created', { actorUserId: buyerUserId, actorRole: 'buyer',
      data: { item_id: itemId, seller_id: item.seller_id, total_charge_cents: b.total_charge_cents, method } });
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

  // ── Sales tax (flag-gated). Pickup → the item's pickup location; shipping → the order's stored ship-to (destination)
  // with the item's pickup location as origin. ──
  const taxableBase = order.item_price_cents + order.shipping_cents;
  let tax;
  try {
    const loc = await resolveTaxLocation({ method, item: pre.item, shipTo: order.ship_to || shipToObj });
    tax = await taxService.computeTax({ buyerUserId, taxableBaseCents: taxableBase, address: loc && loc.address,
      shipFrom: loc && loc.shipFrom, addressSource: 'shipping', reference: 'marketplace-order:' + order.order_number });
  } catch (taxErr) {
    await releaseOrder(order.id, 'tax:' + (taxErr.code || 'error'));
    throw taxErr;
  }
  const finalB = computeBreakdown({ itemPriceCents: order.item_price_cents, shippingCents: order.shipping_cents,
    taxCents: tax.taxCents, feeBps: order.platform_fee_bps });

  // ── PaymentIntent OUTSIDE any tx (idempotent by the client key or the order id). MANUAL confirmation: the
  // browser only ever creates a PaymentMethod; the server inspects it (prepaid refusal) and confirms. ──
  let intent;
  try {
    const stripe = getStripe();
    intent = await stripe.paymentIntents.create({
      amount: finalB.total_charge_cents, currency: 'usd',
      payment_method_types: ['card'], // platform policy: only debit/credit cards are accepted
      confirmation_method: 'manual',
      metadata: { product_type: 'marketplace_order', marketplace_order_id: order.id,
        order_number: order.order_number, marketplace_item_id: itemId, buyer_user_id: buyerUserId, seller_id: order.seller_id },
    }, { timeout: 15000, idempotencyKey: opts.idempotencyKey ? ('mo-create:' + opts.idempotencyKey) : ('mo:' + order.id) });
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

  return { order: buyerOrder(updated), client_secret: intent.client_secret, breakdown: buyerBreakdown(finalB),
    tax_enabled: tax.enabled, tax_exempt: tax.exempt };
}

// The item is currently held. If the hold belongs to this buyer's own still-payable order with the same
// fulfillment choice, return that order (no second order, no second intent — "Try again" is safe). If the
// buyer changed method/ship-to, retire the old hold (cancel its intent first). If someone else's hold expired,
// release it via the sweeper path. Anything else → the tx below reports NOT_AVAILABLE.
async function reuseOrRetireHold(item, buyerUserId, method, shipToObj) {
  const o = item.pending_order_id
    ? (await db.query('SELECT * FROM marketplace_orders WHERE id = $1', [item.pending_order_id])).rows[0] : null;
  const expired = item.pending_expires_at && new Date(item.pending_expires_at) < new Date();
  if (o && o.buyer_user_id === buyerUserId && o.payment_status === 'pending' && o.stripe_payment_intent_id && !expired) {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.retrieve(o.stripe_payment_intent_id);
    if (INTENT_IN_FLIGHT.includes(intent.status)) throw err(409, 'PAYMENT_IN_PROGRESS', 'Your payment for this item is already being processed.');
    if (INTENT_REUSABLE.includes(intent.status) && o.fulfillment_method === method && sameShipTo(o.ship_to, shipToObj)) {
      return { order: buyerOrder(o), client_secret: intent.client_secret, reused: true,
        breakdown: buyerBreakdown(computeBreakdown({ itemPriceCents: o.item_price_cents, shippingCents: o.shipping_cents,
          taxCents: o.tax_cents, feeBps: o.platform_fee_bps })),
        tax_enabled: taxActive(), tax_exempt: false };
    }
    await releaseOrder(o.id, 'buyer_changed_checkout', { cancelIntent: true });
    return null;
  }
  if (expired) await releaseExpiredHold({ item_id: item.id, order_id: o ? o.id : null,
    stripe_payment_intent_id: o ? o.stripe_payment_intent_id : null });
  return null;
}

// Release an order's inventory claim + mark it failed (used by tax/stripe fail-safes, cancel webhooks, the
// expired-hold sweeper). With { cancelIntent: true } the order's PaymentIntent is canceled FIRST and the item is
// only released once the intent can no longer take money (never when it succeeded or is processing).
// Returns true when the claim was released.
async function releaseOrder(orderId, reason, opts = {}) {
  try {
    if (opts.cancelIntent) {
      const cur = (await db.query('SELECT id, payment_status, stripe_payment_intent_id FROM marketplace_orders WHERE id = $1', [orderId])).rows[0];
      if (!cur || cur.payment_status === 'paid' || cur.payment_status === 'refunded') return false;
      if (cur.stripe_payment_intent_id) {
        const c = await safeCancelIntent(cur.stripe_payment_intent_id);
        if (!c.canceled) return false; // succeeded/processing → never release; the success path settles it
      }
    }
    let released = false;
    await withTransaction(async (client) => {
      const o = (await client.query('SELECT * FROM marketplace_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
      if (!o || o.payment_status === 'paid' || o.payment_status === 'refunded') return; // never disturb a settled order
      await client.query(`UPDATE marketplace_orders SET payment_status = 'failed', updated_at = now() WHERE id = $1`, [orderId]);
      await client.query(
        `UPDATE marketplace_items SET status = 'active', pending_order_id = NULL, pending_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'pending_purchase' AND pending_order_id = $2`, [o.marketplace_item_id, orderId]);
      await auditService.logEvent(client, {
        eventType: 'marketplace_order.released', entityType: 'marketplace_order', entityId: orderId,
        metadata: { reason: reason || null },
      });
      await recordEvent(client, orderId, 'released', { data: { reason: reason || null } });
      released = true;
    });
    return released;
  } catch (e) {
    console.error('[marketplace] releaseOrder failed', { orderId, reason, error: e.message });
    return false;
  }
}

// ── Expired-hold sweeper ─────────────────────────────────────────────────────────────────────────────
// Releases one expired hold. Checks the PaymentIntent FIRST: succeeded → reconcile the sale (a lost webhook);
// processing/requires_capture → leave it alone; otherwise cancel the intent, then release.
async function releaseExpiredHold(row) {
  if (!row.order_id) {
    const r = await db.query(
      `UPDATE marketplace_items SET status = 'active', pending_order_id = NULL, pending_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending_purchase' AND pending_expires_at < now()`, [row.item_id]);
    return r.rowCount ? 'released' : 'skipped';
  }
  if (row.stripe_payment_intent_id) {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
    if (intent.status === 'succeeded') { await markOrderPaid(intent); return 'reconciled_paid'; }
    if (INTENT_IN_FLIGHT.includes(intent.status)) return 'skipped_in_flight';
  }
  const ok = await releaseOrder(row.order_id, 'hold_expired', { cancelIntent: true });
  return ok ? 'released' : 'skipped';
}

// Self-gated: does nothing unless checkout is enabled and a payment key is configured. Idempotent.
async function sweepExpiredHolds({ limit = 50 } = {}) {
  const summary = { enabled: false, scanned: 0, released: 0, reconciled_paid: 0, skipped: 0, errors: 0 };
  if (!marketplaceCheckoutEnabled() || !process.env.STRIPE_SECRET_KEY) return summary;
  summary.enabled = true;
  const { rows } = await db.query(
    `SELECT mi.id AS item_id, o.id AS order_id, o.stripe_payment_intent_id
       FROM marketplace_items mi
       LEFT JOIN marketplace_orders o ON o.id = mi.pending_order_id
      WHERE mi.status = 'pending_purchase' AND mi.pending_expires_at < now()
      ORDER BY mi.pending_expires_at ASC
      LIMIT $1`, [limit]);
  for (const row of rows) {
    summary.scanned += 1;
    try {
      const out = await releaseExpiredHold(row);
      if (out === 'released') summary.released += 1;
      else if (out === 'reconciled_paid') summary.reconciled_paid += 1;
      else summary.skipped += 1;
    } catch (e) {
      summary.errors += 1;
      console.error('[marketplace] hold sweep failed', { item: row.item_id, error: e.message });
    }
  }
  return summary;
}

// ── Server-confirmed payment (prepaid refusal before any charge) ─────────────────────────────────────
const DECLINE_MESSAGES = {
  insufficient_funds: 'Your card has insufficient funds. Please use another debit or credit card.',
  expired_card: 'Your card has expired. Please use another debit or credit card.',
  incorrect_cvc: "Your card's security code is incorrect.",
  incorrect_number: 'Your card number is incorrect.',
  processing_error: 'Your card could not be processed. Please try again.',
};
function declineError(e) {
  const code = (e && (e.decline_code || e.code)) || '';
  return err(402, 'CARD_DECLINED', DECLINE_MESSAGES[code] || 'Your card was declined. Please try another debit or credit card.');
}

// Step 1 (payment_method_id given): the browser created a PaymentMethod from the card field; the server reads the
// card's funding type, refuses 'prepaid' (422), then confirms the order's intent server-side.
// Step 2 (no payment_method_id): after the browser completed card authentication (3-D Secure), finalize by
// confirming again server-side. Returns { status, client_secret?, order }.
async function payOrder(orderId, buyerUserId, { paymentMethodId, idempotencyKey } = {}) {
  if (!marketplaceCheckoutEnabled()) throw err(403, 'CHECKOUT_DISABLED', 'Marketplace checkout is not currently available.');
  const { isPrepaid, PREPAID_MESSAGE } = require('./cardService');
  if (!isUuid(orderId)) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
  const o = (await db.query('SELECT * FROM marketplace_orders WHERE id = $1 AND buyer_user_id = $2', [orderId, buyerUserId])).rows[0];
  if (!o) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (o.payment_status === 'paid') return { status: 'succeeded', order: buyerOrder(o) };
  if (o.payment_status !== 'pending' || !o.stripe_payment_intent_id) {
    throw err(409, 'ORDER_NOT_PAYABLE', 'This checkout has ended. Please start again.');
  }
  // The seller may have been suspended or lost verification since the order was started: never charge in that case.
  await assertSellerCanSell(o.seller_id);
  // Hold must still be ours and unexpired; extend it so card authentication can't outlive it.
  const hold = await db.query(
    `UPDATE marketplace_items
        SET pending_expires_at = GREATEST(pending_expires_at, now() + interval '${CLAIM_TTL_MINUTES} minutes'), updated_at = now()
      WHERE id = $1 AND status = 'pending_purchase' AND pending_order_id = $2 AND pending_expires_at > now()`,
    [o.marketplace_item_id, o.id]);
  if (!hold.rowCount) throw err(409, 'ORDER_NOT_PAYABLE', 'Your checkout session expired. Please start again.');

  const stripe = getStripe();
  const refuse = async (pm) => {
    try {
      await auditService.logEvent(db, { eventType: 'marketplace_order.prepaid_refused', entityType: 'marketplace_order',
        entityId: o.id, actorId: buyerUserId, metadata: { brand: pm.card && pm.card.brand, last4: pm.card && pm.card.last4, funding: 'prepaid' } });
    } catch (_) { /* audit is best-effort */ }
    throw err(422, 'PREPAID_NOT_ACCEPTED', PREPAID_MESSAGE);
  };

  let intent;
  if (paymentMethodId) {
    let pm;
    try { pm = await stripe.paymentMethods.retrieve(String(paymentMethodId)); }
    catch (_) { throw err(422, 'CARD_INVALID', 'That card could not be read. Please re-enter your card.'); }
    if (!pm || pm.type !== 'card' || !pm.card) throw err(422, 'CARD_REQUIRED', 'Please use a debit or credit card.');
    if (isPrepaid(pm)) await refuse(pm);
    if (pm.customer) {
      const u = (await db.query('SELECT stripe_customer_id FROM users WHERE id = $1', [buyerUserId])).rows[0];
      if (!u || u.stripe_customer_id !== pm.customer) throw err(403, 'CARD_NOT_YOURS', 'That card cannot be used for this order.');
    }
    try {
      intent = await stripe.paymentIntents.confirm(o.stripe_payment_intent_id, { payment_method: pm.id },
        { idempotencyKey: 'mo-confirm:' + o.id + ':' + (idempotencyKey || pm.id) });
    } catch (e) {
      if (e && (e.type === 'StripeCardError' || e.type === 'card_error')) throw declineError(e);
      throw err(502, 'PAYMENT_FAILED', 'Your payment could not be completed. Please try again.');
    }
  } else {
    const current = await stripe.paymentIntents.retrieve(o.stripe_payment_intent_id, { expand: ['payment_method'] });
    if (current.status === 'requires_confirmation') {
      const pm = current.payment_method && typeof current.payment_method === 'object' ? current.payment_method : null;
      if (pm && isPrepaid(pm)) await refuse(pm);
      try {
        intent = await stripe.paymentIntents.confirm(o.stripe_payment_intent_id, {},
          idempotencyKey ? { idempotencyKey: 'mo-finalize:' + o.id + ':' + idempotencyKey } : undefined);
      } catch (e) {
        if (e && (e.type === 'StripeCardError' || e.type === 'card_error')) throw declineError(e);
        throw err(502, 'PAYMENT_FAILED', 'Your payment could not be completed. Please try again.');
      }
    } else {
      intent = current;
    }
  }

  if (intent.status === 'succeeded') {
    await markOrderPaid(intent); // idempotent with the webhook
    const fresh = (await db.query('SELECT * FROM marketplace_orders WHERE id = $1', [o.id])).rows[0];
    return { status: 'succeeded', order: buyerOrder(fresh) };
  }
  if (intent.status === 'requires_action') return { status: 'requires_action', client_secret: intent.client_secret, order: buyerOrder(o) };
  if (intent.status === 'processing') return { status: 'processing', order: buyerOrder(o) };
  if (intent.status === 'requires_payment_method') throw err(402, 'CARD_DECLINED', 'Your card was declined. Please try another debit or credit card.');
  return { status: intent.status, order: buyerOrder(o) };
}

// ── Webhook: PaymentIntent lifecycle for marketplace orders (routed from paymentService dispatcher) ───
// payment_failed does NOT release the item: the same PaymentIntent can still succeed when the buyer retries with
// another card. Holds are released only on cancellation or expiry (sweeper).
async function handleIntentEvent(type, intent) {
  if (type === 'payment_intent.succeeded') return markOrderPaid(intent);
  if (type === 'payment_intent.canceled') {
    const o = (await db.query('SELECT id FROM marketplace_orders WHERE stripe_payment_intent_id = $1', [intent.id])).rows[0];
    if (o) await releaseOrder(o.id, 'stripe:' + type);
    return;
  }
  // payment_intent.payment_failed → intentionally no state change.
}

function intentMismatch(o, intent) {
  const md = (intent && intent.metadata) || {};
  if (md.marketplace_order_id && md.marketplace_order_id !== o.id) return 'order';
  if (md.seller_id && md.seller_id !== o.seller_id) return 'seller';
  if (md.buyer_user_id && md.buyer_user_id !== o.buyer_user_id) return 'buyer';
  if (intent.currency && String(intent.currency).toLowerCase() !== String(o.currency || 'usd').toLowerCase()) return 'currency';
  const amount = Number(intent.amount_received != null ? intent.amount_received : intent.amount);
  if (Number.isFinite(amount) && amount !== Number(o.total_charge_cents)) return 'amount';
  return null;
}

async function markOrderPaid(intent) {
  const chargeId = (intent.latest_charge && (intent.latest_charge.id || intent.latest_charge)) || null;
  let paidOrder = null;
  let conflict = null;
  await withTransaction(async (client) => {
    const o = (await client.query(
      'SELECT * FROM marketplace_orders WHERE stripe_payment_intent_id = $1 FOR UPDATE', [intent.id])).rows[0];
    if (!o) throw new Error('No marketplace order for intent ' + intent.id); // orphan → event marked failed, operator reconciles
    if (o.payment_status === 'paid') return;                                 // idempotent
    if (o.payment_status === 'refunded' || o.refund_status === 'refunded') return; // money already returned
    // The payment must be for exactly this order: same order and seller in its metadata, same currency, the full total.
    // A mismatch is never "corrected" by marking the order paid — it is held for a person to review.
    const mismatch = intentMismatch(o, intent);
    if (mismatch) {
      await client.query(`UPDATE marketplace_orders SET review_required = true, review_note = $2, updated_at = now() WHERE id = $1`,
        [o.id, 'Payment does not match this order (' + mismatch + '); not marked paid. Review required.']);
      await recordEvent(client, o.id, 'payment_mismatch', { data: { intent_id: intent.id, mismatch } });
      console.error('[marketplace] payment/order mismatch', { order: o.id, intent: intent.id, mismatch });
      return;
    }
    const item = (await client.query(
      'SELECT id, status, pending_order_id FROM marketplace_items WHERE id = $1 FOR UPDATE', [o.marketplace_item_id])).rows[0];
    const claimedByThis = !!(item && item.status === 'pending_purchase' && item.pending_order_id === o.id);
    if (o.payment_status === 'failed' || !claimedByThis) {
      let reason = 'order_failed';
      if (!item) reason = 'item_missing';
      else if (item.status === 'sold') reason = 'item_sold';
      else if (item.status === 'removed') reason = 'item_removed';
      else if (item.status === 'pending_purchase' && item.pending_order_id !== o.id) reason = 'item_claimed_by_other_order';
      else if (o.payment_status === 'failed') reason = 'order_failed';
      else reason = 'item_not_claimed';
      conflict = { order: o, reason };
      return;
    }
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
    await recordEvent(client, o.id, 'paid', { data: { intent_id: intent.id, charge_id: chargeId, total_charge_cents: o.total_charge_cents } });
    // Seller "item sold" notice: queued in THIS transaction, so a paid order always has it and an unpaid one never does
    // (delivered with retries by storefrontNotificationService).
    await require('./storefrontNotificationService').enqueueSalePaid(client, o.id);
    paidOrder = o;
  });
  if (conflict) return refundConflict(conflict.order, intent, chargeId, conflict.reason);
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

// A charge succeeded for an order that can no longer be fulfilled (its hold was lost). Refund it in full
// automatically (idempotent key per order), record why, audit, tell the buyer, and complete the webhook. The
// item is NOT touched (it belongs to whoever holds it now). If the refund call itself fails, throw so the
// webhook retries — the refund is idempotent.
async function refundConflict(o, intent, chargeId, reason) {
  const amount = Number(intent.amount_received) || Number(intent.amount) || o.total_charge_cents;
  const stripe = getStripe();
  try {
    await stripe.refunds.create({ payment_intent: intent.id, amount }, { idempotencyKey: 'mo-conflict-refund:' + o.id });
  } catch (e) {
    if (!(e && e.code === 'charge_already_refunded')) throw e;
  }
  let applied = false;
  await withTransaction(async (client) => {
    const cur = (await client.query('SELECT * FROM marketplace_orders WHERE id = $1 FOR UPDATE', [o.id])).rows[0];
    if (!cur || cur.refund_status === 'refunded') return;
    await client.query(
      `UPDATE marketplace_orders
          SET payment_status = 'refunded', refund_status = 'refunded', refunded_amount_cents = $2,
              stripe_charge_id = COALESCE($3, stripe_charge_id), refund_reason = $4,
              payout_eligible = false, payout_eligible_at = NULL, refunded_at = now(), updated_at = now()
        WHERE id = $1`, [o.id, amount, chargeId, 'conflict:' + reason]);
    await auditService.logEvent(client, {
      eventType: 'marketplace_order.conflict_refunded', entityType: 'marketplace_order', entityId: o.id,
      metadata: { intent_id: intent.id, refunded_amount_cents: amount, reason },
    });
    await recordEvent(client, o.id, 'refund', { data: { kind: 'conflict', refunded_amount_cents: amount, reason } });
    applied = true;
  });
  if (applied) {
    try { await require('./marketplaceOrderNotifier').sendConflictRefunded(o.id); }
    catch (e) { console.error('[marketplace] conflict refund notification failed', o.id, e.message); }
  }
  return { conflict: true, reason };
}

// ── Refund bookkeeping (full, partial, admin, or made outside the app) ────────────────────────────────
// Records a CUMULATIVE refunded amount and reverses sales tax: a first full refund reverses the tax transaction
// in full; anything else (partial, or the remainder after an earlier partial) reverses proportionally by amount.
// Every reversal reference is unique (`marketplace-refund:<order_number>[:<cumulative cents>]`) and distinct from
// the sale's own reference. A tax reversal that fails never breaks the refund — the order is flagged for review.
async function recordRefund(o, { cumulativeRefundedCents, adminId, reason, note } = {}) {
  const prior = Number(o.refunded_amount_cents) || 0;
  const total = Number(o.total_charge_cents) || 0;
  const cumulative = Math.min(total, Math.max(0, Math.round(Number(cumulativeRefundedCents) || 0)));
  const delta = cumulative - prior;
  if (delta <= 0 && !(cumulative >= total && o.refund_status !== 'refunded')) return publicOrder(o);
  const full = cumulative >= total;

  let reversalId = null;
  let reviewNote = null;
  if (o.stripe_tax_transaction_id) {
    try {
      if (full && prior === 0) {
        reversalId = await taxService.reverseFullTransaction({ originalTransactionId: o.stripe_tax_transaction_id,
          reference: 'marketplace-refund:' + o.order_number });
      } else if (typeof taxService.reversePartialTransaction === 'function') {
        reversalId = await taxService.reversePartialTransaction({ originalTransactionId: o.stripe_tax_transaction_id,
          reference: 'marketplace-refund:' + o.order_number + ':' + cumulative, amountCents: delta });
      } else {
        reviewNote = 'Partial refund: sales tax reversal needs manual review.';
      }
    } catch (e) {
      console.error('[marketplace] tax reversal failed', o.id, e.message);
      reviewNote = 'Sales tax reversal could not be recorded automatically; review required.';
    }
  }

  if (full) return applyRefundState(o.id, cumulative, reversalId, adminId, { reason, reviewNote, note });

  // Partial: the order stays paid; proceeds need a person before settlement (payout is manual anyway).
  let out;
  await withTransaction(async (client) => {
    const upd = (await client.query(
      `UPDATE marketplace_orders
          SET refund_status = 'partially_refunded', refunded_amount_cents = $2,
              stripe_tax_reversal_id = COALESCE($3, stripe_tax_reversal_id),
              refund_reason = COALESCE($4, refund_reason),
              review_required = true,
              review_note = $5, updated_at = now()
        WHERE id = $1 AND refunded_amount_cents < $2 RETURNING *`,
      [o.id, cumulative, reversalId, reason || null,
       reviewNote || 'Partial refund recorded; adjust seller proceeds before settlement.'])).rows[0];
    if (upd) {
      await auditService.logEvent(client, {
        eventType: 'marketplace_order.partially_refunded', entityType: 'marketplace_order', entityId: o.id,
        actorId: adminId || null, metadata: { refunded_amount_cents: cumulative, delta_cents: delta, reversal_id: reversalId } });
      await recordEvent(client, o.id, 'refund', { actorUserId: adminId || null, actorRole: adminId ? 'admin' : 'system',
        data: { kind: 'partial', refunded_amount_cents: cumulative, delta_cents: delta, reason: reason || null } });
    }
    out = upd || o;
  });
  return publicOrder(out);
}

// charge.refunded reconcile (admin refunds, conflict refunds and refunds made outside the app, full or partial).
// Returns true if the charge belongs to a marketplace order.
async function tryHandleChargeRefunded(charge) {
  const intentId = charge.payment_intent && (charge.payment_intent.id || charge.payment_intent);
  if (!intentId) return false;
  const o = (await db.query('SELECT * FROM marketplace_orders WHERE stripe_payment_intent_id = $1', [intentId])).rows[0];
  if (!o) return false;
  if (o.refund_status === 'refunded') return true; // already fully recorded (admin/conflict refund)
  if (o.payment_status !== 'paid') {
    // A refund on a charge the app never recorded as a sale — keep it visible to an admin; never crash.
    await db.query(`UPDATE marketplace_orders SET review_required = true, review_note = $2, updated_at = now() WHERE id = $1`,
      [o.id, 'A refund was recorded for an order that was not marked paid; review required.']).catch(() => {});
    return true;
  }
  const chargeAmount = Number(charge.amount) || o.total_charge_cents;
  const refunded = Number(charge.amount_refunded) || 0;
  const full = charge.refunded === true || (refunded > 0 && refunded >= chargeAmount);
  const cumulative = full ? o.total_charge_cents : Math.min(refunded, o.total_charge_cents);
  if (!full && cumulative <= (Number(o.refunded_amount_cents) || 0)) return true; // nothing new
  await recordRefund(o, { cumulativeRefundedCents: cumulative, reason: 'external_refund' });
  return true;
}

// ── Admin refund (the remaining balance) — reuses the existing refund + tax reversal primitives ──────
async function refundOrder(orderId, opts = {}) {
  // An admin refund is an override of a real sale: it needs a named admin and a written reason (kept in the order history).
  const note = String(opts.reason || '').trim().slice(0, 500);
  if (!opts.adminId) throw err(403, 'ADMIN_REQUIRED', 'Only an administrator can refund an order.');
  if (note.length < 5) throw err(422, 'REASON_REQUIRED', 'Give a short reason for this refund.');
  if (!isUuid(orderId)) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
  const o = (await db.query('SELECT * FROM marketplace_orders WHERE id = $1', [orderId])).rows[0];
  if (!o) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (o.refund_status === 'refunded') return publicOrder(o); // idempotent
  if (o.payment_status !== 'paid') throw err(409, 'NOT_REFUNDABLE', 'Only a paid order can be refunded.');
  if (!o.stripe_payment_intent_id) throw err(409, 'NO_INTENT', 'Order has no payment to refund.');

  const prior = Number(o.refunded_amount_cents) || 0;
  const remaining = o.total_charge_cents - prior;
  if (remaining > 0) {
    const stripe = getStripe();
    await stripe.refunds.create(
      { payment_intent: o.stripe_payment_intent_id, amount: remaining },
      { idempotencyKey: prior === 0 ? ('mo-refund:' + o.id) : ('mo-refund:' + o.id + ':' + prior) });
  }
  const updated = await recordRefund(o, { cumulativeRefundedCents: o.total_charge_cents, adminId: opts.adminId, reason: 'admin_refund', note });
  try { await require('./marketplaceOrderNotifier').sendRefunded(o.id); } catch (e) { /* best-effort */ }
  return updated;
}

// Persist refunded state: money reversed, payout eligibility removed, item moved to a NON-PUBLIC state
// (relist-required — never auto-relisted). Historical order/refund records are preserved (no deletes).
async function applyRefundState(orderId, refundedCents, reversalId, adminId, extra = {}) {
  let out;
  await withTransaction(async (client) => {
    const o = (await client.query('SELECT * FROM marketplace_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!o || o.refund_status === 'refunded') { out = o; return; }
    const upd = (await client.query(
      `UPDATE marketplace_orders
          SET payment_status = 'refunded', refund_status = 'refunded', refunded_amount_cents = $2,
              stripe_tax_reversal_id = COALESCE($3, stripe_tax_reversal_id),
              refund_reason = COALESCE($4, refund_reason),
              review_required = CASE WHEN $5::text IS NOT NULL THEN true ELSE review_required END,
              review_note = COALESCE($5, review_note),
              payout_eligible = false, payout_eligible_at = NULL, refunded_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`, [orderId, refundedCents, reversalId, extra.reason || null, extra.reviewNote || null])).rows[0];
    // Item → non-public 'removed'. Seller must explicitly RELIST (its physical disposition may be uncertain).
    await client.query(
      `UPDATE marketplace_items SET status = 'removed', pending_order_id = NULL, pending_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('sold','pending_purchase')`, [o.marketplace_item_id]);
    await auditService.logEvent(client, {
      eventType: 'marketplace_order.refunded', entityType: 'marketplace_order', entityId: orderId,
      actorId: adminId || null, metadata: { refunded_amount_cents: refundedCents, reversal_id: reversalId, reason: extra.reason || null } });
    await recordEvent(client, orderId, 'refund', { actorUserId: adminId || null, actorRole: adminId ? 'admin' : 'system',
      data: { kind: 'full', refunded_amount_cents: refundedCents, reason: extra.reason || null, note: extra.note || null } });
    out = upd;
  });
  return publicOrder(out);
}

// Seller explicitly relists a refunded/removed/draft item. Preserves all historical orders.
async function relistItem(itemId, sellerActorRef) {
  return withTransaction(async (client) => {
    const seller = await sellerActor.sellerRow(sellerActorRef, client);
    if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
    if (!isProfessional(seller.seller_type)) throw err(403, 'NOT_PROFESSIONAL', 'Marketplace listings are for Professional Sellers.');
    const item = (await client.query('SELECT * FROM marketplace_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0];
    if (!item) throw err(404, 'ITEM_NOT_FOUND', 'Item not found.');
    if (item.seller_id !== seller.id) throw err(403, 'NOT_OWNER', 'Not your listing.');
    if (!['removed', 'draft'].includes(item.status)) throw err(409, 'NOT_RELISTABLE', 'Only a removed or draft item can be relisted.');
    if (item.moderation_status === 'taken_down') {
      throw err(409, 'TAKEN_DOWN', 'This listing was removed by Advantage.Bid and cannot be put back on sale. Contact support if you have questions.');
    }
    // A sold item stays sold even after it is removed from view: only a refunded or failed sale frees it again.
    const live = (await client.query(
      `SELECT count(*)::int AS n FROM marketplace_orders WHERE marketplace_item_id = $1 AND payment_status IN ('pending','processing','paid')`,
      [itemId])).rows[0];
    if (live && live.n > 0) throw err(409, 'ITEM_SOLD', 'This item has been sold. It can be removed from view but not offered again.');
    const upd = (await client.query(
      `UPDATE marketplace_items SET status = 'active', pending_order_id = NULL, pending_expires_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`, [itemId]).catch((e) => {
      if (e && e.code === '23505' && /inventory_number/.test(String(e.constraint || e.message || ''))) {
        throw err(409, 'INVENTORY_NUMBER_TAKEN', 'Another live listing uses this inventory number. Change one of them, then relist.');
      }
      throw e;
    })).rows[0];
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
async function updateFulfillment(orderId, sellerActorRef, action, opts = {}) {
  const sellerUserId = sellerActor.actorUserId(sellerActorRef);
  const spec = FULFILL[action];
  if (!spec) throw err(400, 'BAD_ACTION', 'Unknown fulfillment action.');
  if (!isUuid(orderId)) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
  return withTransaction(async (client) => {
    const seller = await sellerActor.sellerRow(sellerActorRef, client);
    if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
    const o = (await client.query('SELECT * FROM marketplace_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
    if (o.seller_id !== seller.id) throw err(403, 'NOT_OWNER', 'Not your order.');
    if (o.payment_status !== 'paid') throw err(409, 'NOT_PAID', 'Order is not paid.');
    if (o.fulfillment_method !== spec.method) throw err(409, 'WRONG_METHOD', 'That action does not apply to this order.');
    if (!spec.from.includes(o.fulfillment_status)) throw err(409, 'BAD_TRANSITION', 'That fulfillment step is not available now.');
    if (o.refund_status === 'refunded') throw err(409, 'ORDER_REFUNDED', 'This order was refunded.');
    const clip = (v, n) => (v == null ? '' : String(v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n));
    const carrier = action === 'shipped' ? clip(opts.tracking_carrier, 60) : '';
    const tracking = action === 'shipped' ? clip(opts.tracking_number, 80) : '';
    if (action === 'shipped' && (!carrier || !tracking)) {
      throw err(422, 'TRACKING_REQUIRED', 'Enter the carrier and tracking number for this shipment.');
    }
    // Payout eligibility is a flag (no money moves) and is never set while the order is on hold (e.g. a chargeback).
    const upd = (await client.query(
      `UPDATE marketplace_orders
          SET fulfillment_status = $2,
              tracking_carrier = COALESCE($3, tracking_carrier),
              tracking_number  = COALESCE($4, tracking_number),
              payout_eligible    = CASE WHEN $5 AND NOT payout_hold THEN true ELSE payout_eligible END,
              payout_eligible_at = CASE WHEN $5 AND NOT payout_hold AND payout_eligible_at IS NULL THEN now() ELSE payout_eligible_at END,
              updated_at = now()
        WHERE id = $1 RETURNING *`, [orderId, spec.to, carrier || null, tracking || null, spec.eligible])).rows[0];
    await auditService.logEvent(client, {
      eventType: 'marketplace_order.fulfillment', entityType: 'marketplace_order', entityId: orderId,
      actorId: sellerUserId, metadata: { action, to: spec.to, payout_eligible: upd.payout_eligible } });
    await recordEvent(client, orderId, 'fulfillment', { actorUserId: sellerUserId, actorRole: 'seller',
      data: { action, from: o.fulfillment_status, to: spec.to, tracking_carrier: carrier || null, tracking_number: tracking || null,
        payout_eligible: upd.payout_eligible } });
    return sellerOrderView(upd, sellerActorRef);
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

// The buyer's view: their own money and fulfillment, without the seller's fee or proceeds.
function buyerOrder(o) {
  const p = publicOrder(o);
  if (!p) return null;
  delete p.platform_fee_bps; delete p.platform_fee_cents; delete p.seller_proceeds_cents; delete p.payout_eligible;
  return p;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v || ''));

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
  return rows.map((r) => ({ ...buyerOrder(r), item_title: r.item_title, thumbnail_url: r.thumbnail_url,
    seller_name: r.seller_name, storefront_slug: r.storefront_slug }));
}

// The seller company's view of an order, shaped by the person's role: fees, proceeds and payout status need
// company.finance.view; the buyer's name, email and ship-to need company.orders.fulfil and a PAID order. A refunded order
// is no longer the seller's to fulfill, so its buyer contact and ship-to are withheld. No payment PII, ever.
function sellerOrderView(o, actor, extra = {}) {
  const p = publicOrder(o);
  if (!p) return null;
  if (!sellerActor.can(actor, 'company.finance.view')) {
    delete p.platform_fee_bps; delete p.platform_fee_cents; delete p.seller_proceeds_cents; delete p.payout_eligible;
  }
  const contact = o.payment_status === 'paid' && sellerActor.can(actor, 'company.orders.fulfil');
  p.ship_to = contact ? (o.ship_to || null) : null;
  return { ...p, ...extra, buyer_name: contact ? (o.buyer_full_name || null) : null, buyer_email: contact ? (o.buyer_email || null) : null };
}

async function listForSeller(sellerActorRef) {
  const seller = await sellerActor.sellerRow(sellerActorRef);
  if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  const { rows } = await db.query(
    `SELECT o.*, mi.title AS item_title, mi.thumbnail_url,
            bu.email AS buyer_email, bu.full_name AS buyer_full_name
       FROM marketplace_orders o
       JOIN marketplace_items mi ON mi.id = o.marketplace_item_id
       JOIN users bu ON bu.id = o.buyer_user_id
      WHERE o.seller_id = $1 AND o.payment_status IN ('paid','refunded')
      ORDER BY o.created_at DESC`, [seller.id]);
  // Seller sees only the buyer contact necessary to fulfill a PAID order (name/email + shipping snapshot), and only
  // people whose role fulfils orders see it (sellerOrderView).
  return rows.map((r) => sellerOrderView(r, sellerActorRef, { item_title: r.item_title, thumbnail_url: r.thumbnail_url,
    inventory_number: (r.item_snapshot && r.item_snapshot.inventory_number) || null }));
}

// Single-order fetch, ownership-scoped (used by the buyer confirmation poll + seller/admin detail).
async function getForBuyer(orderId, buyerUserId) {
  if (!isUuid(orderId)) return null;
  const o = (await db.query('SELECT * FROM marketplace_orders WHERE id = $1 AND buyer_user_id = $2', [orderId, buyerUserId])).rows[0];
  return o ? buyerOrder(o) : null;
}
async function getForSeller(orderId, sellerActorRef) {
  if (!isUuid(orderId)) return null;
  const seller = await sellerActor.sellerRow(sellerActorRef);
  if (!seller) return null;
  const o = (await db.query(
    `SELECT o.*, bu.email AS buyer_email, bu.full_name AS buyer_full_name
       FROM marketplace_orders o JOIN users bu ON bu.id = o.buyer_user_id
      WHERE o.id = $1 AND o.seller_id = $2`, [orderId, seller.id])).rows[0];
  return o ? sellerOrderView(o, sellerActorRef) : null;
}

// Order history (append-only, migration 197). Buyer → their own order; seller → their own order; admin → any.
// Buyers and sellers see what happened and when, not internal payment references.
async function orderHistory(orderId, { buyerUserId, sellerUserId, seller: sellerRef, admin } = {}) {
  const sellerActorRef = sellerRef || sellerUserId;
  if (!isUuid(orderId)) return null;
  let o;
  if (admin) o = (await db.query('SELECT id FROM marketplace_orders WHERE id = $1', [orderId])).rows[0];
  else if (buyerUserId) o = (await db.query('SELECT id FROM marketplace_orders WHERE id = $1 AND buyer_user_id = $2', [orderId, buyerUserId])).rows[0];
  else if (sellerActorRef) {
    const s = await sellerActor.sellerRow(sellerActorRef);
    if (s) o = (await db.query('SELECT o.id FROM marketplace_orders o WHERE o.id = $1 AND o.seller_id = $2', [orderId, s.id])).rows[0];
  }
  if (!o) return null;
  const { rows } = await db.query(
    'SELECT event_type, actor_role, actor_user_id, data, created_at FROM marketplace_order_events WHERE order_id = $1 ORDER BY created_at ASC, id ASC', [o.id]);
  const SHARED = ['action', 'from', 'to', 'tracking_carrier', 'tracking_number', 'kind', 'refunded_amount_cents', 'category', 'status', 'method'];
  return rows.map((r) => {
    const d = r.data || {};
    const shown = admin ? d : Object.fromEntries(Object.entries(d).filter(([k]) => SHARED.includes(k)));
    return { event: r.event_type, by: r.actor_role, at: r.created_at, ...(admin ? { actor_user_id: r.actor_user_id } : {}), details: shown };
  });
}

// Admin: place or release a payout hold on an order (a flag; no money moves). Reason required; kept in the order history.
async function setPayoutHold(orderId, adminId, { hold, reason } = {}) {
  if (!adminId) throw err(403, 'ADMIN_REQUIRED', 'Only an administrator can change a payout hold.');
  if (!isUuid(orderId)) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
  const note = String(reason || '').trim().slice(0, 500);
  if (note.length < 5) throw err(422, 'REASON_REQUIRED', 'Give a short reason.');
  return withTransaction(async (client) => {
    const o = (await client.query('SELECT * FROM marketplace_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
    const on = hold !== false;
    const upd = (await client.query(
      `UPDATE marketplace_orders SET payout_hold = $2, payout_hold_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [o.id, on, on ? note : null])).rows[0];
    await recordEvent(client, o.id, on ? 'payout_hold' : 'payout_hold_released', { actorUserId: adminId, actorRole: 'admin', data: { reason: note } });
    await auditService.logEvent(client, { eventType: on ? 'marketplace_order.payout_hold' : 'marketplace_order.payout_hold_released',
      entityType: 'marketplace_order', entityId: o.id, actorId: adminId, metadata: { reason: note } });
    return publicOrder(upd);
  });
}

// Chargeback on a storefront order (from disputeService): hold the payout and flag for review, inside the dispute's
// transaction. Returns the order's own seller id so the dispute is recorded against the real seller.
async function holdForDispute(client, orderId, { disputeId, reason, closed } = {}) {
  const o = (await client.query('SELECT id, seller_id, payout_hold FROM marketplace_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
  if (!o) return null;
  if (!closed && !o.payout_hold) {
    await client.query(
      `UPDATE marketplace_orders SET payout_hold = true, payout_hold_reason = $2, review_required = true,
              review_note = $2, updated_at = now() WHERE id = $1`, [o.id, `Payment dispute ${disputeId} (${reason || 'unspecified'}) - payout held until reviewed`]);
  }
  await recordEvent(client, o.id, closed ? 'dispute_closed' : 'dispute', { data: { dispute_id: disputeId, reason: reason || null, hold_applied: !closed && !o.payout_hold } });
  return o;
}

// Admin read model: every storefront order with the money snapshot, fulfillment, payout flag and refund state.
async function listForAdmin({ status, limit } = {}) {
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 200));
  const params = [lim];
  let where = '';
  if (status === 'review') where = 'WHERE o.review_required = true';
  else if (['pending', 'processing', 'paid', 'failed', 'refunded'].includes(status)) { params.push(status); where = 'WHERE o.payment_status = $2'; }
  const { rows } = await db.query(
    `SELECT o.*, mi.title AS item_title,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name,
            bu.email AS buyer_email, mi.pickup_location_source, mi.pickup_address_line1, mi.pickup_address_line2, mi.pickup_city,
            mi.pickup_state, mi.pickup_postal_code, mi.pickup_country, sp.default_pickup_address_line1, sp.default_pickup_address_line2,
            sp.default_pickup_city, sp.default_pickup_state, sp.default_pickup_postal_code, sp.default_pickup_country, sp.default_pickup_confirmed_at
       FROM marketplace_orders o
       JOIN marketplace_items mi ON mi.id = o.marketplace_item_id
       JOIN seller_profiles sp ON sp.id = o.seller_id
       JOIN users bu ON bu.id = o.buyer_user_id
       ${where}
      ORDER BY o.created_at DESC
      LIMIT $1`, params);
  return rows.map((r) => ({ ...publicOrder(r), item_title: r.item_title, seller_name: r.seller_name, buyer_email: r.buyer_email,
    refund_reason: r.refund_reason || null, review_required: !!r.review_required, review_note: r.review_note || null,
    refunded_at: r.refunded_at || null, is_demo: !!r.is_demo,
    // Admin/staff operations: the item's effective pickup location (full address; admin-only route).
    pickup_location: (() => { const e = saleLocation.forItem(r); return { source: e.source, address: e.address, missing: e.missing || [] }; })() }));
}

module.exports = {
  STOREFRONT_FEE_BPS, STOREFRONT_FEE_ADVANTAGE_BPS, STOREFRONT_FEE_PROCESSING_BPS, STOREFRONT_BUYER_PREMIUM_BPS,
  feeBpsForSeller, computeBreakdown, loadItemForPurchase, quote, createOrder,
  handleIntentEvent, tryHandleChargeRefunded, markOrderPaid, refundOrder, applyRefundState,
  relistItem, updateFulfillment, releaseOrder, listForBuyer, listForSeller,
  getForBuyer, getForSeller, publicOrder, buyerOrder, listForAdmin, orderHistory, setPayoutHold, holdForDispute, purchaseSnapshot,
  intentMismatch, recordEvent,
  payOrder, sweepExpiredHolds, releaseExpiredHold, resolveTaxLocation, recordRefund, refundConflict,
};
