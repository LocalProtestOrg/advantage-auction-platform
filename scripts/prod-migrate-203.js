#!/usr/bin/env node
/* prod-migrate-203.js — PRODUCTION-guarded apply of ONLY 203_seller_store_policies.sql (seller Store Terms and Shipping &
   Pickup Policy versions; order policy snapshot + acknowledgment columns and guards). Additive; moves no money; changes no
   existing row (existing orders keep NULL policy columns).

   --check  READ-ONLY: 202 applied, 203 not recorded, table absent, no live (pending/processing) orders.
   (none)   applies in one transaction, then verifies the objects and that orders, items, seller profiles, payments,
            invoices, payouts and accounts are unchanged.
   Usage: railway run node scripts/prod-migrate-203.js [--check] */
const fs = require('fs'); const path = require('path');
const FILE = '203_seller_store_policies.sql';
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
      migration_202_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '202_taxpayer_id_minimization.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      table_exists: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'seller_policy_versions'`),
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
      const ok = p.migration_202_applied && !p.already_recorded && !p.table_exists && p.live_orders === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }
    const p = await pre();
    if (!p.migration_202_applied) { console.error('REFUSE: migration 202 must be applied first'); return 1; }
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
      versions_guard: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_seller_policy_versions_guard' AND NOT tgisinternal`),
      order_policy_guard: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_marketplace_orders_policy_guard' AND NOT tgisinternal`),
      order_policy_owner_check: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_marketplace_orders_policy_owner' AND NOT tgisinternal`),
      no_policies_yet: Number((await one('SELECT count(*)::int n FROM seller_policy_versions')).n) === 0,
      existing_orders_untouched: Number((await one('SELECT count(*)::int n FROM marketplace_orders WHERE policy_snapshot IS NOT NULL')).n) === 0,
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
