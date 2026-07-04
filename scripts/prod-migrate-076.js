#!/usr/bin/env node
/*
 * prod-migrate-076.js — PRODUCTION-guarded apply of ONLY 076_organizations_and_events.sql.
 * Refuses non-production; one file; additive; idempotent (skips if ledger has 076);
 * verifies the 7 new tables + seeds; records 076 in the apply txn.
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-076.js
 */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '076_organizations_and_events.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const ledgerHas = async (c) => (await c.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
       AND table_name = ANY(ARRAY['organization_plans','organizations','organization_members',
                                  'event_markets','event_categories','events','event_images']))::int AS tables,
    (SELECT count(*) FROM organization_plans)::int  AS plans,
    (SELECT count(*) FROM event_markets)::int       AS markets,
    (SELECT count(*) FROM event_categories)::int    AS cats
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 076 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('FAIL during apply (rolled back):', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    line(); console.log('POST ledger[076]: ' + (recorded ? 'recorded' : 'NOT recorded'));
    console.log('  tables (7): ' + v.tables + ' | plans (3): ' + v.plans + ' | markets (2): ' + v.markets + ' | cats (8): ' + v.cats);
    const pass = recorded && v.tables === 7 && v.plans === 3 && v.markets === 2 && v.cats === 8;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL')); line();
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
