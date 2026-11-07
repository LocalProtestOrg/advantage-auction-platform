#!/usr/bin/env node
/* prod-migrate-222.js — PRODUCTION-guarded apply of 222_platform_owner_and_config_audit.sql: users.is_platform_owner
   (default false, nobody designated), the platform_setting_audit table, and the owner.notify_emails setting (inserted only
   when absent). Changes no existing row other than adding the column with its default.

   --check    READ-ONLY: 221 applied, 222 not recorded, the column and the table absent.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   After applying, designate the owner: railway run node scripts/prod-set-platform-owner.js --email=<owner email> --apply
   Usage: railway run node scripts/prod-migrate-222.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILE = '222_platform_owner_and_config_audit.sql';
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
      migration_221_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '221_seller_welcome_emails.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      column_present: await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_platform_owner'`),
      table_present: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'platform_setting_audit'`),
      notify_key_present: await has(`SELECT 1 AS x FROM platform_config WHERE key = 'owner.notify_emails'`),
      users: Number((await one('SELECT count(*)::int n FROM users')).n),
      platform_config_rows: Number((await one('SELECT count(*)::int n FROM platform_config')).n),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_221_applied && !pre.already_recorded && !pre.column_present && !pre.table_present;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const verify = async () => ({
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      column_default_false: await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_platform_owner'
                                        AND is_nullable = 'NO' AND column_default = 'false'`),
      nobody_designated: Number((await one('SELECT count(*)::int n FROM users WHERE is_platform_owner')).n) === 0,
      audit_table_empty: Number((await one('SELECT count(*)::int n FROM platform_setting_audit')).n) === 0,
      notify_key_is_list: await has(`SELECT 1 AS x FROM platform_config WHERE key = 'owner.notify_emails' AND jsonb_typeof(value) = 'array'`),
      users_unchanged: Number((await one('SELECT count(*)::int n FROM users')).n) === pre.users,
      only_notify_key_added: Number((await one('SELECT count(*)::int n FROM platform_config')).n) === pre.platform_config_rows + (pre.notify_key_present ? 0 : 1),
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
