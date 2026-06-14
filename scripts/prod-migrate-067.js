#!/usr/bin/env node
/*
 * prod-migrate-067.js — PRODUCTION-guarded apply of ONLY
 * 067_add_auction_buyer_premium.sql. Same guarantees as 065/066: refuses any
 * non-prod endpoint; applies just the one file; idempotent (skips if ledger
 * records 067); verifies the column + ledger row; records 067 only, in the
 * apply transaction. Additive (one nullable column); not auto-applied.
 *
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-067.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FILE = '067_add_auction_buyer_premium.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const ledgerHas = async (c) => (await c.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [FILE])).rowCount > 0;
const colPresent = async (c) => (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='auctions' AND column_name='buyer_premium_bps'`)).rowCount > 0;
const line = () => console.log('-'.repeat(60));

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: not the PRODUCTION endpoint (ep-proud-leaf-an8pzkib).'); return 2; }
  if (!fs.existsSync(FILE_PATH)) { console.error('FAIL: migration file not found: ' + FILE); return 1; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const db = (await c.query('SELECT current_database() d')).rows[0].d;
    line(); console.log('PRODUCTION migrate: ONLY ' + FILE); console.log('  database: ' + db); line();
    const recordedBefore = await ledgerHas(c);
    console.log('PRE  schema_migrations[067]: ' + (recordedBefore ? 'recorded' : 'not recorded') + ' | column: ' + (await colPresent(c) ? 'present' : 'absent'));
    if (recordedBefore) {
      console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    } else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 067 and recorded its ledger row (067 only).');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('FAIL during apply (rolled back):', e.message); return 1; }
    }
    const recorded = await ledgerHas(c);
    const col = await colPresent(c);
    const pass = recorded && col;
    line();
    console.log('POST schema_migrations[067]: ' + (recorded ? 'recorded' : 'NOT recorded') + ' | auctions.buyer_premium_bps: ' + (col ? 'present' : 'ABSENT'));
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    line();
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
