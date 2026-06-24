#!/usr/bin/env node
/*
 * prod-migrate-072.js — PRODUCTION-guarded apply of ONLY 072_invoice_documents.sql.
 * Refuses non-production; one file; idempotent (skips if ledger has 072); verifies
 * generated_documents + invoice columns + invoice_number sequence; records in the apply txn.
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-072.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FILE = '072_invoice_documents.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const ledgerHas = async (c) => (await c.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT to_regclass('public.generated_documents') AS gen_docs,
         to_regclass('public.invoice_number_seq')   AS seq,
         (SELECT count(*) FROM information_schema.columns
            WHERE table_name='invoices'
              AND column_name IN ('invoice_number','invoice_date','hammer_cents','buyer_premium_cents',
                                  'sales_tax_cents','shipping_cents','total_cents','pdf_public_id','pdf_sha256','pdf_generated_at'))::int AS inv_cols,
         (SELECT count(*) FROM invoices WHERE invoice_number IS NULL)::int AS unnumbered
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
    if (await ledgerHas(c)) {
      console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    } else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 072 and recorded its ledger row (072 only).');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('FAIL during apply (rolled back):', e.message); return 1; }
    }
    const recorded = await ledgerHas(c);
    const v = await verify(c);
    line();
    console.log('POST ledger[072]: ' + (recorded ? 'recorded' : 'NOT recorded'));
    console.log('  generated_documents:  ' + (v.gen_docs ? 'present' : 'ABSENT'));
    console.log('  invoice_number_seq:   ' + (v.seq ? 'present' : 'ABSENT'));
    console.log('  invoice columns (10): ' + v.inv_cols);
    console.log('  unnumbered invoices:  ' + v.unnumbered);
    const pass = recorded && v.gen_docs && v.seq && v.inv_cols === 10 && v.unnumbered === 0;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    line();
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
