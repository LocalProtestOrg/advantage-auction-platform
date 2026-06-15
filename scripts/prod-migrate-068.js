#!/usr/bin/env node
/* prod-migrate-068.js — PRODUCTION-guarded apply of ONLY 068_user_account_fields.sql.
 * Refuses the staging endpoint; requires the production endpoint. Additive +
 * idempotent (skips if ledger has 068). Verifies columns + table + ledger.
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-068.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const FILE = '068_user_account_fields.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
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
    const before = (await c.query(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [FILE])).rowCount > 0;
    console.log('PRE  ledger[068]: ' + (before ? 'recorded' : 'not recorded'));
    if (before) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 068 and recorded its ledger row (068 only).');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('FAIL during apply (rolled back):', e.message); return 1; }
    }
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name IN ('full_name','phone')`)).rows.map(r => r.column_name);
    const tbl = (await c.query(`SELECT 1 FROM information_schema.tables WHERE table_name='user_admin_notes'`)).rowCount > 0;
    const recorded = (await c.query(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [FILE])).rowCount > 0;
    const pass = cols.includes('full_name') && cols.includes('phone') && tbl && recorded;
    line();
    console.log('POST users cols: ' + (cols.join(',') || '(none)') + ' | user_admin_notes: ' + (tbl ? 'present' : 'ABSENT') + ' | ledger: ' + (recorded ? 'recorded' : 'NOT'));
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    line();
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
