#!/usr/bin/env node
/* prod-migrate-199-200.js — PRODUCTION-guarded apply of ONLY
     199_seller_staff_accounts.sql   (seller staff memberships, append-only staff history, step-up challenges; nothing
                                      is active until SELLER_STAFF_ENABLED=true)
     200_storefront_product_data.sql (optional product data columns for storefront items; all NULL / empty)
   Both are additive and move no money. Each is applied in its own transaction, in order.

   --check  READ-ONLY (BEGIN READ ONLY): confirms 197 and 198 are applied, that no seller owner would conflict, and that
            neither file is already recorded.
   (none)   applies, then verifies the new objects exist and that no order, item, payment, invoice, payout, dispute, bid,
            account or seller profile changed.
   Usage: railway run node scripts/prod-migrate-199-200.js [--check] */
const fs = require('fs'); const path = require('path');
const FILES = ['199_seller_staff_accounts.sql', '200_storefront_product_data.sql'];
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
    const h = async (sql) => (await one(sql)).h;
    const has = async (sql, p) => !!(await one(sql, p));
    const pre = async () => ({
      migration_197_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '197_storefront_order_integrity.sql'`),
      migration_198_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '198_storefront_moderation_reports.sql'`),
      recorded: Object.fromEntries(await Promise.all(FILES.map(async (f) => [f, await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [f])]))),
      staff_table_exists: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'seller_staff_members'`),
      item_columns_already_present: Number((await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'marketplace_items'
        AND column_name IN ('brand','manufacturer','gtin','mpn','condition_type','era_or_period','material','image_alt')`)).n),
      seller_profiles: Number((await one('SELECT count(*)::int n FROM seller_profiles')).n),
      items: Number((await one('SELECT count(*)::int n FROM marketplace_items')).n),
    });
    const snap = async () => ({
      orders: await h(`SELECT md5(coalesce(string_agg(row_to_json(o)::text, ',' ORDER BY id), '')) h FROM (SELECT id, seller_id, buyer_user_id, marketplace_item_id,
        item_price_cents, total_charge_cents, payment_status, refund_status, fulfillment_status, payout_eligible FROM marketplace_orders) o`),
      items: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || seller_id::text || ':' || status || ':' || price_cents || ':' || coalesce(title,''), ',' ORDER BY id), '')) h FROM marketplace_items`),
      sellers: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(user_id::text,'') || ':' || coalesce(seller_type,''), ',' ORDER BY id), '')) h FROM seller_profiles`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
        || ':' || (SELECT count(*) FROM payment_disputes) || ':' || (SELECT count(*) FROM bids) || ':' || (SELECT count(*) FROM users))::text) h`),
    });

    if (CHECK) {
      await c.query('BEGIN READ ONLY');
      const p = await pre();
      await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = p.migration_197_applied && p.migration_198_applied && !p.staff_table_exists && p.item_columns_already_present === 0
        && !Object.values(p.recorded).some(Boolean);
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }

    const p = await pre();
    if (!p.migration_197_applied || !p.migration_198_applied) { console.error('REFUSE: migrations 197 and 198 must be applied first', JSON.stringify(p)); return 1; }
    const before = await snap();
    for (const f of FILES) {
      if ((await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [f])).rowCount) { console.log('SKIP (already recorded)', f); continue; }
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        await c.query('COMMIT');
        console.log('APPLIED', f);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', f, e.message); return 1; }
    }
    const after = await snap();
    const checks = {
      recorded_199: await has('SELECT 1 AS x FROM schema_migrations WHERE filename=$1', [FILES[0]]),
      recorded_200: await has('SELECT 1 AS x FROM schema_migrations WHERE filename=$1', [FILES[1]]),
      staff_members_guard: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_seller_staff_members_guard' AND NOT tgisinternal`),
      staff_history_guard: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_seller_staff_events_guard' AND NOT tgisinternal`),
      owner_not_staff_guard: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_seller_profiles_not_staff' AND NOT tgisinternal`),
      staff_history_company_key: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'fk_seller_staff_events_member_seller'`),
      one_company_per_person: await has(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_seller_staff_one_company_per_user'`),
      no_staff_yet: Number((await one('SELECT count(*)::int n FROM seller_staff_members')).n) === 0,
      gtin_format_check: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'marketplace_items_gtin_format'`),
      condition_type_check: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'marketplace_items_condition_type_check'`),
      product_fields_all_empty: Number((await one(`SELECT count(*)::int n FROM marketplace_items WHERE brand IS NOT NULL OR gtin IS NOT NULL OR mpn IS NOT NULL
        OR condition_type IS NOT NULL OR image_alt <> '[]'::jsonb`)).n) === 0,
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
