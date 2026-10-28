#!/usr/bin/env node
/* prod-migrate-207.js — PRODUCTION-guarded apply of ONLY 207_storefront_bulk_import.sql (Professional Seller bulk import with
   photographs; "paused" item status). Additive; moves no money; changes no existing value (no item is paused or marked as
   imported; every existing inventory number stays reserved).

   --check    READ-ONLY: 206 applied, 207 not recorded, new objects absent, and no live inventory-number duplicates that the
              rebuilt unique index would refuse.
   --dry-run  applies inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies in one transaction, then verifies the objects and that orders, items, seller profiles, payments,
              invoices, payouts and accounts are unchanged.
   Usage: railway run node scripts/prod-migrate-207.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILE = '207_storefront_bulk_import.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry-run');
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
      migration_206_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '206_sold_price_privacy_and_message_moderation.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      new_objects_present: Number((await one(`SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('storefront_import_batches','storefront_item_photos'))
        + (SELECT count(*) FROM information_schema.columns WHERE table_name = 'marketplace_items' AND column_name IN ('import_batch_id','import_row')) AS n`)).n),
      // The rebuilt inventory-number index covers the same statuses as before (plus the new 'paused'), so this must be 0.
      live_inventory_number_duplicates: Number((await one(`SELECT count(*)::int n FROM (SELECT seller_id, lower(inventory_number) FROM marketplace_items
        WHERE inventory_number IS NOT NULL AND status IN ('draft','active','pending_purchase') GROUP BY 1, 2 HAVING count(*) > 1) d`)).n),
      items: Number((await one('SELECT count(*)::int n FROM marketplace_items')).n),
    });
    const snap = async () => ({
      orders: await h(`SELECT md5(coalesce(string_agg(row_to_json(o)::text, ',' ORDER BY id), '')) h FROM (SELECT id, seller_id, buyer_user_id, marketplace_item_id,
        item_price_cents, shipping_cents, total_charge_cents, payment_status, refund_status, fulfillment_status, payout_eligible, item_snapshot FROM marketplace_orders) o`),
      items: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || seller_id::text || ':' || status || ':' || price_cents || ':' || coalesce(inventory_number, '') || ':'
        || moderation_status || ':' || images::text, ',' ORDER BY id), '')) h FROM marketplace_items`),
      sellers: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(user_id::text,'') || ':' || coalesce(seller_type, ''), ',' ORDER BY id), '')) h FROM seller_profiles`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
        || ':' || (SELECT count(*) FROM users))::text) h`),
    });
    if (CHECK) {
      await c.query('BEGIN READ ONLY'); const p = await pre(); await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = p.migration_206_applied && !p.already_recorded && p.new_objects_present === 0 && p.live_inventory_number_duplicates === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }
    const p = await pre();
    if (!p.migration_206_applied) { console.error('REFUSE: migration 206 must be applied first'); return 1; }
    if (p.live_inventory_number_duplicates) { console.error('REFUSE: duplicate live inventory numbers exist; the index rebuild would fail'); return 1; }
    const before = await snap();
    const con = (n) => has(`SELECT 1 AS x FROM pg_constraint WHERE conname = $1`, [n]);
    const idx = (n) => has(`SELECT 1 AS x FROM pg_indexes WHERE indexname = $1`, [n]);
    const verify = async () => {
      const statusRule = (await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'marketplace_items_status_check'`) || {}).d || '';
      const skuIndex = (await one(`SELECT indexdef d FROM pg_indexes WHERE indexname = 'uq_marketplace_items_seller_inventory_number'`) || {}).d || '';
      const after = await snap();
      return {
        status_rule_has_paused: /'paused'/.test(statusRule) && /'pending_purchase'/.test(statusRule),
        sku_index_covers_paused: /'paused'/.test(skuIndex) && /'draft'/.test(skuIndex) && /'pending_purchase'/.test(skuIndex),
        import_batches_table: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'storefront_import_batches'`),
        item_photos_table: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'storefront_item_photos'`),
        import_row_index: await idx('uq_marketplace_items_import_row'),
        photo_unique: await con('storefront_item_photos_item_id_sha256_key'),
        no_item_paused_or_imported: Number((await one(`SELECT count(*)::int n FROM marketplace_items WHERE status = 'paused' OR import_batch_id IS NOT NULL`)).n) === 0,
        orders_unchanged: before.orders === after.orders,
        items_unchanged: before.items === after.items,
        seller_profiles_unchanged: before.sellers === after.sellers,
        payments_invoices_payouts_users_unchanged: before.money === after.money,
      };
    };
    let checks;
    if (p.already_recorded && !DRY) { console.log('SKIP (already recorded).'); checks = await verify(); }
    else {
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '10s'`);
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        checks = await verify();
        if (DRY) { await c.query('ROLLBACK'); console.log('DRY RUN: applied and verified inside a transaction, then rolled back.'); }
        else { await c.query('COMMIT'); console.log('APPLIED', FILE); }
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    }
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(', ') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0), (e) => { console.error(e); process.exit(1); });
