#!/usr/bin/env node
/* prod-migrate-165.js — PRODUCTION-guarded apply of ONLY 165_scoped_creative_approval.sql.
   Verifies: scope columns exist, a malformed scope is refused by the database, and no existing
   package, campaign, ledger row or provider object changed. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '165_scoped_creative_approval.sql';
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
      `SELECT (SELECT count(*)::int FROM marketing_creative_packages) packages,
              (SELECT count(*)::int FROM marketing_creative_packages WHERE approval_state='OWNER_APPROVED') approved,
              (SELECT count(*)::int FROM marketing_paid_campaigns) campaigns,
              (SELECT count(*)::int FROM marketing_paid_budget_ledger WHERE kind <> 'actual') commitments,
              (SELECT count(*)::int FROM marketing_provider_objects) objects`)).rows[0];
    const before = await snap();
    const done = (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
    if (done) console.log('SKIP apply (already recorded). Verifying only.');
    else {
      try { await c.query(fs.readFileSync(FILE_PATH, 'utf8')); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 165.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    let shapeGuard = false;
    await c.query('BEGIN');
    try { await c.query(`UPDATE marketing_creative_packages SET approval_scope='{"purpose":"x"}'::jsonb WHERE package_key='PKG-IS-HOU-V1'`); }
    catch (e) { shapeGuard = /chk_mcp_scope_shape/.test(e.message); }
    await c.query('ROLLBACK');
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      scope_columns: (await c.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='marketing_creative_packages'
          AND column_name IN ('approval_scope','approval_recorded_at','approval_evidence')`)).rows[0].n === 3,
      malformed_scope_refused: shapeGuard,
      existing_packages_unscoped: (await c.query(`SELECT count(*)::int n FROM marketing_creative_packages WHERE approval_scope IS NOT NULL`)).rows[0].n === 0,
      nothing_else_changed: JSON.stringify(before) === JSON.stringify(after),
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
