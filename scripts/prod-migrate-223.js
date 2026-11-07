#!/usr/bin/env node
/* prod-migrate-223.js — PRODUCTION-guarded apply of 223_paid_campaign_authorizations.sql: the empty
   marketing_paid_authorizations table, nullable authorization / purchase / auction / seller columns on
   marketing_paid_campaigns (NULL on every existing row), and the dedicated email setting name copy (normally a no-op).
   No historical campaign, ledger, purchase or payment row is changed.

   --check    READ-ONLY: 222 applied, 223 not recorded, the table and the columns absent.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-223.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILE = '223_paid_campaign_authorizations.sql';
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
    const campaignFingerprint = async () => (await one(
      `SELECT count(*)::int n, md5(COALESCE(string_agg(campaign_key || ':' || state || ':' || budget_cents || ':' || COALESCE(provider_campaign_id,''), ',' ORDER BY campaign_key), '')) f
         FROM marketing_paid_campaigns`));
    const ledgerFingerprint = async () => (await one(
      `SELECT count(*)::int n, COALESCE(sum(amount_cents),0)::bigint s FROM marketing_paid_budget_ledger`));
    const pre = {
      migration_222_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '222_platform_owner_and_config_audit.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      table_present: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'marketing_paid_authorizations'`),
      column_present: await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'marketing_paid_campaigns' AND column_name = 'authorization_id'`),
      campaigns: await campaignFingerprint(),
      ledger: await ledgerFingerprint(),
      purchases: Number((await one('SELECT count(*)::int n FROM marketing_package_purchases')).n),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_222_applied && !pre.already_recorded && !pre.table_present && !pre.column_present;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const verify = async () => {
      const camp = await campaignFingerprint(); const led = await ledgerFingerprint();
      return {
        recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
        authorizations_empty: Number((await one('SELECT count(*)::int n FROM marketing_paid_authorizations')).n) === 0,
        one_open_per_campaign_rule: await has(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_mpa_one_open_per_campaign'`),
        new_columns_null_on_every_campaign: Number((await one(`SELECT count(*)::int n FROM marketing_paid_campaigns
            WHERE authorization_id IS NOT NULL OR purchase_id IS NOT NULL OR auction_id IS NOT NULL OR seller_profile_id IS NOT NULL OR purchase_kind IS NOT NULL`)).n) === 0,
        campaigns_unchanged: camp.n === pre.campaigns.n && camp.f === pre.campaigns.f,
        ledger_unchanged: led.n === pre.ledger.n && String(led.s) === String(pre.ledger.s),
        purchases_unchanged: Number((await one('SELECT count(*)::int n FROM marketing_package_purchases')).n) === pre.purchases,
      };
    };
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
