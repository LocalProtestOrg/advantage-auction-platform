#!/usr/bin/env node
/* prod-migrate-206.js — PRODUCTION-guarded apply of ONLY 206_sold_price_privacy_and_message_moderation.sql (per-item
   "show realized sale price to members" setting, default OFF; moderator hiding + recipient reports for item messages).
   Additive; moves no money; changes no existing value. Messaging stays OFF.

   --check  READ-ONLY: 205 applied, 206 not recorded, new columns absent.
   (none)   applies in one transaction, then verifies the objects, that every item's new setting is OFF, that no message
            is hidden, and that orders, items, seller profiles, outbox rows, payments, invoices, payouts and accounts are unchanged.
   Usage: railway run node scripts/prod-migrate-206.js [--check] */
const fs = require('fs'); const path = require('path');
const FILE = '206_sold_price_privacy_and_message_moderation.sql';
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
      migration_205_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '205_storefront_item_messaging.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      new_columns_present: Number((await one(`SELECT count(*)::int n FROM information_schema.columns WHERE (table_name = 'marketplace_items' AND column_name = 'show_realized_price_to_members')
        OR (table_name = 'storefront_messages' AND column_name IN ('hidden_at','hidden_by','hidden_reason'))`)).n),
      messages: Number((await one('SELECT count(*)::int n FROM storefront_messages')).n),
    });
    const snap = async () => ({
      orders: await h(`SELECT md5(coalesce(string_agg(row_to_json(o)::text, ',' ORDER BY id), '')) h FROM (SELECT id, seller_id, buyer_user_id, marketplace_item_id,
        item_price_cents, shipping_cents, total_charge_cents, payment_status, refund_status, fulfillment_status, payout_eligible, item_snapshot FROM marketplace_orders) o`),
      items: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || seller_id::text || ':' || status || ':' || price_cents || ':' || coalesce(inventory_number, '') || ':' || moderation_status, ',' ORDER BY id), '')) h FROM marketplace_items`),
      sellers: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(user_id::text,''), ',' ORDER BY id), '')) h FROM seller_profiles`),
      outbox: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(order_id::text, '') || ':' || status || ':' || attempts, ',' ORDER BY id), '')) h FROM storefront_notifications`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
        || ':' || (SELECT count(*) FROM users))::text) h`),
    });
    if (CHECK) {
      await c.query('BEGIN READ ONLY'); const p = await pre(); await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = p.migration_205_applied && !p.already_recorded && p.new_columns_present === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }
    const p = await pre();
    if (!p.migration_205_applied) { console.error('REFUSE: migration 205 must be applied first'); return 1; }
    const before = await snap();
    if (p.already_recorded) console.log('SKIP (already recorded).');
    else {
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '10s'`);
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED', FILE);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    }
    const after = await snap();
    const trig = (n) => has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`, [n]);
    const con = (n) => has(`SELECT 1 AS x FROM pg_constraint WHERE conname = $1`, [n]);
    const checks = {
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename=$1', [FILE]),
      price_setting_off_everywhere: Number((await one('SELECT count(*)::int n FROM marketplace_items WHERE show_realized_price_to_members')).n) === 0,
      hidden_columns: Number((await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'storefront_messages' AND column_name IN ('hidden_at','hidden_by','hidden_reason')`)).n) === 3,
      review_actions_rule: await con('storefront_message_reviews_action_check'),
      report_once_index: await has(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_storefront_message_report_once'`),
      messages_guard: await trig('trg_storefront_messages_guard'),
      no_message_hidden: Number((await one('SELECT count(*)::int n FROM storefront_messages WHERE hidden_at IS NOT NULL')).n) === 0,
      orders_unchanged: before.orders === after.orders,
      items_unchanged: before.items === after.items,
      seller_profiles_unchanged: before.sellers === after.sellers,
      outbox_rows_unchanged: before.outbox === after.outbox,
      payments_invoices_payouts_users_unchanged: before.money === after.money,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
