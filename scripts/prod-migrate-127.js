#!/usr/bin/env node
/* prod-migrate-127.js — PRODUCTION-guarded apply of ONLY 127_marketing_lifecycle_shortfall.sql.
   Additive: marketing eligibility snapshot cols, seller_payouts marketing/shortfall cols, settlement_shortfalls.
   Idempotent. No seller-chargeable/receivable structures. Historical payouts untouched (defaults). */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '127_marketing_lifecycle_shortfall.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='marketing_jobs'
       AND column_name IN ('elig_total_lots','elig_clothing_lots','elig_clothing_pct_bps','elig_rule_version','elig_evaluated_at')) AS elig_cols,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='seller_payouts'
       AND column_name IN ('marketing_charge_cents','shortfall_cents','shortfall_recorded_at')) AS payout_cols,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name='settlement_shortfalls') AS shortfall_table,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='settlement_shortfalls' AND column_name IN ('setup_intent','payment_method','receivable')) AS leaky_cols,
    (SELECT count(*)::int FROM seller_payouts WHERE shortfall_cents <> 0) AS nonzero_existing_shortfalls
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 127 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    // nonzero_existing_shortfalls must be 0 — historical payouts must not be retroactively charged a shortfall.
    const pass = recorded && v.elig_cols === 5 && v.payout_cols === 3 && v.shortfall_table === 1
      && v.leaky_cols === 0 && v.nonzero_existing_shortfalls === 0;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
