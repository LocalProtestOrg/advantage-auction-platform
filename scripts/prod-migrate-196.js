#!/usr/bin/env node
/* prod-migrate-196.js — PRODUCTION-guarded apply of ONLY 196_sasha_staff_alerts.sql (new delivery-log table for staff
   notifications; additive). One transaction; verifies the table and its unique key exist and that platform settings,
   the staff inbox (conversations, messages, hand-offs), calls, payments, invoices and users are unchanged.
   Usage: railway run node scripts/prod-migrate-196.js */
const fs = require('fs'); const path = require('path');
const FILE = '196_sasha_staff_alerts.sql';
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
      config: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config`),
      inbox: await h(`SELECT md5(((SELECT count(*) FROM cs_conversations) || ':' || (SELECT count(*) FROM cs_messages) || ':' || (SELECT count(*) FROM cs_handoffs)
        || ':' || (SELECT count(*) FROM cs_calls))::text) h`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM users))::text) h`),
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
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'cs_staff_alerts'`)).rows.map((r) => r.column_name);
    const uniq = (await c.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'cs_staff_alerts' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%handoff_id, kind, channel, recipient%'`)).rowCount;
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      table_columns: ['handoff_id', 'kind', 'channel', 'recipient', 'status', 'attempts', 'provider_message_id', 'last_error', 'sent_at'].every((k) => cols.includes(k)),
      one_notice_per_message_key: uniq === 1,
      platform_config_unchanged: before.config === after.config,
      staff_inbox_unchanged: before.inbox === after.inbox,
      payments_invoices_users_unchanged: before.money === after.money,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
