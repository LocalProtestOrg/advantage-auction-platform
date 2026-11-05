#!/usr/bin/env node
/* prod-migrate-221.js — PRODUCTION-guarded apply of 221_seller_welcome_emails.sql (Professional Seller welcome email
   outbox): one new, empty table. Changes no existing table or row, and does not depend on 218, 219 or 220 (PR #86).

   --check    READ-ONLY: 217 applied, 221 not recorded, the table absent.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-221.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILE = '221_seller_welcome_emails.sql';
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
      migration_217_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '217_storefront_commission_adjustments.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      table_present: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'seller_welcome_emails'`),
      seller_profiles: Number((await one('SELECT count(*)::int n FROM seller_profiles')).n),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_217_applied && !pre.already_recorded && !pre.table_present;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const verify = async () => ({
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      table_empty: Number((await one('SELECT count(*)::int n FROM seller_welcome_emails')).n) === 0,
      once_per_seller_rule: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'uq_seller_welcome_email_once'`),
      seller_profiles_unchanged: Number((await one('SELECT count(*)::int n FROM seller_profiles')).n) === pre.seller_profiles,
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
