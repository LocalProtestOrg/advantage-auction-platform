#!/usr/bin/env node
/* prod-migrate-141.js — PRODUCTION-guarded apply of ONLY 141_marketing_execution_runtime_3o.sql.
   Additive: obligation state-machine cols + append-only events + desktop bridge tables + runtime exports +
   channel readiness (6 states). NOTHING charges/sends/spends/flips an external gate. Idempotent. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '141_marketing_execution_runtime_3o.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name IN
      ('marketing_obligation_events','marketing_desktop_messages','marketing_runtime_exports','marketing_channel_readiness')) AS tbls,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='marketing_obligations'
      AND column_name IN ('feature_key','ladder_id','wave','blocked_reason','needs_owner_reason','attempts','terminal_at')) AS ob_cols,
    (SELECT count(*)::int FROM marketing_channel_readiness WHERE state='ACTIVE') AS active_channels,
    (SELECT count(*)::int FROM marketing_channel_readiness WHERE state='SHADOW_CERTIFIED') AS shadow_channels,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.a7_send_enabled') AS a7_on,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.destinations.google_ads_enabled') AS google_on
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 141 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.tbls === 4 && v.ob_cols === 7 && v.active_channels >= 5 && v.shadow_channels >= 3
      && v.a7_on === false && v.google_on === false;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
