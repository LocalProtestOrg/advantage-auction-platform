#!/usr/bin/env node
/* rollback-079.js — reverse 079_activation_foundation.sql. DESTRUCTIVE (drops the new organizations columns).
 * NOTE: also revert the 079 CODE (onboarding references these columns) — code + schema roll back together.
 * Guarded: CONFIRM_ROLLBACK_079=YES; production also CONFIRM_ROLLBACK_079_PROD=YES + owner approval.
 * Prefer a Neon backup restore for production. */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const SQL = `
BEGIN;
  DROP INDEX IF EXISTS uq_organizations_bd_listing;
  DROP INDEX IF EXISTS idx_organizations_lifecycle;
  DROP INDEX IF EXISTS idx_organizations_match_key;
  ALTER TABLE organizations DROP COLUMN IF EXISTS lifecycle_state;
  ALTER TABLE organizations DROP COLUMN IF EXISTS source;
  ALTER TABLE organizations DROP COLUMN IF EXISTS bd_listing_id;
  ALTER TABLE organizations DROP COLUMN IF EXISTS match_key;
  COMMENT ON COLUMN organizations.seller_profile_id IS NULL;
  COMMENT ON COLUMN seller_profiles.capabilities IS NULL;
  COMMENT ON COLUMN auctions.organization_id IS NULL;
  DELETE FROM schema_migrations WHERE filename = '079_activation_foundation.sql';
COMMIT;
`;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (process.env.CONFIRM_ROLLBACK_079 !== 'YES') { console.error('REFUSE: set CONFIRM_ROLLBACK_079=YES (destructive).'); return 2; }
  if (raw.includes(PROD_EP) && process.env.CONFIRM_ROLLBACK_079_PROD !== 'YES') {
    console.error('REFUSE: PRODUCTION — also set CONFIRM_ROLLBACK_079_PROD=YES (and obtain owner approval).'); return 2;
  }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    console.log('ROLLBACK 079 on: ' + dbn + (raw.includes(PROD_EP) ? ' (PRODUCTION)' : ''));
    await c.query(SQL);
    const gone = (await c.query("SELECT count(*)::int c FROM information_schema.columns WHERE table_name='organizations' AND column_name='lifecycle_state'")).rows[0].c === 0;
    console.log('RESULT: ' + (gone ? 'ROLLED BACK' : 'FAIL'));
    return gone ? 0 : 1;
  } catch (e) { console.error('ROLLBACK FAILED:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
