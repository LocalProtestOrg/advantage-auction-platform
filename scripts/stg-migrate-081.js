#!/usr/bin/env node
/* stg-migrate-081.js — STAGING-guarded apply of ONLY 081_crm_foundation.sql.
 *   railway run --service advantage-staging node scripts/stg-migrate-081.js */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '081_crm_foundation.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT (SELECT to_regclass('public.organization_activity') IS NOT NULL AND to_regclass('public.organization_reps') IS NOT NULL) AS tables_ok,
         (SELECT count(*) FROM information_schema.columns WHERE table_name='organizations'
            AND column_name IN ('crm_stage','next_action_at','last_contacted_at','health_score','health_computed_at'))::int AS cols
`)).rows[0];
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint. STAGING-only.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not the STAGING endpoint (${STG_EP}).`); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    if (await ledgerHas(c)) { console.log('SKIP apply (already recorded; idempotent). Verifying only.'); }
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 081 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.tables_ok === true && v.cols === 5;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
