#!/usr/bin/env node
/* prod-migrate-211-215.js — PRODUCTION-guarded apply of the storefront commerce migrations, in order, in ONE transaction:
     211_retail_gallery_studio_seller_type.sql  (widen two seller-type CHECKs; no row changes)
     212_marketplace_multi_quantity.sql         (stock columns, order quantity, stock history; replaces the one-live-order index)
     213_storefront_payouts.sql                 (storefront payout records; admin sale-notice event)
     214_storefront_shipping_quantity_and_tax_responsibility.sql
                                                (multi-unit shipping rule, per-state tax remitter rules (empty), order tax
                                                 remitter + Buyer Terms version, payout tax and refund recoveries)
     215_storefront_channel_commission.sql      (order sales channel + commission record, website-pass binding, actual
                                                 processing fee per order, storefront fee article text)
   Moves no money. Existing orders keep quantity 1; items already sold through a paid order are recorded as one unit sold
   with none left (212 backfill).

   --check    READ-ONLY: 210 applied, 211-215 not recorded, the new objects absent, and what the backfill will touch.
   --dry-run  applies all five inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies all five in one transaction, then verifies; any failure rolls everything back.
   Usage: railway run node scripts/prod-migrate-211-215.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILES = ['211_retail_gallery_studio_seller_type.sql', '212_marketplace_multi_quantity.sql', '213_storefront_payouts.sql',
  '214_storefront_shipping_quantity_and_tax_responsibility.sql', '215_storefront_channel_commission.sql'];
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
    const n = async (sql, p) => Number((await one(sql, p)).n);
    const pre = async () => ({
      migration_210_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '210_site_watchdog.sql'`),
      already_recorded: (await c.query('SELECT filename FROM schema_migrations WHERE filename = ANY($1)', [FILES])).rows.map((r) => r.filename),
      new_objects_present: await n(`SELECT ((SELECT count(*) FROM information_schema.tables WHERE table_name IN ('marketplace_stock_events','storefront_payouts','storefront_payout_lines','marketplace_tax_jurisdictions','storefront_payout_recoveries','storefront_channel_passes'))
        + (SELECT count(*) FROM information_schema.columns WHERE table_name = 'marketplace_orders' AND column_name IN ('unit_price_cents','hold_expires_at','stock_released_at','storefront_payout_id','tax_remitter','buyer_terms_version_id','sales_channel','processing_fee_cents')))::int n`),
      items: await n('SELECT count(*)::int n FROM marketplace_items'),
      orders: await n('SELECT count(*)::int n FROM marketplace_orders'),
      paid_orders_to_mark_sold: await n(`SELECT count(DISTINCT marketplace_item_id)::int n FROM marketplace_orders WHERE payment_status = 'paid' AND refund_status <> 'refunded'`),
      items_held_by_a_checkout: await n(`SELECT count(*)::int n FROM marketplace_items WHERE status = 'pending_purchase'`),
      seller_types: (await c.query(`SELECT seller_type, count(*)::int n FROM seller_profiles GROUP BY 1 ORDER BY 1`)).rows,
    });
    const snap = async () => (await one(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
      || ':' || (SELECT count(*) FROM users) || ':' || (SELECT count(*) FROM auctions) || ':' || (SELECT count(*) FROM lots) || ':' || (SELECT count(*) FROM bids)
      || ':' || (SELECT count(*) FROM seller_profiles) || ':' || (SELECT string_agg(seller_type, ',' ORDER BY id) FROM seller_profiles)
      || ':' || (SELECT count(*) FROM marketplace_orders) || ':' || (SELECT coalesce(string_agg(id::text || payment_status || total_charge_cents, ',' ORDER BY id), '') FROM marketplace_orders)
      || ':' || (SELECT coalesce(string_agg(id::text || status || coalesce(price_cents::text, '') || title, ',' ORDER BY id), '') FROM marketplace_items))::text) h`)).h;
    if (CHECK) {
      await c.query('BEGIN READ ONLY'); const p = await pre(); await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = p.migration_210_applied && p.already_recorded.length === 0 && p.new_objects_present === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }
    const p = await pre();
    if (!p.migration_210_applied) { console.error('REFUSE: migration 210 must be applied first'); return 1; }
    if (p.already_recorded.length) { console.error('REFUSE: already recorded: ' + p.already_recorded.join(', ')); return 1; }
    const before = await snap();
    const verify = async () => ({
      seller_type_accepts_retail: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'seller_profiles_seller_type_check' AND pg_get_constraintdef(oid) LIKE '%retail_gallery_studio%'`),
      agreement_type_accepts_retail: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'agreement_templates_agreement_type_check' AND pg_get_constraintdef(oid) LIKE '%retail_gallery_studio%'`),
      stock_columns: (await n(`SELECT count(*)::int n FROM information_schema.columns WHERE (table_name = 'marketplace_items' AND column_name = 'quantity_sold')
        OR (table_name = 'marketplace_orders' AND column_name IN ('quantity','unit_price_cents','hold_expires_at','stock_released_at'))`)) === 5,
      stock_history_append_only: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'marketplace_stock_events_append_only'`),
      order_quantity_fixed: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'marketplace_orders_qty_guard'`),
      one_live_order_index_removed: !(await has(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_marketplace_orders_live_item'`)),
      every_order_has_unit_price: (await n(`SELECT count(*)::int n FROM marketplace_orders WHERE unit_price_cents IS NULL OR item_price_cents <> unit_price_cents * quantity`)) === 0,
      payout_tables: (await n(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name IN ('storefront_payouts','storefront_payout_lines')`)) === 2,
      payouts_empty: (await n('SELECT (SELECT count(*) FROM storefront_payouts) + (SELECT count(*) FROM storefront_payout_lines) AS n')) === 0,
      admin_notice_event: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'storefront_notifications_event_check' AND pg_get_constraintdef(oid) LIKE '%sale_paid_admin%'`),
      shipping_quantity_rule_column: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'marketplace_items_shipping_quantity_rule_check'`),
      no_item_has_a_shipping_rule_yet: (await n(`SELECT count(*)::int n FROM marketplace_items WHERE shipping_quantity_rule IS NOT NULL`)) === 0,
      tax_rules_empty: (await n('SELECT count(*)::int n FROM marketplace_tax_jurisdictions')) === 0,
      order_tax_and_terms_columns: (await n(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'marketplace_orders'
        AND column_name IN ('tax_jurisdiction','tax_remitter','buyer_terms_version_id','buyer_terms_version_int')`)) === 4,
      payout_tax_and_recovery: (await n(`SELECT count(*)::int n FROM information_schema.columns WHERE (table_name = 'storefront_payout_lines' AND column_name = 'tax_to_seller_cents')
        OR (table_name = 'storefront_payouts' AND column_name = 'recovery_cents')`)) === 2
        && (await n('SELECT count(*)::int n FROM storefront_payout_recoveries')) === 0,
      order_channel_columns: (await n(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'marketplace_orders'
        AND column_name IN ('sales_channel','sales_channel_basis','channel_pass_id','channel_embedding_site','fee_schedule','processing_fee_cents')`)) === 6,
      channel_fixed_on_orders: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'marketplace_orders_channel_guard'`),
      channel_passes_empty: (await n('SELECT count(*)::int n FROM storefront_channel_passes')) === 0,
      fee_article_states_new_rates: !(await has(`SELECT 1 AS x FROM cs_kb_articles WHERE slug = 'professional-storefront-fee' AND body LIKE '%flat 11% seller fee, calculated on the item selling price only%'`)),
      no_negative_stock: (await n(`SELECT count(*)::int n FROM marketplace_items WHERE quantity < 0 OR quantity_sold < 0`)) === 0,
      records_unchanged: before === await snap(),
    });
    let checks;
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '10s'`);
      for (const f of FILES) {
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
      }
      checks = await verify();
      const failed = Object.keys(checks).filter((k) => !checks[k]);
      if (DRY || failed.length) { await c.query('ROLLBACK'); console.log(DRY ? 'DRY RUN: applied and verified inside a transaction, then rolled back.' : 'VERIFY FAILED: rolled back.'); }
      else { await c.query('COMMIT'); console.log('APPLIED', FILES.join(', ')); }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED (rolled back):', e.message); return 1; }
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(', ') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0), (e) => { console.error(e); process.exit(1); });
