#!/usr/bin/env node
/* prod-migrate-082.js — PRODUCTION-guarded apply of ONLY 082_email_verification.sql. DO NOT run without approval.
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-082.js */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '082_email_verification.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT (SELECT to_regclass('public.email_verification_tokens') IS NOT NULL) AS table_ok,
         (SELECT count(*) FROM information_schema.columns WHERE table_name='users'
            AND column_name IN ('email_verified','email_verified_at'))::int AS cols
`)).rows[0];
const line = () => console.log('-'.repeat(60));
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: not the PRODUCTION endpoint (ep-proud-leaf-an8pzkib).'); return 2; }
  if (!fs.existsSync(FILE_PATH)) { console.error('FAIL: migration file not found: ' + FILE); return 1; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    line(); console.log('PRODUCTION migrate: ONLY ' + FILE); console.log('  database: ' + dbn); line();
    if (await ledgerHas(c)) { console.log('SKIP apply (already recorded; idempotent). Verifying only.'); }
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 082 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('FAIL during apply (rolled back):', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    line(); console.log('POST ledger[082]: ' + (recorded ? 'recorded' : 'NOT recorded') + ' | table_ok=' + v.table_ok + ' cols(2)=' + v.cols);
    const pass = recorded && v.table_ok === true && v.cols === 2;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL')); line();
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
