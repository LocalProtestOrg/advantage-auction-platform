#!/usr/bin/env node
/* prod-migrate-113.js — PRODUCTION-guarded apply of ONLY 113_staff_rbac.sql.
   Additive staff RBAC columns (users.staff_role/staff_active/last_login_at) + CHECK +
   staff_permission_overrides table. Idempotent. Does NOT change buyer/seller/admin auth: every
   existing user gets staff_role=NULL (not staff), so no access changes for anyone until staff are
   explicitly assigned. Apply BEFORE deploying the code (the app reads staff_role). */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '113_staff_rbac.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='users' AND column_name='staff_role')    AS staff_role,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='users' AND column_name='staff_active')  AS staff_active,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='users' AND column_name='last_login_at') AS last_login,
    (SELECT count(*)::int FROM information_schema.tables  WHERE table_name='staff_permission_overrides')            AS overrides_tbl,
    (SELECT count(*)::int FROM pg_constraint WHERE conname='chk_users_staff_role')                                 AS chk
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 113 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.staff_role === 1 && v.staff_active === 1 && v.last_login === 1 && v.overrides_tbl === 1 && v.chk === 1;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
