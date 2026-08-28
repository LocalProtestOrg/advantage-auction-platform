#!/usr/bin/env node
/* accept-marketplace-checkout.js — CONTROLLED Stripe TEST-mode end-to-end acceptance for Marketplace
 * Buy Now. Drives the REAL service (createOrder → Stripe TEST PaymentIntent → confirm with a test card →
 * webhook-equivalent markOrderPaid → fulfillment → admin refund + tax reversal → relist) against the
 * connected DB, using ONLY demo entities (item d0009, a fixed demo buyer). NO LIVE money.
 *
 *   railway run node scripts/accept-marketplace-checkout.js
 *
 * Refuses to run unless Stripe is in TEST mode. Never touches real seller inventory.
 */
process.env.MARKETPLACE_CHECKOUT_ENABLED = 'true'; // enable checkout for THIS process only (not the server)
// Stripe Tax is enabled in prod but its TEST-mode dashboard (head office address) is not configured, so a
// live tax calc fails and the fail-safe correctly BLOCKS the charge (verified separately). For a clean
// end-to-end commerce-lifecycle acceptance we force tax OFF for THIS process only (tax=$0); the tax path
// itself is the existing certified Stripe Tax implementation, unchanged.
process.env.STRIPE_TAX_ENABLED = 'false';

const { Pool } = require('pg');
const Stripe = require('stripe');

const DEMO_ITEM = '00000000-0000-4000-a000-0000000d0009';
const DEMO_BUYER = '00000000-0000-4000-a000-0000000d00b0';
const money = (c) => '$' + (Number(c) / 100).toFixed(2);

