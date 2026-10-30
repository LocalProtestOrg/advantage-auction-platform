#!/usr/bin/env node
/* prod-migrate-210.js — PRODUCTION-guarded apply of ONLY 210_site_watchdog.sql (site watchdog: runs, findings, check
   state). Additive: three new tables; no existing table or row changes; moves no money.

   --check    READ-ONLY: 208 applied, 210 not recorded, the three tables absent.
   --dry-run  applies inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies in one transaction, then verifies the tables and that payments, invoices, payouts, orders, users,
              auctions, lots, bids, marketplace items and events are unchanged.
   Usage: railway run node scripts/prod-migrate-210.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILE = '210_site_watchdog.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const TABLES = ['watchdog_runs', 'watchdog_findings', 'watchdog_check_state'];
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
    const pre = async () => ({
      migration_208_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '208_event_discovery.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      new_tables_present: Number((await one(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name = ANY($1)`, [TABLES])).n),
    });
    const snap = async () => (await one(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
      || ':' || (SELECT count(*) FROM marketplace_orders) || ':' || (SELECT count(*) FROM users) || ':' || (SELECT count(*) FROM auctions) || ':' || (SELECT count(*) FROM lots)
      || ':' || (SELECT count(*) FROM bids) || ':' || (SELECT count(*) FROM marketplace_items) || ':' || (SELECT count(*) FROM events))::text) h`)).h;
    if (CHECK) {
      await c.query('BEGIN READ ONLY'); const p = await pre(); await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = p.migration_208_applied && !p.already_recorded && p.new_tables_present === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }
    const p = await pre();
    if (!p.migration_208_applied) { console.error('REFUSE: migration 208 must be applied first'); return 1; }
    const before = await snap();
    const verify = async () => ({
      tables: Number((await one(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name = ANY($1)`, [TABLES])).n) === 3,
      dedupe_key_unique: await has(`SELECT 1 AS x FROM pg_indexes WHERE tablename = 'watchdog_findings' AND indexdef ILIKE '%UNIQUE%dedupe_key%'`),
      empty: Number((await one(`SELECT (SELECT count(*) FROM watchdog_runs) + (SELECT count(*) FROM watchdog_findings) + (SELECT count(*) FROM watchdog_check_state) AS n`)).n) === 0,
      platform_records_unchanged: before === await snap(),
    });
    let checks;
    if (p.already_recorded && !DRY) { console.log('SKIP (already recorded).'); checks = await verify(); }
    else {
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '10s'`);
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        checks = await verify();
        if (DRY) { await c.query('ROLLBACK'); console.log('DRY RUN: applied and verified inside a transaction, then rolled back.'); }
        else { await c.query('COMMIT'); console.log('APPLIED', FILE); }
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    }
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(', ') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0), (e) => { console.error(e); process.exit(1); });
