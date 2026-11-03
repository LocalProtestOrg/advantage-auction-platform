#!/usr/bin/env node
/* checkout-race-test.js — many buyers at the same moment against a REAL Postgres (a disposable test copy, e.g. a Neon
   branch of production made for this test). Proves under true concurrency that storefront stock is never oversold and
   no unit is sold twice (migration 212). Never production; the payment processor is an in-memory stand-in.

   Usage:
     RACE_DATABASE_URL=postgres://...test-branch... CONFIRM_DISPOSABLE=yes node scripts/checkout-race-test.js [buyers=40] [units=7]

   Refuses: no RACE_DATABASE_URL, the production endpoint, or no CONFIRM_DISPOSABLE=yes. It creates labelled test rows
   (users race-*@race.invalid, a demo seller, items), runs the real order service with a 30-connection pool, checks the
   results, then deletes what it created. Exit code 0 = pass. */
'use strict';
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const url = process.env.RACE_DATABASE_URL || '';
if (!url) { console.error('REFUSE: set RACE_DATABASE_URL to a disposable test database.'); process.exit(2); }
if (url.includes(PROD_EP)) { console.error('REFUSE: that is the production database.'); process.exit(2); }
if (process.env.CONFIRM_DISPOSABLE !== 'yes') { console.error('REFUSE: set CONFIRM_DISPOSABLE=yes to confirm this database is a disposable test copy.'); process.exit(2); }

const BUYERS = Math.max(2, parseInt(process.argv[2] || '40', 10));
const UNITS = Math.max(1, parseInt(process.argv[3] || '7', 10));
process.env.DATABASE_URL = url;
process.env.MARKETPLACE_CHECKOUT_ENABLED = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_race_placeholder';
process.env.STRIPE_TAX_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'race-test-only';
require('../tests/fullstack/fakeStripePreload');   // payment stand-in (no network, nothing charged)
const { Pool } = require('pg');
const dbmod = require('../src/db');
// A larger pool than the app's default, so the race is limited by the database's locks, not by the pool.
const pool = new Pool({ connectionString: url.replace('-pooler', ''), ssl: { rejectUnauthorized: false }, max: 30 });
dbmod.query = (t, p) => pool.query(t, p); dbmod.connect = () => pool.connect();
const orders = require('../src/services/marketplaceOrderService');

