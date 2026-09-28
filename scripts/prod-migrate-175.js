#!/usr/bin/env node
/* prod-migrate-175.js — PRODUCTION-guarded apply of ONLY 175_payments_sales_tax_cents.sql. Verifies: the column exists
   as INTEGER NOT NULL DEFAULT 0; payments row count and every payment's money + status snapshot are unchanged (the
   migration is additive and moves no money). */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '175_payments_sales_tax_cents.sql';
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
        console.log('APPLIED 175.');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const col = (await c.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name='payments' AND column_name='sales_tax_cents'`)).rows[0] || {};
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      col_integer: col.data_type === 'integer',
      col_not_null: col.is_nullable === 'NO',
      col_default_0: String(col.column_default) === '0',
      row_count_unchanged: before.count === after.count,
      payment_money_unchanged: before.money === after.money,
    };
    console.log('Payments before:', before.count, 'after:', after.count);
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
