#!/usr/bin/env node
/* rollback-080.js — reverse 080_directory_mirror_fields.sql. DESTRUCTIVE (drops mirror columns).
 * Also revert the 080 code (import/services reference these columns). Guarded:
 * CONFIRM_ROLLBACK_080=YES; production also CONFIRM_ROLLBACK_080_PROD=YES + owner approval. */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const SQL = `
BEGIN;
  DROP INDEX IF EXISTS idx_organizations_google_place;
  ALTER TABLE organizations DROP COLUMN IF EXISTS description;
  ALTER TABLE organizations DROP COLUMN IF EXISTS lat;
  ALTER TABLE organizations DROP COLUMN IF EXISTS lng;
  ALTER TABLE organizations DROP COLUMN IF EXISTS google_place_id;
  ALTER TABLE organizations DROP COLUMN IF EXISTS bd_metadata;
  DELETE FROM schema_migrations WHERE filename = '080_directory_mirror_fields.sql';
COMMIT;
`;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (process.env.CONFIRM_ROLLBACK_080 !== 'YES') { console.error('REFUSE: set CONFIRM_ROLLBACK_080=YES (destructive).'); return 2; }
  if (raw.includes(PROD_EP) && process.env.CONFIRM_ROLLBACK_080_PROD !== 'YES') {
    console.error('REFUSE: PRODUCTION — also set CONFIRM_ROLLBACK_080_PROD=YES (and obtain owner approval).'); return 2;
  }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    console.log('ROLLBACK 080 on: ' + dbn + (raw.includes(PROD_EP) ? ' (PRODUCTION)' : ''));
    await c.query(SQL);
    const gone = (await c.query("SELECT count(*)::int c FROM information_schema.columns WHERE table_name='organizations' AND column_name='google_place_id'")).rows[0].c === 0;
    console.log('RESULT: ' + (gone ? 'ROLLED BACK' : 'FAIL'));
    return gone ? 0 : 1;
  } catch (e) { console.error('ROLLBACK FAILED:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
