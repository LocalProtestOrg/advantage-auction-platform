#!/usr/bin/env node
/* prod-migrate-109.js — PRODUCTION-guarded apply of ONLY 109_stripe_tax_calculation.sql.
   Additive columns only (payments tax provenance + users buyer tax-address). Idempotent
   (IF NOT EXISTS + schema_migrations ledger). Safe to run before OR after the code deploy —
   the tax pipeline is flag-gated (STRIPE_TAX_ENABLED) and never touches these columns when off. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '109_stripe_tax_calculation.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='payments' AND column_name='taxable_base_cents')        AS base_col,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='payments' AND column_name='stripe_tax_calculation_id') AS calc_col,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='payments' AND column_name='stripe_tax_transaction_id') AS tx_col,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='payments' AND column_name='stripe_tax_reversal_id')    AS rev_col,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='users'    AND column_name='tax_address_line1')         AS addr_col,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='users'    AND column_name='tax_postal_code')           AS zip_col
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 109 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.base_col === 1 && v.calc_col === 1 && v.tx_col === 1 && v.rev_col === 1 && v.addr_col === 1 && v.zip_col === 1;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
