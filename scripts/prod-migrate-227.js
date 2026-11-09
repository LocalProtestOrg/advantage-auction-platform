#!/usr/bin/env node
/* prod-migrate-227.js - PRODUCTION-guarded apply of 227_storefront_tax_rule_seller_direct.sql: the storefront tax rule table
   (marketplace_tax_jurisdictions, migration 214) accepts a third answer, 'seller_direct' (no tax collected at checkout; the
   seller handles its own tax). Changes no row. Needed by the storefront sales tax safeguard (owner 2026-11-09), which must
   be able to record whichever configuration the CPA approves.

   --check    READ-ONLY: 214 applied (the table exists), 227 not recorded, every existing rule valid under the new check.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK.
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-227.js [--check | --dry-run]
   OWNER-GATED: do not run against production without the owner's approval. */
const fs = require('fs'); const path = require('path');
const FILE = '227_storefront_tax_rule_seller_direct.sql';
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
      migration_214_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '214_storefront_shipping_quantity_and_tax_responsibility.sql'`),
      rules_table_present: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'marketplace_tax_jurisdictions'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      rules_count: Number((await one(`SELECT count(*)::int n FROM marketplace_tax_jurisdictions`).catch(() => ({ n: -1 }))).n),
      invalid_rules: Number((await one(`SELECT count(*)::int n FROM marketplace_tax_jurisdictions WHERE remitter NOT IN ('platform','seller','seller_direct')`).catch(() => ({ n: -1 }))).n),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_214_applied && pre.rules_table_present && !pre.already_recorded && pre.invalid_rules === 0;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const verify = async () => ({
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      check_allows_seller_direct: await has(`SELECT 1 AS x FROM information_schema.check_constraints WHERE constraint_name = 'marketplace_tax_jurisdictions_remitter_check'
        AND check_clause LIKE '%seller_direct%'`),
      rules_unchanged: Number((await one(`SELECT count(*)::int n FROM marketplace_tax_jurisdictions`)).n) === pre.rules_count,
    });
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
