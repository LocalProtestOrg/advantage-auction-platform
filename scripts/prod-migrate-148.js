#!/usr/bin/env node
/* prod-migrate-148.js — PRODUCTION-guarded apply of ONLY 148_restore_email_verification.sql.
   Additive + idempotent: restores 082's email_verified / email_verified_at columns, the
   email_verification_tokens table and its two indexes. Existing users are preserved and stay
   email_verified=false (no fabricated verification history). Verifies user count is unchanged. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '148_restore_email_verification.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='users' AND column_name IN ('email_verified','email_verified_at')) AS cols,
    (SELECT to_regclass('public.email_verification_tokens') IS NOT NULL) AS token_table,
    (SELECT count(*)::int FROM pg_indexes WHERE indexname IN ('idx_email_verif_token','idx_email_verif_user')) AS idx,
    (SELECT count(*)::int FROM users) AS users_total
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
    const before = (await c.query('SELECT count(*)::int n FROM users')).rows[0].n;
    let justApplied = false;
    if (await ledgerHas(c)) { console.log('SKIP apply (already recorded; idempotent). Verifying only.'); }
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); justApplied = true; console.log('APPLIED 148 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    const verifiedTrue = (await c.query('SELECT count(*)::int n FROM users WHERE email_verified = true')).rows[0].n;
    console.log('Verify:', JSON.stringify(Object.assign({}, v, { users_before: before, users_verified_true: verifiedTrue })), 'ledger:', recorded);
    const pass = recorded && v.cols === 2 && v.token_table === true && v.idx === 2 && v.users_total === before && (!justApplied || verifiedTrue === 0);
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
