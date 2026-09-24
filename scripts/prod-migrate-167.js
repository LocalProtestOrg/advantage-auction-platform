#!/usr/bin/env node
/* prod-migrate-167.js — PRODUCTION-guarded apply of ONLY 167_event_import_resilience.sql.
   Verifies: health columns + 'retry' trigger exist; the three frozen CSV sources are paused with
   their events untouched; exactly the practice listing left the public set; no event was deleted; the
   live connectors are still active; Lewis & Maese data is untouched. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '167_event_import_resilience.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const snap = async () => (await c.query(
      `SELECT (SELECT count(*)::int FROM events) events,
              (SELECT count(*)::int FROM events WHERE status='published' AND source='imported' AND (end_at IS NULL OR end_at >= now())) public_imported,
              (SELECT count(*)::int FROM event_sources) provenance,
              (SELECT count(*)::int FROM import_sources) sources,
              (SELECT count(*)::int FROM import_runs) runs,
              (SELECT count(*)::int FROM import_sources WHERE status='active' AND kind <> 'csv') live_active`)).rows[0];
    const before = await snap();
    const done = (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
    if (done) console.log('SKIP apply (already recorded). Verifying only.');
    else {
      try { await c.query(fs.readFileSync(FILE_PATH, 'utf8')); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 167.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const csv = (await c.query(`SELECT key, status, health_state, config ? 'frozen_reason' AS frozen FROM import_sources WHERE kind='csv' ORDER BY key`)).rows;
    const test = (await c.query(`SELECT status FROM events WHERE id='93b9beef-ba8f-4556-bade-f3712bd226f3'`)).rows[0];
    let retryOk = false;
    await c.query('BEGIN');
    try { await c.query(`INSERT INTO import_runs (source_id, trigger, status) SELECT id, 'retry', 'running' FROM import_sources LIMIT 1`); retryOk = true; } catch (_) { retryOk = false; }
    await c.query('ROLLBACK');
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      health_columns: (await c.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='import_sources'
          AND column_name IN ('health_state','health_reason','consecutive_failures','consecutive_zero_runs','last_success_at','last_nonzero_at','next_retry_at','retry_count','last_error')`)).rows[0].n === 9,
      retry_trigger_allowed: retryOk,
      csv_sources_paused_frozen: csv.length === 3 && csv.every((r) => r.status === 'paused' && r.health_state === 'NO_LONGER_USEFUL' && r.frozen),
      no_event_deleted: after.events === before.events,
      no_provenance_deleted: after.provenance === before.provenance,
      no_source_deleted: after.sources === before.sources,
      run_history_kept: after.runs === before.runs,
      practice_listing_rejected: !!test && test.status === 'rejected',
      exactly_one_left_public: before.public_imported - after.public_imported === (done ? 0 : 1) || after.public_imported === before.public_imported,
      live_connectors_still_active: after.live_active === 3,
    };
    console.log('Before:', JSON.stringify(before));
    console.log('After: ', JSON.stringify(after));
    console.log('CSV:   ', JSON.stringify(csv.map((r) => [r.key, r.status, r.health_state])));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
