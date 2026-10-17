#!/usr/bin/env node
/* prod-migrate-204.js — PRODUCTION-guarded apply of ONLY 204_inventory_numbers_and_sale_notifications.sql (optional seller
   inventory numbers, unique per seller among live items; storefront notification outbox with guards). Additive; moves no
   money; changes no existing row (every inventory number starts empty; the outbox starts empty).

   --check  READ-ONLY: 203 applied, 204 not recorded, outbox table absent, no live (pending/processing) orders.
   (none)   applies in one transaction, then verifies the objects and that orders, items, seller profiles, payments,
            invoices, payouts and accounts are unchanged.
   Usage: railway run node scripts/prod-migrate-204.js [--check] */
const fs = require('fs'); const path = require('path');
const FILE = '204_inventory_numbers_and_sale_notifications.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const CHECK = process.argv.includes('--check');
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const one = async (sql, p) => (await c.query(sql, p || [])).rows[0];
    const has = async (sql, p) => !!(await one(sql, p));
    const h = async (sql) => (await one(sql)).h;
    const pre = async () => ({
      migration_203_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '203_seller_store_policies.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      table_exists: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'storefront_notifications'`),
      live_orders: Number((await one(`SELECT count(*)::int n FROM marketplace_orders WHERE payment_status IN ('pending','processing')`)).n),
      orders: Number((await one('SELECT count(*)::int n FROM marketplace_orders')).n),
    });
    const snap = async () => ({
      orders: await h(`SELECT md5(coalesce(string_agg(row_to_json(o)::text, ',' ORDER BY id), '')) h FROM (SELECT id, seller_id, buyer_user_id, marketplace_item_id,
        item_price_cents, shipping_cents, total_charge_cents, payment_status, refund_status, fulfillment_status, payout_eligible, item_snapshot FROM marketplace_orders) o`),
      items: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || seller_id::text || ':' || status || ':' || price_cents, ',' ORDER BY id), '')) h FROM marketplace_items`),
      sellers: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(user_id::text,''), ',' ORDER BY id), '')) h FROM seller_profiles`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
        || ':' || (SELECT count(*) FROM users))::text) h`),
    });
    if (CHECK) {
      await c.query('BEGIN READ ONLY'); const p = await pre(); await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = p.migration_203_applied && !p.already_recorded && !p.table_exists && p.live_orders === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }
    const p = await pre();
    if (!p.migration_203_applied) { console.error('REFUSE: migration 203 must be applied first'); return 1; }
    const before = await snap();
    if (p.already_recorded) console.log('SKIP (already recorded).');
    else {
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED', FILE);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    }
    const after = await snap();
    const checks = {
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename=$1', [FILE]),
      inventory_unique_per_seller: await has(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_marketplace_items_seller_inventory_number'`),
      outbox_guard: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_storefront_notifications_guard' AND NOT tgisinternal`),
      outbox_order_seller_key: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'fk_storefront_notifications_order_seller'`),
      outbox_empty: Number((await one('SELECT count(*)::int n FROM storefront_notifications')).n) === 0,
      inventory_numbers_empty: Number((await one('SELECT count(*)::int n FROM marketplace_items WHERE inventory_number IS NOT NULL')).n) === 0,
      orders_unchanged: before.orders === after.orders,
      items_unchanged: before.items === after.items,
      seller_profiles_unchanged: before.sellers === after.sellers,
      payments_invoices_payouts_users_unchanged: before.money === after.money,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
