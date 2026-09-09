#!/usr/bin/env node
/* prod-migrate-145.js — PRODUCTION-guarded apply of ONLY 145_social_destinations.sql.
   Additive: marketing_social_destinations registry (+ national FB/IG seeds, INACTIVE) + widen
   marketing_social_jobs status CHECK to allow 'published'. NOTHING publishes/spends/flips a gate. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '145_social_destinations.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name='marketing_social_destinations') AS tbl,
    (SELECT count(*)::int FROM marketing_social_destinations WHERE scope='national') AS national_seeds,
    (SELECT count(*)::int FROM marketing_social_destinations WHERE active=true) AS active_dests,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.a9_publish_enabled') AS a9_on,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.destinations.meta_enabled') AS meta_on
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 145 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.tbl === 1 && v.national_seeds === 2 && v.active_dests === 0 && v.a9_on === false && v.meta_on === false;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
