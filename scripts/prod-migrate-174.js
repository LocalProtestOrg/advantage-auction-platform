#!/usr/bin/env node
/* prod-migrate-174.js — PRODUCTION-guarded apply of ONLY 174_marketplace_checkout_hardening.sql (storefront checkout
   hardening). Verifies: the widened refund_status check, the three new marketplace_orders columns and both indexes
   exist; marketplace_orders / marketplace_items row counts and every order's money + status snapshot are unchanged
   (the migration is additive and moves no money). */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '174_marketplace_checkout_hardening.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const snap = async () => ({
      counts: (await c.query(
        `SELECT (SELECT count(*)::int FROM marketplace_orders) orders, (SELECT count(*)::int FROM marketplace_items) items`)).rows[0],
      money: (await c.query(
        `SELECT md5(coalesce(string_agg(id::text || ':' || payment_status || ':' || refund_status || ':' || total_charge_cents || ':'
                || platform_fee_cents || ':' || seller_proceeds_cents || ':' || refunded_amount_cents || ':' || payout_eligible, ',' ORDER BY id), '')) h
           FROM marketplace_orders`)).rows[0].h,
    });
    const before = await snap();
    const done = (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
    if (done) console.log('SKIP apply (already recorded). Verifying only.');
    else {
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(FILE_PATH, 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 174.');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const col = async (name) => (await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='marketplace_orders' AND column_name=$1`, [name])).rowCount === 1;
    const idx = async (name) => (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname=$1`, [name])).rowCount === 1;
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      refund_status_check_widened: /partially_refunded/.test(((await c.query(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='marketplace_orders_refund_status_check'`)).rows[0] || {}).d || ''),
      col_refund_reason: await col('refund_reason'),
      col_review_required: await col('review_required'),
      col_review_note: await col('review_note'),
      idx_review: await idx('idx_marketplace_orders_review'),
      idx_pending_expiry: await idx('idx_marketplace_items_pending_expiry'),
      row_counts_unchanged: JSON.stringify(before.counts) === JSON.stringify(after.counts),
      order_money_unchanged: before.money === after.money,
    };
    console.log('Counts before:', JSON.stringify(before.counts), 'after:', JSON.stringify(after.counts));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
