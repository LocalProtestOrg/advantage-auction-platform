#!/usr/bin/env node
/* prod-migrate-146.js — PRODUCTION-guarded apply of ONLY 146_social_intelligence.sql.
   Additive: social job linkage/polling columns, metric + account snapshots, engagement events, webhook events,
   PAID-vs-ORGANIC Meta gate split (meta_ads_enabled=false), insights/draft switches (false), Owner-supplied
   NON-secret national Page/IG IDs (active stays FALSE). NOTHING publishes/replies/spends/flips a publishing gate. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '146_social_intelligence.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name IN ('marketing_social_metric_snapshots','marketing_social_account_snapshots','marketing_social_engagement_events','marketing_social_webhook_events')) AS tbls,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='marketing_social_jobs' AND column_name IN ('platform','destination_id','next_insights_poll_at','insights_status','creative_job_id','copy_style')) AS cols,
    (SELECT count(*)::int FROM marketing_social_destinations WHERE scope='national' AND provider_account_id IS NOT NULL) AS national_ids,
    (SELECT count(*)::int FROM marketing_social_destinations WHERE active=true) AS active_dests,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.a9_publish_enabled') AS a9_on,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.destinations.meta_enabled') AS meta_on,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.destinations.meta_ads_enabled') AS meta_ads_on,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.destinations.google_ads_enabled') AS google_on,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.social.insights_enabled') AS insights_on,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.social.reply_draft_enabled') AS draft_on,
    (SELECT count(*)::int FROM marketing_social_jobs WHERE status='published' AND shadow=false) AS real_posts
`)).rows[0];
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP)) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes(PROD_EP)) { console.error('REFUSE: not the PRODUCTION endpoint (' + PROD_EP + ').'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    if (await ledgerHas(c)) { console.log('SKIP apply (already recorded; idempotent). Verifying only.'); }
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 146 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.tbls === 4 && v.cols === 6 && v.national_ids === 2 && v.active_dests === 0 && v.a9_on === false && v.meta_on === false
      && v.meta_ads_on === false && v.google_on === false && v.insights_on === false && v.draft_on === false && v.real_posts === 0;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
