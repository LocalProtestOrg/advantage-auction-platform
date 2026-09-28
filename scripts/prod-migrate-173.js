#!/usr/bin/env node
/* prod-migrate-173.js — PRODUCTION-guarded apply of ONLY 173_payment_mode_isolation_disputes.sql.
   Verifies: the new mode columns exist; every existing provider reference is stamped TEST (false) and none
   is stamped LIVE; the dispute and tax-reversal tables (and their unique indexes) exist and are empty; the
   stored customer / card / connected-account / bank ids and the payment, payout and card row counts are
   byte-for-byte unchanged (a digest of each id set is compared before and after). */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '173_payment_mode_isolation_disputes.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const snap = async () => (await c.query(
      `SELECT (SELECT count(*)::int FROM users) users,
              (SELECT count(*)::int FROM card_verifications) card_verifications,
              (SELECT count(*)::int FROM seller_payout_preferences) payout_prefs,
              (SELECT count(*)::int FROM payments) payments,
              (SELECT count(*)::int FROM seller_payouts) seller_payouts,
              (SELECT md5(coalesce(string_agg(id::text || ':' || stripe_customer_id, ',' ORDER BY id), '')) FROM users WHERE stripe_customer_id IS NOT NULL) customer_ids,
              (SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(stripe_payment_method_id, '') || ':' || coalesce(status, ''), ',' ORDER BY id), '')) FROM card_verifications) card_rows,
              (SELECT md5(coalesce(string_agg(seller_user_id::text || ':' || coalesce(stripe_account_id, '') || ':' || coalesce(stripe_bank_account_ref, ''), ',' ORDER BY seller_user_id), '')) FROM seller_payout_preferences) payout_refs,
              (SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || amount_cents, ',' ORDER BY id), '')) FROM payments) payment_rows,
              (SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(settlement_status, ''), ',' ORDER BY id), '')) FROM seller_payouts) payout_rows`)).rows[0];
    const before = await snap();
    const done = (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
    if (done) console.log('SKIP apply (already recorded). Verifying only.');
    else {
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(FILE_PATH, 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 173.');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const col = async (t, n) => (await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t, n])).rowCount === 1;
    const one = async (sql) => (await c.query(sql)).rows[0];
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      users_mode_column: await col('users', 'stripe_customer_livemode'),
      users_superseded_column: await col('users', 'superseded_stripe_customer_id'),
      cards_mode_column: await col('card_verifications', 'livemode'),
      prefs_account_mode_column: await col('seller_payout_preferences', 'stripe_account_livemode'),
      prefs_bank_mode_column: await col('seller_payout_preferences', 'stripe_bank_account_livemode'),
      prefs_superseded_column: await col('seller_payout_preferences', 'superseded_stripe_account_id'),
      customers_all_stamped_test: (await one(`SELECT count(*)::int n FROM users WHERE stripe_customer_id IS NOT NULL AND stripe_customer_livemode IS DISTINCT FROM false`)).n === 0,
      cards_none_live: (await one(`SELECT count(*)::int n FROM card_verifications WHERE livemode`)).n === 0,
      accounts_all_stamped_test: (await one(`SELECT count(*)::int n FROM seller_payout_preferences WHERE stripe_account_id IS NOT NULL AND stripe_account_livemode IS DISTINCT FROM false`)).n === 0,
      banks_all_stamped_test: (await one(`SELECT count(*)::int n FROM seller_payout_preferences WHERE stripe_bank_account_ref IS NOT NULL AND stripe_bank_account_livemode IS DISTINCT FROM false`)).n === 0,
      disputes_table_empty: !!(await one(`SELECT to_regclass('public.payment_disputes') t`)).t && (await one(`SELECT count(*)::int n FROM payment_disputes`)).n === 0,
      disputes_unique_index: (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname='uq_payment_disputes_stripe_dispute'`)).rowCount === 1,
      tax_reversals_table_empty: !!(await one(`SELECT to_regclass('public.payment_tax_reversals') t`)).t && (await one(`SELECT count(*)::int n FROM payment_tax_reversals`)).n === 0,
      tax_reversals_unique_indexes: (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname IN ('uq_payment_tax_reversals_level','uq_payment_tax_reversals_reference')`)).rowCount === 2,
      no_rows_or_ids_changed: JSON.stringify(before) === JSON.stringify(after),
    };
    console.log('Counts before:', JSON.stringify({ ...before }), '\nafter: ', JSON.stringify({ ...after }));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
