#!/usr/bin/env node
/*
 * prod-migrate-066.js — PRODUCTION-guarded apply of ONLY 066_search_indexes.sql.
 * Same guarantees as prod-migrate-065.js: refuses any non-prod endpoint; applies
 * just the one file (never iterates the dir; never touches 008/017/032/065/etc.);
 * idempotent (skips if ledger already records 066); verifies PRE/POST state;
 * records the schema_migrations row for 066 ONLY, inside the apply transaction.
 *
 * 066 is additive (pg_trgm extension + IF NOT EXISTS indexes). At pilot scale the
 * plain CREATE INDEX (brief lock) is fine; on a large table use CONCURRENTLY.
 *
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-066.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FILE = '066_search_indexes.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const INDEXES = [
  'idx_auctions_title_trgm', 'idx_auctions_desc_trgm', 'idx_auctions_city_trgm', 'idx_sellerprofiles_name_trgm',
  'idx_lots_title_trgm', 'idx_lots_desc_trgm', 'idx_lots_maker_trgm', 'idx_lots_category_trgm',
  'idx_lots_state_closes', 'idx_lots_created', 'idx_lots_state_bidcount', 'idx_lots_category_btree', 'idx_auctions_state_addr',
];

const ledgerHas = async (c) => (await c.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [FILE])).rowCount > 0;
const trgmPresent = async (c) => (await c.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`)).rowCount > 0;
const idxPresent = async (c) => (await c.query(`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`, [INDEXES])).rows.map(r => r.indexname);
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
    line(); console.log('PRODUCTION migrate: ONLY ' + FILE); console.log('  database: ' + db + '  | endpoint: direct (pooler stripped)'); line();

    const recordedBefore = await ledgerHas(c);
    console.log('PRE  schema_migrations[066]: ' + (recordedBefore ? 'recorded' : 'not recorded'));
    console.log('PRE  pg_trgm extension     : ' + (await trgmPresent(c) ? 'present' : 'absent'));
    console.log('PRE  indexes present       : ' + (await idxPresent(c)).length + '/' + INDEXES.length);

    if (recordedBefore) {
      console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    } else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 066 and recorded its ledger row (066 only).');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        console.error('FAIL during apply (rolled back, no ledger row written):', e.message);
        return 1;
      }
    }

    const recorded = await ledgerHas(c);
    const trgm = await trgmPresent(c);
    const idx = await idxPresent(c);
    const pass = recorded && trgm && idx.length === INDEXES.length;
    line();
    console.log('POST schema_migrations[066]: ' + (recorded ? 'recorded' : 'NOT recorded'));
    console.log('POST pg_trgm extension     : ' + (trgm ? 'present' : 'ABSENT'));
    console.log('POST indexes present       : ' + idx.length + '/' + INDEXES.length);
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    line();
    return pass ? 0 : 1;
  } catch (e) {
    console.error('FATAL:', e.message);
    return 1;
  } finally {
    c.release(); await pool.end();
  }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
