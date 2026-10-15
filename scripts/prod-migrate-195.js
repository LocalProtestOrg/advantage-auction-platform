#!/usr/bin/env node
/* prod-migrate-195.js — PRODUCTION-guarded apply of ONLY 195_users_email_case_insensitive_unique.sql (owner-approved 2026-10-15):
   unique index on lower(btrim(users.email)). The migration itself refuses if any case-variant duplicates exist. One
   transaction; verifies the index exists and that no account (id, email, role, status, password), payment, invoice,
   bid, auction or inbox record changed. Accounts are never merged or rewritten.
   Usage: railway run node scripts/prod-migrate-195.js */
const fs = require('fs'); const path = require('path');
const FILE = '195_users_email_case_insensitive_unique.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });   // direct endpoint, never the pooler
  await c.connect();
  try {
    const h = async (sql) => (await c.query(sql)).rows[0].h;
    const snap = async () => ({
      accounts: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(email,'') || ':' || coalesce(role,'') || ':' || coalesce(is_active::text,'') || ':' ||
        coalesce(staff_role,'') || ':' || coalesce(staff_active::text,'') || ':' || md5(coalesce(password_hash,'')), ',' ORDER BY id), '')) h FROM users`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM bids)
        || ':' || (SELECT count(*) FROM auctions) || ':' || (SELECT count(*) FROM cs_conversations) || ':' || (SELECT count(*) FROM cs_handoffs))::text) h`),
      config: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config`),
    });
    const before = await snap();
    if ((await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount) console.log('SKIP (already recorded).');
    else {
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED', FILE);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    }
    const after = await snap();
    const idx = (await c.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname = 'uq_users_email_ci'`)).rows[0];
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      unique_case_insensitive_index: !!idx && /UNIQUE/i.test(idx.indexdef) && /lower\(btrim\(email\)\)/i.test(idx.indexdef),
      accounts_unchanged: before.accounts === after.accounts,
      payments_invoices_bids_auctions_inbox_unchanged: before.money === after.money,
      platform_config_unchanged: before.config === after.config,
    };
    console.log('index:', idx ? idx.indexdef : '(missing)');
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
