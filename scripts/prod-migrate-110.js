#!/usr/bin/env node
/* prod-migrate-110.js — PRODUCTION-guarded apply of ONLY 110_professional_platform_fee.sql.
   Additive columns + one CHECK constraint (per-seller professional platform fee, default 4%).
   Idempotent (IF NOT EXISTS + guarded constraint + schema_migrations ledger). Production-safe:
   the fee is only applied to professional sellers at settlement, and there are no real
   professional accounts yet, so establishing the 4% default changes no existing payout. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '110_professional_platform_fee.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='seller_profiles' AND column_name='platform_fee_bps') AS sp_col,
    (SELECT column_default FROM information_schema.columns WHERE table_name='seller_profiles' AND column_name='platform_fee_bps') AS sp_default,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='seller_payouts'  AND column_name='platform_fee_bps') AS payout_col,
    (SELECT count(*)::int FROM pg_constraint WHERE conname='chk_seller_platform_fee_bps_range') AS chk
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 110 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.sp_col === 1 && v.payout_col === 1 && v.chk === 1 && String(v.sp_default || '').includes('400');
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
