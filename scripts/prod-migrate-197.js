#!/usr/bin/env node
/* prod-migrate-197.js — PRODUCTION-guarded apply of ONLY 197_storefront_order_integrity.sql (storefront ownership and
   order integrity: composite seller keys, fixed purchase snapshot, forward-only states, append-only order history, buyer
   issues, chargeback links). Moves no money and changes no existing value.

   --check  READ-ONLY: reports whether every existing order already satisfies the new rules (BEGIN READ ONLY on the direct
            endpoint; nothing is written).
   (none)   applies the migration in one transaction, then verifies the constraints/triggers exist and that no order, item,
            payment, invoice, payout, dispute or account changed.
   Usage: railway run node scripts/prod-migrate-197.js [--check] */
const fs = require('fs'); const path = require('path');
const FILE = '197_storefront_order_integrity.sql';
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
    const pre = async () => ({
      orders: Number((await one('SELECT count(*)::int n FROM marketplace_orders')).n),
      orders_seller_mismatch: Number((await one(`SELECT count(*)::int n FROM marketplace_orders o JOIN marketplace_items mi ON mi.id = o.marketplace_item_id
        WHERE mi.seller_id <> o.seller_id`)).n),
      orders_self_purchase: Number((await one(`SELECT count(*)::int n FROM marketplace_orders o JOIN seller_profiles sp ON sp.id = o.seller_id
        WHERE sp.user_id = o.buyer_user_id`)).n),
      duplicate_item_seller_pairs: Number((await one('SELECT count(*)::int n FROM (SELECT id, seller_id FROM marketplace_items GROUP BY 1, 2 HAVING count(*) > 1) x')).n),
      items: Number((await one('SELECT count(*)::int n FROM marketplace_items')).n),
      disputes: Number((await one('SELECT count(*)::int n FROM payment_disputes')).n),
    });
    const snap = async () => ({
      orders: await h(`SELECT md5(coalesce(string_agg(row_to_json(o)::text, ',' ORDER BY id), '')) h FROM (SELECT id, seller_id, buyer_user_id, marketplace_item_id,
        item_price_cents, total_charge_cents, payment_status, refund_status, fulfillment_status, payout_eligible FROM marketplace_orders) o`),
      items: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || seller_id::text || ':' || status || ':' || price_cents, ',' ORDER BY id), '')) h FROM marketplace_items`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
        || ':' || (SELECT count(*) FROM payment_disputes) || ':' || (SELECT count(*) FROM bids) || ':' || (SELECT count(*) FROM users))::text) h`),
    });

    if (CHECK) {
      await c.query('BEGIN READ ONLY');
      const p = await pre();
      const recorded = !!(await one('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]));
      await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify({ ...p, already_recorded: recorded }, null, 2));
      const ok = p.orders_seller_mismatch === 0 && p.orders_self_purchase === 0 && p.duplicate_item_seller_pairs === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (existing data would violate the new rules)'));
      return ok ? 0 : 1;
    }

    const p = await pre();
    if (p.orders_seller_mismatch || p.orders_self_purchase || p.duplicate_item_seller_pairs) {
      console.error('REFUSE: existing data would violate the new rules', JSON.stringify(p)); return 1;
    }
    const before = await snap();
    if ((await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount) console.log('SKIP (already recorded).');
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
    const has = async (sql, p2) => !!(await one(sql, p2));
    const checks = {
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename=$1', [FILE]),
      fk_order_item_seller: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'fk_marketplace_orders_item_seller'`),
      fk_dispute_order_seller: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'fk_payment_disputes_marketplace_order'`),
      order_guard_trigger: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_marketplace_orders_guard' AND NOT tgisinternal`),
      events_guard_trigger: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_marketplace_order_events_guard' AND NOT tgisinternal`),
      issues_guard_trigger: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_marketplace_order_issues_guard' AND NOT tgisinternal`),
      orders_unchanged: before.orders === after.orders,
      items_unchanged: before.items === after.items,
      payments_invoices_payouts_disputes_bids_users_unchanged: before.money === after.money,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
