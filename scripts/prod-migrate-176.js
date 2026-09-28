#!/usr/bin/env node
/* prod-migrate-176.js — PRODUCTION-guarded apply of ONLY 176_pre_launch_test_records.sql. Verifies: the auctions flag
   columns and seller_payouts void columns exist, the settlement status check allows 'void', NO auction is flagged and NO
   settlement is void (the migration marks nothing), and every payment's and seller payout's money + status is unchanged. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '176_pre_launch_test_records.sql';
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
      count: (await c.query('SELECT count(*)::int n FROM payments')).rows[0].n,
      money: (await c.query(
        `SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || coalesce(amount_cents, -1) || ':'
                || coalesce(payment_intent_id, ''), ',' ORDER BY id), '')) h FROM payments`)).rows[0].h,
      payouts: (await c.query(
        `SELECT md5(coalesce(string_agg(id::text || ':' || settlement_status || ':' || coalesce(payout_status, '') || ':'
                || coalesce(seller_payout_cents, -1) || ':' || coalesce(final_amount_paid_cents, -1), ',' ORDER BY id), '')) h FROM seller_payouts`)).rows[0].h,
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
        console.log('APPLIED 176.');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const col = async (t, n) => (await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, n])).rowCount === 1;
    const checkDef = ((await c.query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='chk_seller_payouts_settlement_status'`)).rows[0] || {}).d || '';
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      auctions_flag_cols: (await col('auctions', 'pre_launch_test')) && (await col('auctions', 'pre_launch_test_reason'))
        && (await col('auctions', 'pre_launch_test_marked_at')) && (await col('auctions', 'pre_launch_test_marked_by')),
      payout_void_cols: (await col('seller_payouts', 'void_reason')) && (await col('seller_payouts', 'voided_at')) && (await col('seller_payouts', 'voided_by_user_id')),
      status_check_allows_void: /'void'/.test(checkDef) && /'on_hold'/.test(checkDef),
      nothing_flagged: (await c.query('SELECT count(*)::int n FROM auctions WHERE pre_launch_test')).rows[0].n === 0,
      nothing_voided: (await c.query(`SELECT count(*)::int n FROM seller_payouts WHERE settlement_status = 'void'`)).rows[0].n === 0,
      row_count_unchanged: before.count === after.count,
      payment_money_unchanged: before.money === after.money,
      payout_money_unchanged: before.payouts === after.payouts,
    };
    console.log('Payments before:', before.count, 'after:', after.count);
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
