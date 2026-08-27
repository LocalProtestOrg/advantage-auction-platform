#!/usr/bin/env node
/* prod-migrate-116.js — PRODUCTION-guarded apply of ONLY 116_sales_prospect_crm.sql.
   Additive CRM columns on sales_prospects (business_type, opportunity_type, lead_priority, priority_locked,
   contact_source, last_contacted_by_user_id, dedup keys, generated is_actionable) + indexes. Idempotent. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '116_sales_prospect_crm.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='sales_prospects' AND column_name='business_type')      AS biz,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='sales_prospects' AND column_name='lead_priority')      AS prio,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='sales_prospects' AND column_name='last_contacted_by_user_id') AS cby,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='sales_prospects' AND column_name='is_actionable')      AS act,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='sales_prospects' AND column_name='website_domain')     AS dom
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 116 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.biz === 1 && v.prio === 1 && v.cby === 1 && v.act === 1 && v.dom === 1;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
