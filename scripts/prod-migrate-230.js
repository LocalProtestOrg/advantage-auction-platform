#!/usr/bin/env node
/* prod-migrate-230.js - PRODUCTION-guarded apply of 230_seller_inquiry_item.sql: one nullable column
   (seller_inquiries.marketplace_item_id) and an index, so an item page's Contact Seller records which item a question is
   about (owner 2026-11-10). Additive only: changes no existing row.

   --check    READ-ONLY: 229 applied, 230 not recorded, the column absent.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK.
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-230.js [--check | --dry-run]
   OWNER-GATED: do not run against production without the owner's approval. */
const fs = require('fs'); const path = require('path');
const FILE = '230_seller_inquiry_item.sql';
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
    // Every existing inquiry must be identical afterwards.
    const fingerprint = async () => (await one(`SELECT count(*)::int n, md5(COALESCE(string_agg(id::text || ':' || seller_id::text || ':' || status, ',' ORDER BY id), '')) h FROM seller_inquiries`));
    const pre = {
      migration_229_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '229_seller_business_categories.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      column_absent: !(await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'seller_inquiries' AND column_name = 'marketplace_item_id'`)),
      inquiries: await fingerprint(),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_229_applied && !pre.already_recorded && pre.column_absent;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const verify = async () => {
      const after = await fingerprint();
      return {
        recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
        column_present: await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'seller_inquiries' AND column_name = 'marketplace_item_id'`),
        index_present: await has(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'idx_seller_inquiries_item'`),
        every_row_unlinked: Number((await one(`SELECT count(*)::int n FROM seller_inquiries WHERE marketplace_item_id IS NOT NULL`)).n) === 0,
        inquiries_unchanged: after.n === pre.inquiries.n && after.h === pre.inquiries.h,
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
