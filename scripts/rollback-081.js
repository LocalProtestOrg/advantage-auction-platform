#!/usr/bin/env node
/* rollback-081.js — reverse 081_crm_foundation.sql. DESTRUCTIVE (drops CRM tables + columns).
 * Also revert the 081 code (CRM services/routes reference these). Guarded:
 * CONFIRM_ROLLBACK_081=YES; production also CONFIRM_ROLLBACK_081_PROD=YES + owner approval. */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const SQL = `
BEGIN;
  DROP TABLE IF EXISTS organization_activity;
  DROP TABLE IF EXISTS organization_reps;
  ALTER TABLE organizations DROP COLUMN IF EXISTS crm_stage;
  ALTER TABLE organizations DROP COLUMN IF EXISTS next_action_at;
  ALTER TABLE organizations DROP COLUMN IF EXISTS last_contacted_at;
  ALTER TABLE organizations DROP COLUMN IF EXISTS health_score;
  ALTER TABLE organizations DROP COLUMN IF EXISTS health_computed_at;
  DELETE FROM schema_migrations WHERE filename = '081_crm_foundation.sql';
COMMIT;
`;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (process.env.CONFIRM_ROLLBACK_081 !== 'YES') { console.error('REFUSE: set CONFIRM_ROLLBACK_081=YES (destructive).'); return 2; }
  if (raw.includes(PROD_EP) && process.env.CONFIRM_ROLLBACK_081_PROD !== 'YES') {
    console.error('REFUSE: PRODUCTION — also set CONFIRM_ROLLBACK_081_PROD=YES (and obtain owner approval).'); return 2;
  }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    console.log('ROLLBACK 081 on: ' + dbn + (raw.includes(PROD_EP) ? ' (PRODUCTION)' : ''));
    await c.query(SQL);
    const gone = (await c.query("SELECT to_regclass('public.organization_activity') AS t")).rows[0].t === null;
    console.log('RESULT: ' + (gone ? 'ROLLED BACK' : 'FAIL'));
    return gone ? 0 : 1;
  } catch (e) { console.error('ROLLBACK FAILED:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
