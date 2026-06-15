#!/usr/bin/env node
/* stg-migrate-068.js — STAGING-guarded apply of ONLY 068_user_account_fields.sql.
 * Refuses the production endpoint. Idempotent (additive SQL + ledger guard).
 *   railway run --service advantage-staging --environment production node scripts/stg-migrate-068.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const FILE = '068_user_account_fields.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: PRODUCTION endpoint. Staging-only.'); return 2; }
  if (!raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: not the STAGING endpoint.'); return 2; }
  if (!fs.existsSync(FILE_PATH)) { console.error('FAIL: migration file not found'); return 1; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const recorded = (await c.query(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [FILE])).rowCount > 0;
    if (recorded) console.log('SKIP apply (ledger has 068). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 068 (+ ledger).');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('FAIL apply (rolled back):', e.message); return 1; }
    }
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name IN ('full_name','phone')`)).rows.map(r => r.column_name);
    const tbl = (await c.query(`SELECT 1 FROM information_schema.tables WHERE table_name='user_admin_notes'`)).rowCount > 0;
    const pass = cols.includes('full_name') && cols.includes('phone') && tbl;
    console.log('POST users cols:', cols.join(',') || '(none)', '| user_admin_notes:', tbl ? 'present' : 'ABSENT');
    console.log('RESULT:', pass ? 'PASS' : 'FAIL');
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
