#!/usr/bin/env node
/* prod-migrate-135.js — PRODUCTION-guarded apply of ONLY 135_director_bridge_consent_onsite_4g.sql.
   Additive: consent ledger, consent-at-write column, click-id capture, opportunities/decisions/onsite
   treatment tables, config. NOTHING connects Google/Meta, activates A7, sends, spends, or imports a list.
   Only onsite is enabled (gated). Idempotent, non-destructive. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '135_director_bridge_consent_onsite_4g.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='analytics_events' AND column_name='consent_state') AS consent_col,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name IN
       ('consent_records','marketing_click_ids','marketing_opportunities','marketing_decisions','marketing_onsite_treatments')) AS new_tables,
    (SELECT count(*)::int FROM platform_config WHERE key IN
       ('marketing.onsite.enabled','marketing.consent.policy_version','marketing.consent.required_for_advertising',
        'marketing.click_ids.retention_days','marketing.onsite.max_per_pageview')) AS cfg,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.onsite.enabled') AS onsite_on,
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 135 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.consent_col === 1 && v.new_tables === 5 && v.cfg === 5
      && v.onsite_on === true && v.google_on === false && v.meta_on === false && v.a7_on === false;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
