#!/usr/bin/env node
/* prod-migrate-132.js — PRODUCTION-guarded apply of ONLY 132_subscriber_geo_network_4d.sql.
   Additive first-party subscriber geography + permission audit + email-radius/subscribe config.
   Nothing here sends email, imports lists, or activates A7/SMS. Idempotent, non-destructive. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '132_subscriber_geo_network_4d.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='marketing_contacts'
       AND column_name IN ('latitude','longitude','geography_precision','geography_source','geo_resolved_at')) AS geo_cols,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='marketing_contact_sources'
       AND column_name IN ('signup_placement','referrer','source_domain')) AS src_cols,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name='marketing_contact_permission_events') AS perm_tbl,
    (SELECT count(*)::int FROM platform_config WHERE key IN
       ('marketing.email.radius_default_miles','marketing.email.radius_allowed','marketing.subscribe.enabled','marketing.subscribe.double_optin_enabled')) AS cfg,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.a7_send_enabled') AS a7_enabled,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.subscribe.enabled') AS subscribe_enabled
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 132 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.geo_cols === 5 && v.src_cols === 3 && v.perm_tbl === 1
      && v.cfg === 4 && v.a7_enabled === false && v.subscribe_enabled === true;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