(async () => {
  const q = (t, p) => pool.query(t, p);
  const tag = 'race-' + Date.now().toString(36);
  const created = { users: [], seller: null, items: [] };
  let pass = false;
  try {
    const owner = (await q(`INSERT INTO users (email, role, full_name, is_demo) VALUES ($1, 'seller', 'Race Seller', true) RETURNING id`, [tag + '-owner@race.invalid'])).rows[0].id;
    created.users.push(owner);
    const sp = (await q(`INSERT INTO seller_profiles (user_id, seller_type, display_name, is_demo, agreement_waived_at,
        default_pickup_address_line1, default_pickup_city, default_pickup_state, default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at)
        VALUES ($1, 'retail_gallery_studio', 'Race Shop', true, now(), '1 Test St', 'Houston', 'TX', '77002', 'US', now()) RETURNING id`, [owner])).rows[0].id;
    created.seller = sp;
    await q(`INSERT INTO seller_payout_preferences (seller_user_id, payout_method, stripe_account_id, stripe_account_livemode, connect_transfers_active, connect_payouts_enabled)
             VALUES ($1, 'ach', $2, false, true, true)`, [owner, 'acct_test_' + tag]);
    const buyers = [];
    for (let i = 0; i < BUYERS; i++) {
      buyers.push((await q(`INSERT INTO users (email, role, full_name, is_demo) VALUES ($1, 'buyer', 'Race Buyer', true) RETURNING id`, [`${tag}-b${i}@race.invalid`])).rows[0].id);
    }
    created.users.push(...buyers);
    const mk = async (units) => (await q(`INSERT INTO marketplace_items (seller_id, title, price_cents, status, quantity, city, state, zip, pickup_location_source, is_demo)
        VALUES ($1, $2, 1000, 'active', $3, 'Houston', 'TX', '77002', 'default', true) RETURNING id`, [sp, 'Race item ' + tag, units])).rows[0].id;

    // 1. Every buyer wants one unit at the same moment.
    const one = await mk(UNITS); created.items.push(one);
    const r1 = await Promise.allSettled(buyers.map((b) => orders.createOrder(one, b, { quantity: 1, policiesAcknowledged: true })));
    const ok1 = r1.filter((r) => r.status === 'fulfilled').length;
    const st1 = (await q('SELECT quantity, status FROM marketplace_items WHERE id = $1', [one])).rows[0];
    const held1 = Number((await q(`SELECT coalesce(sum(quantity),0) n FROM marketplace_orders WHERE marketplace_item_id = $1 AND payment_status = 'pending' AND stock_released_at IS NULL`, [one])).rows[0].n);
    const bad1 = r1.filter((r) => r.status === 'rejected' && !['NOT_AVAILABLE', 'NOT_ENOUGH_AVAILABLE'].includes(r.reason && r.reason.code)).map((r) => r.reason && (r.reason.code || r.reason.message));
    console.log(`one unit each: ${ok1} orders for ${UNITS} units; available ${st1.quantity}; held ${held1}; other errors: ${JSON.stringify(bad1)}`);

    // 2. Everyone who holds a unit pays at the same moment (and each payment is sent twice).
    const held = (await q(`SELECT id, buyer_user_id FROM marketplace_orders WHERE marketplace_item_id = $1 AND payment_status = 'pending'`, [one])).rows;
    await Promise.allSettled(held.flatMap((o) => [orders.payOrder(o.id, o.buyer_user_id, { paymentMethodId: 'pm_ok' }), orders.payOrder(o.id, o.buyer_user_id, { paymentMethodId: 'pm_ok' })]));
    const st2 = (await q('SELECT quantity, quantity_sold, status FROM marketplace_items WHERE id = $1', [one])).rows[0];
    const soldEvents = Number((await q(`SELECT coalesce(sum(sold_delta),0) n FROM marketplace_stock_events WHERE item_id = $1 AND reason = 'sold'`, [one])).rows[0].n);
    console.log(`after paying: sold ${st2.quantity_sold}, available ${st2.quantity}, status ${st2.status}, sold in stock history ${soldEvents}`);

    // 3. Buyers want 3 each at the same moment.
    const multi = await mk(UNITS * 3 - 1); created.items.push(multi);
    const r3 = await Promise.allSettled(buyers.map((b) => orders.createOrder(multi, b, { quantity: 3, policiesAcknowledged: true })));
    const ok3 = r3.filter((r) => r.status === 'fulfilled').length;
    const st3 = (await q('SELECT quantity FROM marketplace_items WHERE id = $1', [multi])).rows[0];
    console.log(`three each: ${ok3} orders from ${UNITS * 3 - 1} units; available ${st3.quantity}`);

    pass = ok1 === Math.min(UNITS, BUYERS) && st1.quantity === Math.max(0, UNITS - BUYERS) && held1 === ok1 && bad1.length === 0
      && st2.quantity_sold === ok1 && soldEvents === ok1 && (ok1 < UNITS || st2.status === 'sold')
      && ok3 === Math.min(BUYERS, Math.floor((UNITS * 3 - 1) / 3)) && st3.quantity === (UNITS * 3 - 1) - ok3 * 3;
    console.log(pass ? 'RESULT: PASS (never oversold, never sold twice)' : 'RESULT: FAIL');
  } catch (e) {
    console.error('ERROR', e.message);
  } finally {
    // Remove only what this run created (demo-labelled rows of this run's tag).
    try {
      if (created.items.length) {
        await q('DELETE FROM marketplace_stock_events WHERE item_id = ANY($1::uuid[])', [created.items]).catch(() => {});
        await q('DELETE FROM marketplace_order_events WHERE order_id IN (SELECT id FROM marketplace_orders WHERE marketplace_item_id = ANY($1::uuid[]))', [created.items]).catch(() => {});
        await q('DELETE FROM marketplace_orders WHERE marketplace_item_id = ANY($1::uuid[]) AND is_demo = true', [created.items]).catch(() => {});
        await q('DELETE FROM marketplace_items WHERE id = ANY($1::uuid[])', [created.items]).catch(() => {});
      }
      if (created.seller) await q('DELETE FROM seller_profiles WHERE id = $1', [created.seller]).catch(() => {});
      if (created.users.length) {
        await q('DELETE FROM seller_payout_preferences WHERE seller_user_id = ANY($1::uuid[])', [created.users]).catch(() => {});
        await q('DELETE FROM users WHERE id = ANY($1::uuid[]) AND is_demo = true', [created.users]).catch(() => {});
      }
    } catch (_) { /* a disposable copy anyway */ }
    await pool.end();
    process.exit(pass ? 0 : 1);
  }
})();
