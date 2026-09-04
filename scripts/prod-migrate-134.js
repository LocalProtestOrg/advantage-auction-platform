#!/usr/bin/env node
/* prod-migrate-134.js — PRODUCTION-guarded apply of ONLY 134_behavioral_intelligence_4f.sql.
   Additive first-party behavioral intelligence: analytics_events identity/intent columns, identity links,
   derived signals, audience membership, destination sync ledger, config. NOTHING connects Google/Meta,
   activates A7, sends, or imports a list. Idempotent, non-destructive. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '134_behavioral_intelligence_4f.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='analytics_events'
       AND column_name IN ('visitor_id','page_intent','category_key')) AS ae_cols,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name IN
       ('behavioral_identity_links','marketing_signals','marketing_audience_members','marketing_audience_destinations')) AS new_tables,
    (SELECT count(*)::int FROM platform_config WHERE key IN
       ('marketing.behavioral.enabled','marketing.behavioral.signal_ttl_days','marketing.behavioral.raw_retention_days',
        'marketing.destinations.google_ads_enabled','marketing.destinations.meta_enabled')) AS cfg,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.destinations.google_ads_enabled') AS google_on,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.destinations.meta_enabled') AS meta_on,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.a7_send_enabled') AS a7_on
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 134 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.ae_cols === 3 && v.new_tables === 4 && v.cfg === 5
      && v.google_on === false && v.meta_on === false && v.a7_on === false;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
