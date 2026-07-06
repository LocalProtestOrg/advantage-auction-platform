#!/usr/bin/env node
/* rollback-083.js — reverse 083_pickup_completion.sql. DESTRUCTIVE (drops pickup completion columns).
 * Also revert the 083 code (pickupPlanService, at-close hook, retired assignPickupOnPayment, adminPickup).
 * Guarded: CONFIRM_ROLLBACK_083=YES; production also CONFIRM_ROLLBACK_083_PROD=YES + owner approval. */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const SQL = `
BEGIN;
  DROP INDEX IF EXISTS idx_pickup_assign_buyer;
  DROP INDEX IF EXISTS idx_pickup_assign_status;
  ALTER TABLE pickup_assignments DROP COLUMN IF EXISTS assigned_tier;
  ALTER TABLE pickup_assignments DROP COLUMN IF EXISTS pickup_status;
  ALTER TABLE pickup_assignments DROP COLUMN IF EXISTS completed_at;
  ALTER TABLE pickup_assignments DROP COLUMN IF EXISTS completed_by;
  DELETE FROM schema_migrations WHERE filename = '083_pickup_completion.sql';
COMMIT;
`;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (process.env.CONFIRM_ROLLBACK_083 !== 'YES') { console.error('REFUSE: set CONFIRM_ROLLBACK_083=YES (destructive).'); return 2; }
  if (raw.includes(PROD_EP) && process.env.CONFIRM_ROLLBACK_083_PROD !== 'YES') {
    console.error('REFUSE: PRODUCTION — also set CONFIRM_ROLLBACK_083_PROD=YES (and obtain owner approval).'); return 2;
  }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    console.log('ROLLBACK 083 on: ' + dbn + (raw.includes(PROD_EP) ? ' (PRODUCTION)' : ''));
    await c.query(SQL);
    const gone = (await c.query("SELECT count(*)::int c FROM information_schema.columns WHERE table_name='pickup_assignments' AND column_name='pickup_status'")).rows[0].c === 0;
    console.log('RESULT: ' + (gone ? 'ROLLED BACK' : 'FAIL'));
    return gone ? 0 : 1;
  } catch (e) { console.error('ROLLBACK FAILED:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
