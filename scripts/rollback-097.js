#!/usr/bin/env node
/* rollback-097.js — reverse 097_import_sources.sql. DESTRUCTIVE (drops import_sources).
 * Run rollback-098 FIRST — import_runs FK-references import_sources, so this plain DROP (no CASCADE)
 * fails safely if the 098 tables still exist, forcing the correct order. import_sources is a new table
 * with no existing read path, so a rollback is inert to the rest of the app.
 * Guarded: CONFIRM_ROLLBACK_097=YES; production also CONFIRM_ROLLBACK_097_PROD=YES + owner approval. */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const SQL = `
BEGIN;
  DROP TABLE IF EXISTS import_sources;
  DELETE FROM schema_migrations WHERE filename = '097_import_sources.sql';
COMMIT;
`;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (process.env.CONFIRM_ROLLBACK_097 !== 'YES') { console.error('REFUSE: set CONFIRM_ROLLBACK_097=YES (destructive).'); return 2; }
  if (raw.includes(PROD_EP) && process.env.CONFIRM_ROLLBACK_097_PROD !== 'YES') {
    console.error('REFUSE: PRODUCTION — also set CONFIRM_ROLLBACK_097_PROD=YES (and obtain owner approval).'); return 2;
  }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    console.log('ROLLBACK 097 on: ' + dbn + (raw.includes(PROD_EP) ? ' (PRODUCTION)' : ''));
    await c.query(SQL);
    const gone = (await c.query("SELECT count(*)::int c FROM information_schema.tables WHERE table_name='import_sources'")).rows[0].c === 0;
    console.log('RESULT: ' + (gone ? 'ROLLED BACK' : 'FAIL'));
    return gone ? 0 : 1;
  } catch (e) { console.error('ROLLBACK FAILED:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
