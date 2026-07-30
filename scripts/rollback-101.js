#!/usr/bin/env node
/* rollback-101.js — reverse 101_market_resolution.sql. DESTRUCTIVE (drops event_market_zips +
 * market_candidates, removes the 'national' market, reverts the houston/nyc_tristate center/radius
 * backfill to NULL — their pre-101 state). Only run when no imported events reference 'national'
 * (there are none until the importer runs). New tables have no existing read path → inert to the app.
 * Guarded: CONFIRM_ROLLBACK_101=YES; production also CONFIRM_ROLLBACK_101_PROD=YES + owner approval. */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const SQL = `
BEGIN;
  DROP TABLE IF EXISTS event_market_zips;
  DROP TABLE IF EXISTS market_candidates;
  DELETE FROM event_markets WHERE slug = 'national';
  UPDATE event_markets SET center_lat = NULL, center_lng = NULL, radius_km = NULL
   WHERE slug IN ('houston','nyc_tristate');
  DELETE FROM schema_migrations WHERE filename = '101_market_resolution.sql';
COMMIT;
`;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (process.env.CONFIRM_ROLLBACK_101 !== 'YES') { console.error('REFUSE: set CONFIRM_ROLLBACK_101=YES (destructive).'); return 2; }
  if (raw.includes(PROD_EP) && process.env.CONFIRM_ROLLBACK_101_PROD !== 'YES') {
    console.error('REFUSE: PRODUCTION — also set CONFIRM_ROLLBACK_101_PROD=YES (and obtain owner approval).'); return 2;
  }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    console.log('ROLLBACK 101 on: ' + dbn + (raw.includes(PROD_EP) ? ' (PRODUCTION)' : ''));
    await c.query(SQL);
    const gone = (await c.query("SELECT count(*)::int c FROM information_schema.tables WHERE table_name IN ('event_market_zips','market_candidates')")).rows[0].c === 0
      && (await c.query("SELECT count(*)::int c FROM event_markets WHERE slug='national'")).rows[0].c === 0;
    console.log('RESULT: ' + (gone ? 'ROLLED BACK' : 'FAIL'));
    return gone ? 0 : 1;
  } catch (e) { console.error('ROLLBACK FAILED:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
