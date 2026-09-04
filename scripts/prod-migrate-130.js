#!/usr/bin/env node
/* prod-migrate-130.js — PRODUCTION-guarded apply of ONLY 130_growth_lab_4b.sql.
   Additive Growth Lab: prereg/conditions/verdict/band on experiments, Growth Pool reservation lifecycle,
   learning memory, signal registry, objective windows. No external activation. Idempotent, non-destructive. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '130_growth_lab_4b.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='marketing_experiments'
       AND column_name IN ('preregistration','prereg_hash','execution_started_at','conditions','baseline','verdict','band','attribution_grade')) AS exp_cols,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='growth_pool' AND column_name='reserved_cents') AS pool_reserved,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name IN
       ('growth_pool_reservations','marketing_learnings','marketing_signal_sources')) AS new_tables,
    (SELECT count(*)::int FROM marketing_signal_sources WHERE is_live=true) AS live_signals,
    (SELECT count(*)::int FROM platform_config WHERE key IN
       ('marketing.windows.professional_seller_days','marketing.portfolio.exploratory_max_share_bps','marketing.email.audience_rules_locked')) AS cfg,
    (SELECT count(*)::int FROM growth_pool WHERE reserved_cents <> 0) AS nonzero_reserved
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 130 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.exp_cols === 8 && v.pool_reserved === 1 && v.new_tables === 3
      && v.live_signals >= 5 && v.cfg === 3 && v.nonzero_reserved === 0;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
