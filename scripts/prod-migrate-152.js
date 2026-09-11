#!/usr/bin/env node
/* prod-migrate-152.js — PRODUCTION-guarded apply of ONLY 152_meta_ad_account_exclusion.sql.
   Additive + idempotent: the Owner-excluded Meta ad account list (act_664514018846795).
   Verifies the key holds the excluded account and that every paid / publish gate is still OFF and the Director is in shadow mode. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '152_meta_ad_account_exclusion.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const EXCLUDED = 'act_664514018846795';
const OFF = ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled', 'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled', 'marketing.social.reply_draft_enabled'];
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP)) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes(PROD_EP)) { console.error('REFUSE: not the PRODUCTION endpoint (' + PROD_EP + ').'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 152 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const row = (await c.query(`SELECT value FROM platform_config WHERE key='marketing.measurement.meta_ad_account_excluded'`)).rows[0];
    const col = row && Array.isArray(row.value) && row.value.includes(EXCLUDED) ? 1 : 0;
    const on = (await c.query(`SELECT key FROM platform_config WHERE key = ANY($1) AND (value = 'true'::jsonb OR value = '"true"'::jsonb)`, [OFF])).rows.map((r) => r.key);
    const mode = (await c.query(`SELECT value FROM platform_config WHERE key='marketing.paid_growth.mode'`)).rows[0];
    console.log('Verify:', JSON.stringify({ excluded_account_listed: col === 1, paid_gates_on: on, mode: mode && mode.value, ledger: await ledgerHas(c) }));
    const pass = col === 1 && on.length === 0 && mode && mode.value === 'shadow';
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
