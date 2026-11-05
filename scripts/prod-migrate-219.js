#!/usr/bin/env node
/* prod-migrate-219.js - PRODUCTION-guarded apply of 219_shipment_fulfillment_and_delivery.sql (auction shipping Phase 3
   scaffolding + storefront delivery confirmation): two new, empty tables (auction_shipments, auction_shipment_lots) with
   their integrity triggers, and three new NULL columns on marketplace_orders (delivered_at, delivery_confirmed_by,
   delivery_confirmation_source) with a trigger that keeps a recorded delivery as recorded. Additive only: changes no
   existing row's behavior. Nothing reads the new objects unless AUCTION_SHIPPING_ENABLED=true or
   STOREFRONT_SHIPPED_PAYOUT_DELAY_ENABLED=true.

   --check    READ-ONLY: 218 applied, 219 not recorded, the new objects absent.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-219.js [--check | --dry-run]
   OWNER-GATED: do not run against production without the owner's approval. */
const fs = require('fs'); const path = require('path');
const FILE = '219_shipment_fulfillment_and_delivery.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry-run');
const ORDER_COLS = ['delivered_at', 'delivery_confirmed_by', 'delivery_confirmation_source'];
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
    const colCount = async (table, cols) => Number((await one(`SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name = $1 AND column_name = ANY($2::text[])`, [table, cols])).n);
    const pre = {
      migration_218_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '218_auction_shipping_phase1.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      tables_present: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name IN ('auction_shipments', 'auction_shipment_lots')`),
      order_columns_present: await colCount('marketplace_orders', ORDER_COLS),
      orders: Number((await one('SELECT count(*)::int n FROM marketplace_orders')).n),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_218_applied && !pre.already_recorded && !pre.tables_present && pre.order_columns_present === 0;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const orderSnap = async () => JSON.stringify((await c.query(`SELECT count(*)::int n, count(*) FILTER (WHERE payout_eligible)::int eligible,
      count(*) FILTER (WHERE fulfillment_status = 'completed')::int completed FROM marketplace_orders`)).rows);
    const before = await orderSnap();
    const verify = async () => ({
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      shipments_table_empty: Number((await one('SELECT count(*)::int n FROM auction_shipments')).n) === 0,
      shipment_lots_table_empty: Number((await one('SELECT count(*)::int n FROM auction_shipment_lots')).n) === 0,
      order_columns: (await colCount('marketplace_orders', ORDER_COLS)) === ORDER_COLS.length,
      no_order_delivered: Number((await one('SELECT count(*)::int n FROM marketplace_orders WHERE delivered_at IS NOT NULL')).n) === 0,
      shipment_guard_trigger: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_auction_shipments_guard'`),
      shipment_lots_guard_trigger: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_auction_shipment_lots_guard'`),
      order_delivery_guard_trigger: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_marketplace_orders_delivery_guard'`),
      orders_unchanged: before === await orderSnap(),
    });
    let checks;
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '10s'`);
      await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
      await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
      checks = await verify();
      const failed = Object.keys(checks).filter((k) => !checks[k]);
      if (DRY || failed.length) { await c.query('ROLLBACK'); console.log(DRY ? 'DRY RUN: applied and verified inside a transaction, then rolled back.' : 'VERIFY FAILED: rolled back.'); }
      else { await c.query('COMMIT'); console.log('APPLIED', FILE); }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED (rolled back):', e.message); return 1; }
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(', ') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0), (e) => { console.error(e); process.exit(1); });
