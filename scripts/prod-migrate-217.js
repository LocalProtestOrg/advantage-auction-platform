#!/usr/bin/env node
/* prod-migrate-217.js — PRODUCTION-guarded apply of 217_storefront_commission_adjustments.sql (Storefront Fee corrections,
   Seller Agreement §6.9 version 4): a new, empty, append-only table and storefront_payouts.adjustment_cents (default 0).
   Moves no money and changes no existing row.

   --check    READ-ONLY: 216 applied, 217 not recorded, the new objects absent.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-217.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILE = '217_storefront_commission_adjustments.sql';
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
    const pre = {
      migration_216_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '216_storefront_agreement_terms_and_refund_fault.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      table_present: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'storefront_commission_adjustments'`),
      payout_column_present: await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'storefront_payouts' AND column_name = 'adjustment_cents'`),
      storefront_payouts: Number((await one('SELECT count(*)::int n FROM storefront_payouts')).n),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_216_applied && !pre.already_recorded && !pre.table_present && !pre.payout_column_present;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const payoutSnap = async () => JSON.stringify((await c.query('SELECT id, seller_payout_cents, settlement_status FROM storefront_payouts ORDER BY id')).rows);
    const before = await payoutSnap();
    const verify = async () => ({
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      table_empty: Number((await one('SELECT count(*)::int n FROM storefront_commission_adjustments')).n) === 0,
      append_only_trigger: await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_storefront_commission_adjustments_append_only'`),
      amount_rule: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'storefront_commission_adjustments_amount_matches'`),
      payout_column_default_zero: Number((await one('SELECT count(*)::int n FROM storefront_payouts WHERE adjustment_cents <> 0')).n) === 0,
      payouts_unchanged: before === await payoutSnap(),
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
