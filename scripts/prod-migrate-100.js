#!/usr/bin/env node
/* prod-migrate-100.js — PRODUCTION-guarded apply of ONLY 100_event_import_fields.sql. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '100_event_import_fields.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='events' AND column_name='subtitle')                   AS subt,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='events' AND column_name='buyer_premium_bps')          AS bp,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='event_images' AND column_name='content_hash')         AS img_hash,
    (SELECT count(*)::int FROM pg_indexes            WHERE indexname='uq_event_images_position')                                  AS pos_uq
`)).rows[0];
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP)) { console.error("REFUSE: STAGING endpoint. PRODUCTION-only."); return 2; }
  if (!raw.includes(PROD_EP)) { console.error("REFUSE: not the PRODUCTION endpoint (" + PROD_EP + ")."); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    if (await ledgerHas(c)) { console.log('SKIP apply (already recorded; idempotent). Verifying only.'); }
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 100 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.subt === 1 && v.bp === 1 && v.img_hash === 1 && v.pos_uq === 1;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
