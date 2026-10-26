#!/usr/bin/env node
/* prod-migrate-205.js — PRODUCTION-guarded apply of ONLY 205_storefront_item_messaging.sql (item questions: conversations,
   append-only messages, review history, support access log; message events on the storefront notification outbox).
   Additive; moves no money; changes no existing row. Messaging stays OFF (STOREFRONT_MESSAGING_ENABLED unset).

   --check  READ-ONLY: 204 applied, 205 not recorded, messaging tables absent, every existing outbox row is a sale notice
            with an order (so the new outbox rule holds for them).
   (none)   applies in one transaction, then verifies the objects, that the new tables are empty, and that orders, items,
            seller profiles, outbox rows, payments, invoices, payouts and accounts are unchanged.
   Usage: railway run node scripts/prod-migrate-205.js [--check] */
const fs = require('fs'); const path = require('path');
const FILE = '205_storefront_item_messaging.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const CHECK = process.argv.includes('--check');
const TABLES = ['storefront_conversations', 'storefront_messages', 'storefront_message_reviews', 'storefront_conversation_access_log'];
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
      migration_204_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '204_inventory_numbers_and_sale_notifications.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      messaging_tables_present: Number((await one(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name = ANY($1::text[])`, [TABLES])).n),
      outbox_rows: Number((await one('SELECT count(*)::int n FROM storefront_notifications')).n),
      outbox_rows_not_sale_with_order: Number((await one(`SELECT count(*)::int n FROM storefront_notifications WHERE event <> 'sale_paid' OR order_id IS NULL`)).n),
    });
    const snap = async () => ({
      orders: await h(`SELECT md5(coalesce(string_agg(row_to_json(o)::text, ',' ORDER BY id), '')) h FROM (SELECT id, seller_id, buyer_user_id, marketplace_item_id,
        item_price_cents, shipping_cents, total_charge_cents, payment_status, refund_status, fulfillment_status, payout_eligible, item_snapshot FROM marketplace_orders) o`),
      items: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || seller_id::text || ':' || status || ':' || price_cents || ':' || coalesce(inventory_number, ''), ',' ORDER BY id), '')) h FROM marketplace_items`),
      sellers: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(user_id::text,''), ',' ORDER BY id), '')) h FROM seller_profiles`),
      outbox: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(order_id::text, '') || ':' || status || ':' || attempts, ',' ORDER BY id), '')) h FROM storefront_notifications`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
        || ':' || (SELECT count(*) FROM users))::text) h`),
    });
    if (CHECK) {
      await c.query('BEGIN READ ONLY'); const p = await pre(); await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = p.migration_204_applied && !p.already_recorded && p.messaging_tables_present === 0 && p.outbox_rows_not_sale_with_order === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }
    const p = await pre();
    if (!p.migration_204_applied) { console.error('REFUSE: migration 204 must be applied first'); return 1; }
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
      conversation_item_seller_key: await con('fk_storefront_conversations_item_seller'),
      message_conversation_seller_key: await con('fk_storefront_messages_conversation_seller'),
      review_message_seller_key: await con('fk_storefront_message_reviews_message_seller'),
      outbox_message_seller_key: await con('fk_storefront_notifications_message_seller'),
      outbox_subject_rule: await con('storefront_notifications_subject_check'),
      guards: (await Promise.all(['trg_storefront_conversations_guard', 'trg_storefront_messages_guard', 'trg_storefront_message_reviews_guard',
        'trg_storefront_conversation_access_guard', 'trg_storefront_notifications_guard'].map(trig))).every(Boolean),
      new_tables_empty: (await Promise.all(TABLES.map(async (t) => Number((await one(`SELECT count(*)::int n FROM ${t}`)).n)))).every((n) => n === 0),
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
