#!/usr/bin/env node
/* prod-migrate-220.js - PRODUCTION-guarded apply of 220_account_verification_codes.sql: one new, empty table
   (account_verification_codes) for the one-time codes emailed to an account without a password of its own when it changes
   its payout destination. Additive only: changes no existing row's behavior.

   NOTE: once this branch is deployed, a seller account without a usable password (directory sign-in bridge, or no
   password hash) cannot replace an existing payout destination until this migration is applied (the code cannot be sent).
   That fails closed; it never lets the change through unverified.

   --check    READ-ONLY: production is at the baseline (226 applied), the users table it references exists, 220 not
              recorded, the new table absent. 220 does NOT depend on 218 or 219 (auction shipping, PR #86): its only
              reference is users(id). Those two are reported for information and are never required (corrected 2026-11-09;
              the runner first required 219, a leftover from PR #86's ordering, and refused the storefront release).
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-220.js [--check | --dry-run]
   OWNER-GATED: do not run against production without the owner's approval. */
const fs = require('fs'); const path = require('path');
const FILE = '220_account_verification_codes.sql';
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
    const colCount = async (table, cols) => Number((await one(`SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name = $1 AND column_name = ANY($2::text[])`, [table, cols])).n);
    const pre = {
      baseline_226_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '226_remove_obsolete_pricing_config.sql'`),
      users_table_present: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'users'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      table_present: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'account_verification_codes'`),
      // information only: auction shipping is not part of this release and is never required
      info_218_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '218_auction_shipping_phase1.sql'`),
      info_219_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '219_shipment_fulfillment_and_delivery.sql'`),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.baseline_226_applied && pre.users_table_present && !pre.already_recorded && !pre.table_present;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const verify = async () => ({
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      table_empty: Number((await one('SELECT count(*)::int n FROM account_verification_codes')).n) === 0,
      purpose_rule: await has(`SELECT 1 AS x FROM information_schema.check_constraints WHERE check_clause LIKE '%payout_destination_change%'`),
      user_index: await has(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'idx_account_verification_codes_user'`),
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
