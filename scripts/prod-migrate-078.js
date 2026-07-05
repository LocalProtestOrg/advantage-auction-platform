#!/usr/bin/env node
/*
 * prod-migrate-078.js — PRODUCTION-guarded apply of ONLY 078_partner_foundation.sql. DO NOT run without approval.
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-078.js
 */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '078_partner_foundation.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const ledgerHas = async (c) => (await c.query(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT (SELECT count(*) FROM plan_capabilities)::int AS plan_caps,
         (SELECT count(*) FROM platform_config)::int AS platform_cfg,
         (SELECT count(*) FROM auctions WHERE marketplace_status IS NULL OR is_syndicated IS NULL)::int AS bad_auctions,
         (SELECT to_regclass('public.legal_documents') IS NOT NULL AND to_regclass('public.legal_acceptances') IS NOT NULL) AS legal_ok
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 078 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('FAIL during apply (rolled back):', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    line(); console.log('POST ledger[078]: ' + (recorded ? 'recorded' : 'NOT recorded'));
    console.log('  plan_caps(17): ' + v.plan_caps + ' | platform_cfg(8): ' + v.platform_cfg + ' | bad_auctions(0): ' + v.bad_auctions + ' | legal_ok: ' + v.legal_ok);
    const pass = recorded && v.plan_caps === 17 && v.platform_cfg === 8 && v.bad_auctions === 0 && v.legal_ok === true;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL')); line();
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
