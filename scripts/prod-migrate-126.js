#!/usr/bin/env node
/* prod-migrate-126.js — PRODUCTION-guarded apply of ONLY 126_marketing_agency_foundation.sql.
   Additive foundation for the Autonomous Marketing Agency (no activation). Idempotent. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '126_marketing_agency_foundation.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name IN
       ('marketing_allocations','marketing_ledger','growth_pool','growth_pool_ledger','growth_monthly_authority',
        'growth_markets','marketing_campaigns','marketing_radius_exceptions','marketing_creative_assets',
        'marketing_creative_claims','marketing_creative_variants','marketing_qa_reviews','marketing_job_queue','marketing_agents')) AS tables,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='marketing_jobs'
       AND column_name IN ('package_price_cents','direct_max_cents','growth_allocation_cents','allocation_frozen_at','campaign_class')) AS job_cols,
    (SELECT count(*)::int FROM platform_config WHERE key LIKE 'marketing.%') AS mkt_keys,
    (SELECT count(*)::int FROM growth_markets) AS markets,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name IN ('marketing_ledger','growth_pool_ledger') AND column_name='seller_user_id') AS leaky_cols,
    (SELECT value::text FROM platform_config WHERE key='marketing.direct_spend_max_bps') AS direct_bps,
    (SELECT value::text FROM platform_config WHERE key='marketing.growth_monthly_additional_authority_cents') AS monthly_authority
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 126 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.tables === 14 && v.job_cols === 5 && v.mkt_keys >= 9 && v.markets >= 2
      && v.leaky_cols === 0 && v.direct_bps === '6000' && v.monthly_authority === '100000';
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
