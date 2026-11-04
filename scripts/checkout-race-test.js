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
// Nothing may leave this machine except database traffic to the test copy: every outside service (email, text messages,
// directory, maps, photo storage, chat, alerts) is switched off by blanking its settings, and blank settings are kept
// even if a local .env file is loaded later. The order emails the run triggers are therefore skipped, never sent.
for (const k of Object.keys(process.env)) {
  if (/SMTP|SES_|^EMAIL_|TWILIO|SMS|POSTMARK|SENDGRID|SLACK|WEBHOOK|ALERT|BD_API|OPENAI|ANTHROPIC|MAPBOX|GOOGLE|CLOUDINARY|STRIPE|SENTRY|WATCHDOG/i.test(k)) process.env[k] = '';
}
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'BD_API_KEY', 'OPENAI_API_KEY']) process.env[k] = '';
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
    const owner = (await q(`INSERT INTO users (email, password_hash, role, full_name, is_demo) VALUES ($1, '!no-login-race-test', 'seller', 'Race Seller', true) RETURNING id`, [tag + '-owner@race.invalid'])).rows[0].id;
    created.users.push(owner);
    // A seller that passes every real sale gate: not awaiting verification, a payout account, and a SIGNED agreement on a
    // version with the current storefront terms (a waiver no longer counts, 2026-11-03). The template and version are
    // labelled test rows of this run, created here and removed below.
    const sp = (await q(`INSERT INTO seller_profiles (user_id, seller_type, display_name, is_demo, verification_required_before_publication,
        default_pickup_address_line1, default_pickup_city, default_pickup_state, default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at)
        VALUES ($1, 'retail_gallery_studio', 'Race Shop', true, false, '1 Test St', 'Houston', 'TX', '77002', 'US', now()) RETURNING id`, [owner])).rows[0].id;
    created.seller = sp;
    const tpl = (await q(`INSERT INTO agreement_templates (agreement_type, name) VALUES ('custom', $1) RETURNING id`, ['Race test template ' + tag])).rows[0].id;
    created.template = tpl;
    const ver = (await q(`INSERT INTO agreement_template_versions (template_id, version_int, body_markdown) VALUES ($1, 1, $2) RETURNING id, storefront_fee_schedule`,
      [tpl, 'Race test terms. A sale through the embedded storefront (a "Website Sale").'])).rows[0];
    if (!ver.storefront_fee_schedule) throw new Error('the test agreement version was not marked with the current storefront terms');
    created.agreement = (await q(`INSERT INTO agreements (template_version_id, seller_profile_id, status) VALUES ($1, $2, 'signed') RETURNING id`, [ver.id, sp])).rows[0].id;
    const admin = (await q(`INSERT INTO users (email, password_hash, role, full_name, is_demo) VALUES ($1, '!no-login-race-test', 'admin', 'Race Admin', true) RETURNING id`, [tag + '-admin@race.invalid'])).rows[0].id;
    created.users.push(admin);
    await q(`INSERT INTO seller_payout_preferences (seller_user_id, payout_method, stripe_account_id, stripe_account_livemode, connect_transfers_active, connect_payouts_enabled)
             VALUES ($1, 'ach', $2, false, true, true)`, [owner, 'acct_test_' + tag]);
    const buyers = [];
    for (let i = 0; i < BUYERS; i++) {
      buyers.push((await q(`INSERT INTO users (email, password_hash, role, full_name, is_demo) VALUES ($1, '!no-login-race-test', 'buyer', 'Race Buyer', true) RETURNING id`, [`${tag}-b${i}@race.invalid`])).rows[0].id);
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

    // 4. Declined cards: the holders of the 3-unit orders all pay with a declined card at the same moment. Nothing sells,
    //    each order stays payable (the buyer may try another card), and the stock stays held, not released twice.
    const held3 = (await q(`SELECT id, buyer_user_id FROM marketplace_orders WHERE marketplace_item_id = $1 AND payment_status = 'pending'`, [multi])).rows;
    const r4 = await Promise.allSettled(held3.map((o) => orders.payOrder(o.id, o.buyer_user_id, { paymentMethodId: 'pm_decline' })));
    const st4 = (await q('SELECT quantity, quantity_sold FROM marketplace_items WHERE id = $1', [multi])).rows[0];
    const declined = r4.filter((r) => r.status === 'rejected').length;
    console.log(`declined cards: ${declined} of ${held3.length} refused; sold ${st4.quantity_sold}; available ${st4.quantity}`);

    // 5. Those holds expire: the sweeper and a second sweeper run at the same moment; every unit returns exactly once.
    await q(`UPDATE marketplace_orders SET hold_expires_at = now() - interval '1 minute' WHERE marketplace_item_id = $1 AND payment_status = 'pending'`, [multi]);
    await Promise.allSettled([orders.sweepExpiredHolds({ limit: 500 }), orders.sweepExpiredHolds({ limit: 500 })]);
    const st5 = (await q('SELECT quantity, quantity_sold FROM marketplace_items WHERE id = $1', [multi])).rows[0];
    console.log(`after the holds expire: available ${st5.quantity} of ${UNITS * 3 - 1}; sold ${st5.quantity_sold}`);

    // 6. Two administrators refund the same paid order at the same moment: one refund, recorded once.
    const paid = (await q(`SELECT id FROM marketplace_orders WHERE marketplace_item_id = $1 AND payment_status = 'paid' ORDER BY created_at LIMIT 1`, [one])).rows[0];
    let refundsMade = 0; let refundState = '-'; let afterRefund = null;
    if (paid) {
      const sent = require('stripe')._refunds; const before = sent.length;
      const r6 = await Promise.allSettled([1, 2].map(() => orders.refundOrder(paid.id, { adminId: admin, reason: 'Race test refund' })));
      // A repeat with the same idempotency key is answered by the processor with the first refund, so count distinct keys.
      const mine = sent.slice(before); refundsMade = new Set(mine.map((x) => x.key || Math.random())).size;
      if (mine.length !== refundsMade) console.log(`  (${mine.length} refund requests, all with the same idempotency key)`);
      refundState = (await q('SELECT payment_status FROM marketplace_orders WHERE id = $1', [paid.id])).rows[0].payment_status;
      for (const r of r6) if (r.status === 'rejected') console.log('  refund refused:', r.reason && (r.reason.code || '') + ' ' + r.reason.message);
      console.log(`double refund: ${r6.filter((r) => r.status === 'fulfilled').length} accepted, ${refundsMade} refund sent to the processor, order ${refundState}`);
      afterRefund = (await q('SELECT status, quantity_sold, quantity FROM marketplace_items WHERE id = $1', [one])).rows[0];
      console.log(`  item after one refund: ${afterRefund.status}, sold ${afterRefund.quantity_sold}, available ${afterRefund.quantity} (the other buyers' sales stand)`);
    }

    pass = ok1 === Math.min(UNITS, BUYERS) && st1.quantity === Math.max(0, UNITS - BUYERS) && held1 === ok1 && bad1.length === 0
      && st2.quantity_sold === ok1 && soldEvents === ok1 && (ok1 < UNITS || st2.status === 'sold')
      && ok3 === Math.min(BUYERS, Math.floor((UNITS * 3 - 1) / 3)) && st3.quantity === (UNITS * 3 - 1) - ok3 * 3
      && declined === held3.length && st4.quantity_sold === 0 && st4.quantity === st3.quantity
      && st5.quantity === UNITS * 3 - 1 && st5.quantity_sold === 0
      && (!paid || (refundsMade === 1 && refundState === 'refunded' && afterRefund.quantity_sold === ok1 - 1
        && (ok1 > 1 ? afterRefund.status === 'sold' : afterRefund.status !== 'active')));
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
      if (created.agreement) await q('DELETE FROM agreements WHERE id = $1', [created.agreement]).catch(() => {});
      if (created.template) {
        await q('DELETE FROM agreement_template_versions WHERE template_id = $1', [created.template]).catch(() => {});
        await q('DELETE FROM agreement_templates WHERE id = $1', [created.template]).catch(() => {});
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
