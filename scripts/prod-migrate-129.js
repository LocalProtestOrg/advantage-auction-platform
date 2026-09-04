#!/usr/bin/env node
/* prod-migrate-129.js — PRODUCTION-guarded apply of ONLY 129_marketing_agency_phase4a.sql.
   Additive Phase 4A runtime (A1-A14, experiments, CTAs, social registry, deliverable evidence, QA severity,
   analytics/brand config, forward email copy). No external activation. Idempotent. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '129_marketing_agency_phase4a.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM marketing_agents WHERE code ~ '^A([1-9]|1[0-4])$') AS agents,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name IN
       ('marketing_experiments','marketing_ctas','marketing_social_channels','marketing_deliverable_evidence')) AS new_tables,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='marketing_qa_reviews'
       AND column_name IN ('severity','verdict','claim_manifest','disposition','producer_agent')) AS qa_cols,
    (SELECT count(*)::int FROM marketing_social_channels WHERE channel_key='advantage_bid_facebook' AND origin='pre_existing' AND lifecycle='authorization_required' AND agent_publish_enabled=false) AS fb_dormant,
    (SELECT count(*)::int FROM marketing_ctas WHERE route_verified=false) AS ctas_unverified,
    (SELECT count(*)::int FROM platform_config WHERE key='marketing.brand_language_version') AS brand_cfg,
    (SELECT count(*)::int FROM marketing_packages WHERE features::text LIKE '%10,000+ subscribers%') AS old_email_offering
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 129 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.agents === 14 && v.new_tables === 4 && v.qa_cols === 5
      && v.fb_dormant === 1 && v.ctas_unverified >= 5 && v.brand_cfg === 1 && v.old_email_offering === 0;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
