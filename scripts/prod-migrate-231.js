#!/usr/bin/env node
/* prod-migrate-231.js - PRODUCTION-guarded apply of 231_central_tax_management.sql (centralized sales tax management,
   owner authorization 2026-11-16). ADDITIVE ONLY: new tax_* tables, nullable columns on marketplace_tax_jurisdictions,
   payments and marketplace_orders, and two platform_config keys. It changes no existing row.

   --check    READ-ONLY: 230 applied, 231 not recorded, none of the new tables present.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK.
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-231.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILE = '231_central_tax_management.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry-run');
const TABLES = ['tax_jurisdiction_history', 'tax_registrations', 'tax_filings', 'tax_ledger_entries', 'tax_category_codes', 'tax_nexus_thresholds',
  'tax_payment_exceptions', 'tax_alerts', 'tax_reconciliation_runs'];
const COLUMNS = [['marketplace_tax_jurisdictions', 'source_reference'], ['marketplace_tax_jurisdictions', 'local_jurisdiction'],
  ['marketplace_tax_jurisdictions', 'last_verified_at'], ['marketplace_tax_jurisdictions', 'last_verified_by'],
  ['payments', 'tax_remitter'], ['payments', 'tax_jurisdiction'], ['payments', 'tax_basis'], ['payments', 'tax_detail'],
  ['marketplace_orders', 'tax_basis'], ['marketplace_orders', 'tax_detail']];
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
    const tablePresent = (t) => has(`SELECT 1 AS x FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [t]);
    const columnPresent = (t, col) => has(`SELECT 1 AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [t, col]);
    // Existing money records must be identical afterwards (counts and totals).
    const fingerprint = async () => one(
      `SELECT (SELECT count(*)::int FROM payments) AS payments, (SELECT COALESCE(sum(amount_cents), 0)::bigint FROM payments) AS payment_cents,
              (SELECT count(*)::int FROM marketplace_orders) AS orders, (SELECT COALESCE(sum(total_charge_cents), 0)::bigint FROM marketplace_orders) AS order_cents,
              (SELECT count(*)::int FROM marketplace_tax_jurisdictions) AS rules, (SELECT count(*)::int FROM platform_config) AS config_keys`);
    const present = {}; for (const t of TABLES) present[t] = await tablePresent(t);
    const pre = {
      migration_230_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '230_seller_inquiry_item.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      new_tables_absent: Object.values(present).every((v) => !v),
      before: await fingerprint(),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_230_applied && !pre.already_recorded && pre.new_tables_absent;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const verify = async () => {
      const after = await fingerprint();
      const out = { recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]) };
      for (const t of TABLES) out['table_' + t] = await tablePresent(t);
      for (const [t, col] of COLUMNS) out[`column_${t}.${col}`] = await columnPresent(t, col);
      out.ledger_empty = Number((await one('SELECT count(*)::int n FROM tax_ledger_entries')).n) === 0;
      out.append_only_trigger = await has(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'trg_tax_ledger_append_only'`);
      out.enforcement_setting_report = (await one(`SELECT value FROM platform_config WHERE key = 'tax.auction_enforcement'`)).value === 'report';
      out.reserve_guard_on = (await one(`SELECT value FROM platform_config WHERE key = 'tax.reserve_guard'`)).value === true;
      out.no_rule_created = Number(after.rules) === Number(pre.before.rules);
      out.no_registration_created = Number((await one('SELECT count(*)::int n FROM tax_registrations')).n) === 0;
      out.no_threshold_created = Number((await one('SELECT count(*)::int n FROM tax_nexus_thresholds')).n) === 0;
      out.payments_unchanged = Number(after.payments) === Number(pre.before.payments) && String(after.payment_cents) === String(pre.before.payment_cents);
      out.orders_unchanged = Number(after.orders) === Number(pre.before.orders) && String(after.order_cents) === String(pre.before.order_cents);
      out.only_two_config_keys_added = Number(after.config_keys) === Number(pre.before.config_keys) + 2;
      return out;
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
