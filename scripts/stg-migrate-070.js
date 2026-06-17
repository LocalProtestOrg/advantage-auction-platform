#!/usr/bin/env node
/*
 * stg-migrate-070.js — STAGING-guarded apply of ONLY 070_seller_agreement_gate.sql.
 * Refuses any non-staging endpoint; applies just the one file; idempotent (skips if
 * ledger records 070); verifies the three additive columns + ledger row; records 070
 * in the apply transaction. Additive only.
 *
 *   railway run --service advantage-staging --environment production node scripts/stg-migrate-070.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FILE = '070_seller_agreement_gate.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const ledgerHas = async (c) => (await c.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [FILE])).rowCount > 0;
const colsPresent = async (c) => (await c.query(
  `SELECT
     (SELECT count(*) FROM information_schema.columns WHERE table_name='seller_profiles' AND column_name='agreement_waived_at')::int AS w1,
     (SELECT count(*) FROM information_schema.columns WHERE table_name='seller_profiles' AND column_name='agreement_waived_by')::int AS w2,
     (SELECT count(*) FROM information_schema.columns WHERE table_name='agreements' AND column_name='signed_pdf_emailed_at')::int AS e1`
)).rows[0];
const line = () => console.log('-'.repeat(60));

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: PRODUCTION endpoint. STAGING-only.'); return 2; }
  if (!raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: not the STAGING endpoint (ep-royal-dawn-anarou3f).'); return 2; }
  if (!fs.existsSync(FILE_PATH)) { console.error('FAIL: migration file not found: ' + FILE); return 1; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    line(); console.log('STAGING migrate: ONLY ' + FILE); console.log('  database: ' + dbn); line();
    if (await ledgerHas(c)) {
      console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    } else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 070 and recorded its ledger row (070 only).');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('FAIL during apply (rolled back):', e.message); return 1; }
    }
    const recorded = await ledgerHas(c);
    const cols = await colsPresent(c);
    const pass = recorded && cols.w1 === 1 && cols.w2 === 1 && cols.e1 === 1;
    line();
    console.log('POST ledger[070]: ' + (recorded ? 'recorded' : 'NOT recorded'));
    console.log('  seller_profiles.agreement_waived_at: ' + (cols.w1 ? 'present' : 'ABSENT'));
    console.log('  seller_profiles.agreement_waived_by: ' + (cols.w2 ? 'present' : 'ABSENT'));
    console.log('  agreements.signed_pdf_emailed_at:    ' + (cols.e1 ? 'present' : 'ABSENT'));
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    line();
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
