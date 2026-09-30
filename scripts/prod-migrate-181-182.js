#!/usr/bin/env node
/* prod-migrate-181-182.js — PRODUCTION-guarded apply of ONLY 181_paid_campaign_terminal_states.sql and
   182_sasha_claimed_listing_guidance.sql, in order, each in its own transaction. Verifies:
     181: the state CHECK allows COMPLETED and BUDGET_EXHAUSTED and every existing state; no campaign row changed.
     182: exactly one claimed-listing-help guidance row exists and it is DRAFT; no other guidance row changed.
   Also proves no platform_config value changed. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILES = ['181_paid_campaign_terminal_states.sql', '182_sasha_claimed_listing_guidance.sql'];
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const snap = async () => ({
      config: (await c.query(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config`)).rows[0].h,
      campaigns: (await c.query(`SELECT md5(coalesce(string_agg(campaign_key || ':' || state || ':' || coalesce(stopped_at::text,''), ',' ORDER BY campaign_key), '')) h FROM marketing_paid_campaigns`)).rows[0].h,
      other_kb: (await c.query(`SELECT md5(coalesce(string_agg(slug || ':' || status || ':' || version, ',' ORDER BY slug), '')) h FROM cs_kb_articles WHERE slug <> 'claimed-listing-help'`)).rows[0].h,
    });
    const before = await snap();
    for (const f of FILES) {
      if ((await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [f])).rowCount) { console.log('SKIP (already recorded):', f); continue; }
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        await c.query('COMMIT');
        console.log('APPLIED', f);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', f, e.message); return 1; }
    }
    const after = await snap();
    const def = ((await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'chk_mpcam_state'`)).rows[0] || {}).d || '';
    const kb = (await c.query(`SELECT status FROM cs_kb_articles WHERE slug = 'claimed-listing-help'`)).rows;
    const recorded = (await c.query(`SELECT filename FROM schema_migrations WHERE filename = ANY($1)`, [FILES])).rows.length;
    const checks = {
      both_recorded: recorded === 2,
      state_check_widened: ['PLANNED', 'CREATIVE_BLOCKED', 'READY', 'ACTIVE', 'PAUSED', 'STOPPED', 'FAILED', 'COMPLETED', 'BUDGET_EXHAUSTED'].every((s) => def.includes(`'${s}'`)),
      no_campaign_changed: before.campaigns === after.campaigns,
      guidance_is_one_draft: kb.length === 1 && kb[0].status === 'draft',
      other_guidance_unchanged: before.other_kb === after.other_kb,
      platform_config_unchanged: before.config === after.config,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
