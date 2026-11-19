#!/usr/bin/env node
/* prod-migrate-232.js - PRODUCTION-guarded apply of 232_item_unavailable_history.sql (historical item pages after a refund,
   owner approval 2026-11-19). ADDITIVE: one nullable column on marketplace_items, one trigger that only ever clears that
   column, and a one-time mark on items a full refund already took off sale and that have not been touched since.
   It changes no status, price, quantity, order or money record, and puts nothing back on sale.

   --check    READ-ONLY: 231 applied, 232 not recorded, column absent; lists the items the backfill would mark.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK.
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-232.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILE = '232_item_unavailable_history.sql';
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
    const columnPresent = () => has(`SELECT 1 AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'marketplace_items' AND column_name = 'unavailable_since'`);
    // Everything that must be identical afterwards: item statuses, prices and stock, and every order's money.
    const fingerprint = async () => one(
      `SELECT (SELECT count(*)::int FROM marketplace_items) AS items,
              (SELECT md5(COALESCE(string_agg(id::text || status || moderation_status || COALESCE(price_cents::text, '') || quantity::text || quantity_sold::text, ',' ORDER BY id), '')) FROM marketplace_items) AS item_state,
              (SELECT count(*)::int FROM marketplace_orders) AS orders,
              (SELECT COALESCE(sum(total_charge_cents), 0)::bigint FROM marketplace_orders) AS order_cents,
              (SELECT md5(COALESCE(string_agg(id::text || payment_status || refund_status, ',' ORDER BY id), '')) FROM marketplace_orders) AS order_state`);
    const candidates = async () => (await c.query(
      `SELECT mi.id, mi.title FROM marketplace_items mi JOIN marketplace_orders o ON o.marketplace_item_id = mi.id
        WHERE o.refund_status = 'refunded' AND o.refunded_at IS NOT NULL AND mi.status = 'removed' AND mi.moderation_status = 'none'
          AND mi.updated_at = o.refunded_at
          AND NOT EXISTS (SELECT 1 FROM marketplace_orders p WHERE p.marketplace_item_id = mi.id AND p.payment_status = 'paid')`)).rows;
    const expected = await candidates();
    const pre = {
      migration_231_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '231_central_tax_management.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      column_absent: !(await columnPresent()),
      items_the_backfill_marks: expected,
      before: await fingerprint(),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_231_applied && !pre.already_recorded && pre.column_absent;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const verify = async () => {
      const after = await fingerprint();
      const marked = (await c.query(`SELECT id FROM marketplace_items WHERE unavailable_since IS NOT NULL ORDER BY id`)).rows.map((r) => r.id);
      return {
        recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
        column_present: await columnPresent(),
        trigger_present: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_marketplace_items_unavailable_since'`),
        marked_exactly_the_expected_items: JSON.stringify(marked) === JSON.stringify(expected.map((r) => r.id).sort()),
        marked_items_are_removed_and_not_taken_down: !(await has(`SELECT 1 AS x FROM marketplace_items WHERE unavailable_since IS NOT NULL AND (status <> 'removed' OR moderation_status <> 'none')`)),
        nothing_put_back_on_sale: after.item_state === pre.before.item_state && Number(after.items) === Number(pre.before.items),
        orders_unchanged: Number(after.orders) === Number(pre.before.orders) && String(after.order_cents) === String(pre.before.order_cents) && after.order_state === pre.before.order_state,
      };
    };
    let checks;
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '10s'`);
      const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8').replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
      await c.query(sql);
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
