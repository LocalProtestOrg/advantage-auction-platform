#!/usr/bin/env node
/*
 * prod-migrate-065.js — PRODUCTION-guarded apply of ONLY
 * 065_notification_queue_lease.sql. NOT a general runner.
 *
 * Hard guarantees:
 *   - REQUIRES the production endpoint (ep-proud-leaf-an8pzkib); REFUSES staging
 *     (ep-royal-dawn-anarou3f) and any other endpoint.
 *   - Applies ONLY the single file 065_notification_queue_lease.sql. It never
 *     reads, iterates, or touches any other migration (008/017/032/etc.).
 *   - Idempotent: if schema_migrations already records 065, it SKIPS the apply
 *     and runs verification only.
 *   - Verifies expected PRE state and POST state (columns, status CHECK domain,
 *     indexes, ledger row).
 *   - Records the schema_migrations ledger row for 065 ONLY, after a successful
 *     apply, inside the same transaction as the DDL.
 *   - DDL on the DIRECT endpoint (strips -pooler). Never prints DATABASE_URL.
 *
 * Run (only when intentionally promoting, after a fresh Neon backup):
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-065.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FILE = '065_notification_queue_lease.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const NEW_COLS = ['next_attempt_at', 'locked_at', 'last_error', 'processed_at'];
const INDEXES  = ['idx_notifications_queue_ready', 'idx_notifications_queue_processing'];

const ledgerHas = async (c) => (await c.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [FILE])).rowCount > 0;
const colsPresent = async (c) => (await c.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='notifications_queue' AND column_name = ANY($1)`, [NEW_COLS]
)).rows.map(r => r.column_name);
const statusCheckDef = async (c) => {
  const r = await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='notifications_queue_status_check'`);
  return r.rows[0] ? r.rows[0].d : null;
};
const idxPresent = async (c) => (await c.query(`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`, [INDEXES])).rows.map(r => r.indexname);
const line = () => console.log('-'.repeat(60));

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: DATABASE_URL is the STAGING endpoint. This script is PRODUCTION-only.'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: DATABASE_URL is not the PRODUCTION endpoint (ep-proud-leaf-an8pzkib).'); return 2; }
  if (!fs.existsSync(FILE_PATH)) { console.error('FAIL: migration file not found: ' + FILE); return 1; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const db = (await c.query('SELECT current_database() d')).rows[0].d;
    line(); console.log('PRODUCTION migrate: ONLY ' + FILE); console.log('  database: ' + db + '  | endpoint: direct (pooler stripped)'); line();

    const recordedBefore = await ledgerHas(c);
    console.log('PRE  schema_migrations[065]: ' + (recordedBefore ? 'recorded' : 'not recorded'));
    console.log('PRE  new columns           : ' + JSON.stringify(await colsPresent(c)));
    console.log('PRE  status CHECK          : ' + (await statusCheckDef(c)));

    if (recordedBefore) {
      console.log('SKIP apply (already recorded; idempotent). Running verification only.');
    } else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 065 and recorded its ledger row (065 only).');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        console.error('FAIL during apply (rolled back, no ledger row written):', e.message);
        return 1;
      }
    }

    const recorded = await ledgerHas(c);
    const cols = await colsPresent(c);
    const ck = await statusCheckDef(c);
    const idx = await idxPresent(c);
    const ckOk = !!ck && ck.includes("'processing'") && ck.includes("'skipped'");
    const pass = recorded && cols.length === 4 && ckOk && idx.length === 2;
    line();
    console.log('POST schema_migrations[065]: ' + (recorded ? 'recorded' : 'NOT recorded'));
    console.log('POST new columns           : ' + cols.length + '/4 ' + JSON.stringify(cols));
    console.log('POST status CHECK          : ' + ck);
    console.log('POST indexes               : ' + idx.length + '/2 ' + JSON.stringify(idx));
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
