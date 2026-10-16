#!/usr/bin/env node
/* prod-migrate-201.js — PRODUCTION-guarded apply of ONLY 201_storefront_shipping_controls.sql (storefront shipping
   controls: item shipping terms, store-wide default OFF, database rule that shipping needs complete terms). Additive;
   moves no money; changes no existing row.

   --check  READ-ONLY (BEGIN READ ONLY): confirms 200 is applied and 201 is not, and reports how many existing listings are
            marked shippable without complete terms (after 201 they stay listed and pickup works, but shipping checkout is
            refused until the seller completes the terms — checkout is OFF in any case).
   (none)   applies in one transaction, then verifies the new objects and that no order, item, seller profile, payment,
            invoice, payout, dispute, bid or account changed.
   Usage: railway run node scripts/prod-migrate-201.js [--check] */
const fs = require('fs'); const path = require('path');
const FILE = '201_storefront_shipping_controls.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const CHECK = process.argv.includes('--check');

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });   // direct endpoint, never the pooler
  await c.connect();
  try {
    const one = async (sql, p) => (await c.query(sql, p || [])).rows[0];
    const has = async (sql, p) => !!(await one(sql, p));
    const h = async (sql) => (await one(sql)).h;
    const pre = async () => ({
      migration_200_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '200_storefront_product_data.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      items: Number((await one('SELECT count(*)::int n FROM marketplace_items')).n),
      shippable_items: Number((await one('SELECT count(*)::int n FROM marketplace_items WHERE shippable')).n),
      shippable_without_price: Number((await one('SELECT count(*)::int n FROM marketplace_items WHERE shippable AND COALESCE(shipping_cost_cents, 0) = 0')).n),
      live_orders: Number((await one(`SELECT count(*)::int n FROM marketplace_orders WHERE payment_status IN ('pending','processing')`)).n),
    });
    const snap = async () => ({
      orders: await h(`SELECT md5(coalesce(string_agg(row_to_json(o)::text, ',' ORDER BY id), '')) h FROM (SELECT id, seller_id, buyer_user_id, marketplace_item_id,
        item_price_cents, shipping_cents, total_charge_cents, payment_status, refund_status, fulfillment_status, payout_eligible, item_snapshot FROM marketplace_orders) o`),
      items: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || seller_id::text || ':' || status || ':' || price_cents || ':' || shippable || ':' || coalesce(shipping_cost_cents::text,''), ',' ORDER BY id), '')) h FROM marketplace_items`),
      sellers: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(user_id::text,'') || ':' || coalesce(seller_type,''), ',' ORDER BY id), '')) h FROM seller_profiles`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
        || ':' || (SELECT count(*) FROM payment_disputes) || ':' || (SELECT count(*) FROM bids) || ':' || (SELECT count(*) FROM users))::text) h`),
    });

    if (CHECK) {
      await c.query('BEGIN READ ONLY');
      const p = await pre();
      await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = p.migration_200_applied && !p.already_recorded;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }

    const p = await pre();
    if (!p.migration_200_applied) { console.error('REFUSE: migration 200 must be applied first'); return 1; }
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
      shipping_terms_guard: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_marketplace_items_shipping_terms' AND NOT tgisinternal`),
      method_check: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'marketplace_items_shipping_method_check'`),
      destinations_check: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'marketplace_items_shipping_destinations_check'`),
      store_defaults_all_off: Number((await one(`SELECT count(*)::int n FROM seller_profiles WHERE shipping_defaults->>'enabled' <> 'false'`)).n) === 0,
      new_item_fields_empty: Number((await one(`SELECT count(*)::int n FROM marketplace_items WHERE shipping_method IS NOT NULL OR shipping_price_mode IS NOT NULL
        OR shipping_destinations IS NOT NULL OR handling_days IS NOT NULL OR is_oversized OR is_fragile`)).n) === 0,
      orders_unchanged: before.orders === after.orders,
      items_unchanged: before.items === after.items,
      seller_profiles_unchanged: before.sellers === after.sellers,
      payments_invoices_payouts_disputes_bids_users_unchanged: before.money === after.money,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
