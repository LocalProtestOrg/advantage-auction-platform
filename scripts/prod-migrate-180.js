#!/usr/bin/env node
/* prod-migrate-180.js — PRODUCTION-guarded apply of ONLY 180_sasha_customer_service.sql. Verifies: the cs_* tables exist; every
   Sasha switch is present and OFF on first apply; the inbound programme check now allows company_inbox while still allowing the
   existing programmes; existing inbound receipts, outreach switches and platform_config values outside sasha.* are unchanged. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '180_sasha_customer_service.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const snap = async () => ({
      config: (await c.query(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config WHERE key NOT LIKE 'sasha.%'`)).rows[0].h,
      receipts: (await c.query(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(programme,'') || ':' || status, ',' ORDER BY id), '')) h FROM inbound_email_receipts`)).rows[0].h,
    });
    const before = await snap();
    const done = (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
    if (done) console.log('SKIP apply (already recorded). Verifying only.');
    else {
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(FILE_PATH, 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 180.');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const tables = (await c.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'
      AND table_name IN ('cs_conversations','cs_messages','cs_ai_runs','cs_handoffs','cs_kb_articles')`)).rows[0].n;
    const sw = (await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'sasha.%' ORDER BY key`)).rows;
    const def = ((await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='inbound_email_receipts_programme_check'`)).rows[0] || {}).d || '';
    const kb = (await c.query(`SELECT status, count(*)::int n FROM cs_kb_articles GROUP BY 1 ORDER BY 1`)).rows;
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      five_tables: tables === 5,
      seven_settings: sw.length === 7,
      switches_off_on_first_apply: done || sw.filter((r) => r.key !== 'sasha.daily_budget_usd').every((r) => r.value === false),
      programme_check_ok: ['claimed_listing', 'event_partner', 'unmatched', 'company_inbox'].every((p) => def.includes(`'${p}'`)),
      other_config_unchanged: before.config === after.config,
      inbound_receipts_unchanged: before.receipts === after.receipts,
    };
    console.log('Settings:', JSON.stringify(sw.map((r) => r.key + '=' + JSON.stringify(r.value))));
    console.log('Guidance:', JSON.stringify(kb));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
