#!/usr/bin/env node
/* prod-migrate-115.js — PRODUCTION-guarded apply of ONLY 115_follower_email_campaigns.sql.
   Additive: FOLLOWER_EVENT queue type, seller_profiles.follower_email_enabled,
   notification_preferences.follower_emails_enabled, email_suppressions, follower_campaigns. Idempotent. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '115_follower_email_campaigns.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='seller_profiles' AND column_name='follower_email_enabled') AS sp_flag,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='notification_preferences' AND column_name='follower_emails_enabled') AS np_flag,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name='email_suppressions') AS supp,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name='follower_campaigns') AS camp,
    (SELECT count(*)::int FROM pg_constraint WHERE conname='notifications_queue_type_check'
       AND pg_get_constraintdef(oid) LIKE '%FOLLOWER_EVENT%') AS type_ck
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 115 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.sp_flag === 1 && v.np_flag === 1 && v.supp === 1 && v.camp === 1 && v.type_ck === 1;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
