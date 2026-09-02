#!/usr/bin/env node
/* prod-migrate-124.js — PRODUCTION-guarded apply of ONLY 124_demo_account_hardening.sql.
   Flags demo-seller@/demo-buyer@ as is_demo, makes the demo seller professional, isolates its auctions.
   Idempotent + scoped to the two demo emails. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '124_demo_account_hardening.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM users WHERE email IN ('demo-seller@advantage.bid','demo-buyer@advantage.bid') AND is_demo=true) AS demo_users,
    (SELECT count(*)::int FROM seller_profiles sp JOIN users u ON u.id=sp.user_id WHERE u.email='demo-seller@advantage.bid' AND sp.is_demo=true) AS demo_sp,
    (SELECT count(*)::int FROM auctions a JOIN seller_profiles sp ON sp.id=a.seller_id JOIN users u ON u.id=sp.user_id
       WHERE u.email='demo-seller@advantage.bid' AND (a.is_demo IS DISTINCT FROM true OR a.marketplace_status<>'hidden')) AS leaky_auctions
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 124 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.demo_users === 2 && v.demo_sp === 1 && v.leaky_auctions === 0;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
