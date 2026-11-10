#!/usr/bin/env node
/* prod-migrate-229.js - PRODUCTION-guarded apply of 229_seller_business_categories.sql: one new column
   (seller_profiles.business_categories, empty by default) and its CHECK of allowed values (owner 2026-11-10). Additive
   only: changes no existing row, and seller_type and its rules are untouched.

   --check    READ-ONLY: 228 applied, 229 not recorded, the column absent.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK.
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-229.js [--check | --dry-run]
   OWNER-GATED: do not run against production without the owner's approval. */
const fs = require('fs'); const path = require('path');
const FILE = '229_seller_business_categories.sql';
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
    // A fingerprint of every seller profile's classification: must be identical after the migration.
    const fingerprint = async () => (await one(`SELECT count(*)::int n, md5(string_agg(id::text || ':' || COALESCE(seller_type, '-'), ',' ORDER BY id)) h FROM seller_profiles`));
    const pre = {
      migration_228_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '228_owner_review_digest.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      column_absent: !(await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'seller_profiles' AND column_name = 'business_categories'`)),
      sellers: await fingerprint(),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_228_applied && !pre.already_recorded && pre.column_absent;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const verify = async () => {
      const after = await fingerprint();
      return {
        recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
        column_present: await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'seller_profiles' AND column_name = 'business_categories'`),
        check_present: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'seller_profiles_business_categories_check'`),
        every_row_empty: Number((await one(`SELECT count(*)::int n FROM seller_profiles WHERE business_categories <> '{}'::text[]`)).n) === 0,
        seller_types_unchanged: after.n === pre.sellers.n && after.h === pre.sellers.h,
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
