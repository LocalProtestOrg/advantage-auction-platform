#!/usr/bin/env node
/* stg-migrate-086.js — STAGING-guarded apply of ONLY 086_settlement_foundation.sql. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '086_settlement_foundation.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.tables  WHERE table_name='settlement_adjustments') AS adj,
    (SELECT count(*)::int FROM information_schema.tables  WHERE table_name='settlement_snapshots')   AS snap,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='seller_payouts' AND column_name='settlement_status')  AS status_col,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='seller_payouts' AND column_name='settlement_version') AS ver_col
`)).rows[0];
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint. STAGING-only.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error('REFUSE: not the STAGING endpoint (' + STG_EP + ').'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    if (await ledgerHas(c)) { console.log('SKIP apply (already recorded; idempotent). Verifying only.'); }
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 086 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.adj === 1 && v.snap === 1 && v.status_col === 1 && v.ver_col === 1;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
