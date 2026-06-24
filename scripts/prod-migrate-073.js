#!/usr/bin/env node
/*
 * prod-migrate-073.js — PRODUCTION-guarded apply of ONLY 073_invoice_lifecycle.sql.
 * Refuses non-production; one file; idempotent (skips if ledger has 073); verifies
 * payment_id is nullable + the (lot_id,buyer_user_id) unique index; records in apply txn.
 *
 * SAFETY: 073 dedups duplicate (lot_id,buyer_user_id) invoices before adding the unique
 * index. Run prod-preflight-phase2.js first and confirm duplicate_invoices.count === 0,
 * so the dedup DELETE is a no-op on production.
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-073.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FILE = '073_invoice_lifecycle.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const ledgerHas = async (c) => (await c.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT (SELECT is_nullable FROM information_schema.columns WHERE table_name='invoices' AND column_name='payment_id') AS pid_nullable,
         to_regclass('public.idx_invoices_lot_buyer') AS uniq_idx,
         (SELECT count(*) FROM (SELECT 1 FROM invoices WHERE lot_id IS NOT NULL AND buyer_user_id IS NOT NULL
                                 GROUP BY lot_id, buyer_user_id HAVING count(*) > 1) d)::int AS remaining_dups
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

    // Pre-apply safety: refuse if duplicates exist (073 would delete rows). Operator must
    // resolve duplicates manually first. (preflight should already confirm zero.)
    if (!(await ledgerHas(c))) {
      const dups = (await c.query(`SELECT count(*)::int n FROM (SELECT 1 FROM invoices WHERE lot_id IS NOT NULL AND buyer_user_id IS NOT NULL GROUP BY lot_id, buyer_user_id HAVING count(*) > 1) d`)).rows[0].n;
      if (dups > 0) { console.error('ABORT: ' + dups + ' duplicate (lot_id,buyer_user_id) invoice group(s) exist. Resolve manually before 073.'); return 1; }
    }

    if (await ledgerHas(c)) {
      console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    } else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 073 and recorded its ledger row (073 only).');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('FAIL during apply (rolled back):', e.message); return 1; }
    }
    const recorded = await ledgerHas(c);
    const v = await verify(c);
    line();
    console.log('POST ledger[073]: ' + (recorded ? 'recorded' : 'NOT recorded'));
    console.log('  payment_id nullable:  ' + v.pid_nullable);
    console.log('  unique idx (lot,buyer): ' + (v.uniq_idx ? 'present' : 'ABSENT'));
    console.log('  remaining duplicates: ' + v.remaining_dups);
    const pass = recorded && v.pid_nullable === 'YES' && v.uniq_idx && v.remaining_dups === 0;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    line();
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