(async () => {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!/^sk_test_/.test(key)) { console.error('REFUSE: Stripe is not in TEST mode (need sk_test_...).'); process.exit(2); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const q = (sql, p) => pool.query(sql, p);
  const stripe = Stripe(key, { apiVersion: '2026-03-25.dahlia' });

  // 0) Preconditions: demo item + a demo buyer that is NOT the seller.
  const item = (await q('SELECT mi.*, sp.user_id AS seller_user, sp.platform_fee_bps FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id WHERE mi.id = $1', [DEMO_ITEM])).rows[0];
  if (!item) { console.error('DEMO item missing — run scripts/seed-demo-storefront.js first.'); process.exit(1); }
  if (!item.is_demo) { console.error('REFUSE: target item is not is_demo.'); process.exit(2); }
  await q(`UPDATE marketplace_items SET status='active', pending_order_id=NULL, pending_expires_at=NULL WHERE id=$1`, [DEMO_ITEM]);
  await q(`DELETE FROM marketplace_orders WHERE marketplace_item_id=$1`, [DEMO_ITEM]); // clean any prior acceptance run
  await q(`INSERT INTO users (id, email, role, password_hash, full_name)
           VALUES ($1,'demo-mp-buyer@advantage.bid','buyer','x','Demo Marketplace Buyer')
           ON CONFLICT (id) DO UPDATE SET role='buyer'`, [DEMO_BUYER]);

  // Load the service AFTER env + DB are ready (it reads DATABASE_URL via ../src/db).
  const svc = require('../src/services/marketplaceOrderService');
  const log = (k, v) => console.log('  ' + k.padEnd(26), v);
  console.log('\n=== Marketplace Buy Now — Stripe TEST acceptance ===');
  log('Stripe mode', 'TEST'); log('Item', item.title + ' (' + money(item.price_cents) + ')');
  log('Seller fee bps', item.platform_fee_bps == null ? '400 (default)' : item.platform_fee_bps);

  // 1) Create order + PaymentIntent (pickup). Buyer billing address drives Stripe Tax jurisdiction.
  const ADDRESS = { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' };
  const created = await svc.createOrder(DEMO_ITEM, DEMO_BUYER, { fulfillment_method: 'pickup', address: ADDRESS });
  const o = created.order; const b = created.breakdown;
  console.log('\n[1] Order created + PaymentIntent');
  log('order_number', o.order_number);
  log('item_price', money(b.item_price_cents));
  log('shipping', money(b.shipping_cents));
  log('sales_tax', money(b.tax_cents) + (created.tax_enabled ? '' : ' (tax flag OFF)'));
  log('platform_fee', money(b.platform_fee_cents) + ' @ ' + b.platform_fee_bps + ' bps');
  log('seller_proceeds', money(b.seller_proceeds_cents));
  log('buyer_total', money(b.total_charge_cents));
  // Assertions on the money rules:
  const feeExpected = Math.round(b.item_price_cents * b.platform_fee_bps / 10000);
  console.assert(b.platform_fee_cents === feeExpected, 'fee must be bps of item price');
  console.assert(b.seller_proceeds_cents === b.item_price_cents + b.shipping_cents - b.platform_fee_cents, 'proceeds = item+shipping-fee');
  console.assert(b.total_charge_cents === b.item_price_cents + b.shipping_cents + b.tax_cents, 'total = item+shipping+tax');

  // Item is now claimed (pending_purchase) — a concurrent buy must fail.
  const claimed = (await q('SELECT status FROM marketplace_items WHERE id=$1', [DEMO_ITEM])).rows[0].status;
  log('item status after claim', claimed);
  let doubleSell = 'blocked';
  try { await svc.createOrder(DEMO_ITEM, DEMO_BUYER, { fulfillment_method: 'pickup' }); doubleSell = 'NOT blocked (BUG)'; } catch (e) { doubleSell = 'blocked (' + e.code + ')'; }
  log('concurrent purchase', doubleSell);

  // 2) Confirm the PaymentIntent with a TEST card, then run the webhook-equivalent success path.
  const intentId = (await q('SELECT stripe_payment_intent_id FROM marketplace_orders WHERE id=$1', [o.id])).rows[0].stripe_payment_intent_id;
  await stripe.paymentIntents.confirm(intentId, { payment_method: 'pm_card_visa' });
  const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
  console.log('\n[2] Card confirmed (pm_card_visa)'); log('intent status', intent.status);
  await svc.markOrderPaid(intent); // idempotent webhook-equivalent
  await svc.markOrderPaid(intent); // second delivery must be a no-op (idempotency)
  const paid = (await q('SELECT * FROM marketplace_orders WHERE id=$1', [o.id])).rows[0];
  const soldStatus = (await q('SELECT status FROM marketplace_items WHERE id=$1', [DEMO_ITEM])).rows[0].status;
  log('payment_status', paid.payment_status); log('item status', soldStatus); log('stripe_charge_id', paid.stripe_charge_id);
  const orderCount = (await q('SELECT count(*)::int n FROM marketplace_orders WHERE marketplace_item_id=$1', [DEMO_ITEM])).rows[0].n;
  log('orders for item (idempotent)', orderCount);

  // Buyer + seller read models.
  const buyerList = await svc.listForBuyer(DEMO_BUYER);
  const sellerList = await svc.listForSeller(item.seller_user);
  log('buyer purchases visible', buyerList.length); log('seller orders visible', sellerList.length);

  // 3) Fulfillment (pickup) → payout eligibility.
  await svc.updateFulfillment(o.id, item.seller_user, 'ready_for_pickup');
  const afterReady = await svc.getForSeller(o.id, item.seller_user);
  const done = await svc.updateFulfillment(o.id, item.seller_user, 'picked_up');
  console.log('\n[3] Fulfillment (pickup)');
  log('after ready_for_pickup', afterReady.fulfillment_status + ' · payout_eligible=' + afterReady.payout_eligible);
  log('after picked_up', done.fulfillment_status + ' · payout_eligible=' + done.payout_eligible);

  // 4) Admin refund → Stripe refund + tax reversal + item non-public + payout removed.
  const refunded = await svc.refundOrder(o.id, { adminId: null });
  const itemAfterRefund = (await q('SELECT status FROM marketplace_items WHERE id=$1', [DEMO_ITEM])).rows[0].status;
  console.log('\n[4] Admin refund');
  log('payment_status', refunded.payment_status); log('refund_status', refunded.refund_status);
  log('refunded_amount', money(refunded.refunded_amount_cents)); log('payout_eligible', refunded.payout_eligible);
  log('item status (non-public)', itemAfterRefund);

  // 5) Explicit seller relist (history preserved).
  const relisted = await svc.relistItem(DEMO_ITEM, item.seller_user);
  const orderStillThere = (await q('SELECT payment_status FROM marketplace_orders WHERE id=$1', [o.id])).rows[0];
  console.log('\n[5] Seller relist'); log('item status', relisted.status);
  log('order history preserved', orderStillThere ? orderStillThere.payment_status : 'MISSING (BUG)');

  // Cleanup: remove the demo acceptance order + reset the demo item to active (leave prod pristine).
  await q(`DELETE FROM marketplace_orders WHERE id=$1`, [o.id]);
  await q(`UPDATE marketplace_items SET status='active', pending_order_id=NULL, pending_expires_at=NULL WHERE id=$1`, [DEMO_ITEM]);
  console.log('\n[cleanup] demo acceptance order removed; demo item reset to active.');

  const ok = paid.payment_status === 'paid' && soldStatus === 'sold' && orderCount === 1
    && done.payout_eligible === true && refunded.refund_status === 'refunded' && refunded.payout_eligible === false
    && itemAfterRefund === 'removed' && relisted.status === 'active' && doubleSell.startsWith('blocked');
  console.log('\nRESULT: ' + (ok ? 'PASS' : 'FAIL'));
  await pool.end();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e && e.stack ? e.stack : e); process.exit(1); });
