#!/usr/bin/env node
/* prod-migrate-209.js — PRODUCTION-guarded apply of ONLY 209_marketplace_inventory_importer.sql (simple marketplace
   importer: Sale Price optional on drafts, quantity, dimensions, color, automatic categories, saved column mappings,
   staged import photos, Post to the Market references). Additive; moves no money; changes no existing row's values
   (existing items keep every value and get the defaults: quantity 1, category not yet assigned).

   --check    READ-ONLY: 208 applied, 209 not recorded, new objects absent, every item that can be seen or bought is
              priced (the new database rule would otherwise refuse the migration).
   --dry-run  applies inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies in one transaction, then verifies the objects and that items, orders, payments, invoices,
              payouts, bids and users are unchanged.
   Usage: railway run node scripts/prod-migrate-209.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILE = '209_marketplace_inventory_importer.sql';
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
      migration_208_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '208_event_discovery.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      new_objects_present: Number((await one(`SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('storefront_import_mappings','storefront_import_photos'))
        + (SELECT count(*) FROM information_schema.columns WHERE table_name = 'marketplace_items' AND column_name IN ('quantity','dimensions','color','category_key','category_source','source_lot_number')) AS n`)).n),
      prerequisites: Number((await one(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name IN ('marketplace_items','storefront_import_batches','storefront_item_photos','seller_profiles','users')`)).n),
      items: Number((await one('SELECT count(*)::int n FROM marketplace_items')).n),
      visible_items_without_price: Number((await one(`SELECT count(*)::int n FROM marketplace_items WHERE status NOT IN ('draft','removed') AND (price_cents IS NULL OR price_cents <= 0)`)).n),
      photo_sources_outside_rule: Number((await one(`SELECT count(*)::int n FROM storefront_item_photos WHERE source NOT IN ('upload','zip','url','auction')`)).n),
    });
    const snap = async () => ({
      items: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || coalesce(price_cents::text,'') || ':' || title || ':' || coalesce(category,'') || ':' || coalesce(inventory_number,'') || ':' || images::text, ',' ORDER BY id), '')) h FROM marketplace_items`),
      photos: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || url, ',' ORDER BY id), '')) h FROM storefront_item_photos`),
      batches: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || created_count, ',' ORDER BY id), '')) h FROM storefront_import_batches`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
        || ':' || (SELECT count(*) FROM marketplace_orders) || ':' || (SELECT count(*) FROM bids) || ':' || (SELECT count(*) FROM users))::text) h`),
    });
    if (CHECK) {
      await c.query('BEGIN READ ONLY'); const p = await pre(); await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = p.migration_208_applied && !p.already_recorded && p.new_objects_present === 0 && p.prerequisites === 5 && p.visible_items_without_price === 0 && p.photo_sources_outside_rule === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }
    const p = await pre();
    if (!p.migration_208_applied) { console.error('REFUSE: migration 208 must be applied first'); return 1; }
    if (p.visible_items_without_price || p.photo_sources_outside_rule) { console.error('REFUSE: existing rows would violate the new rules'); return 1; }
    const before = await snap();
    const verify = async () => {
      const after = await snap();
      const col = async (name) => has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'marketplace_items' AND column_name = $1`, [name]);
      return {
        price_optional_for_drafts: (await one(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'marketplace_items' AND column_name = 'price_cents'`)).is_nullable === 'YES',
        priced_when_visible_rule: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'marketplace_items_priced_when_visible'`),
        quantity_column: await col('quantity'), dimensions_column: await col('dimensions'), color_column: await col('color'),
        category_columns: (await col('category_key')) && (await col('category_source')) && (await col('category_confidence')) && (await col('category_status')),
        source_lot_number_column: await col('source_lot_number'),
        mappings_table: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'storefront_import_mappings'`),
        import_photos_table: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'storefront_import_photos'`),
        existing_items_quantity_one: Number((await one('SELECT count(*)::int n FROM marketplace_items WHERE quantity <> 1')).n) === 0,
        items_unchanged: before.items === after.items,
        item_photos_unchanged: before.photos === after.photos,
        import_batches_unchanged: before.batches === after.batches,
        payments_invoices_payouts_orders_bids_users_unchanged: before.money === after.money,
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
