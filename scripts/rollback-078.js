#!/usr/bin/env node
/*
 * rollback-078.js — reverse 078_partner_foundation.sql. DESTRUCTIVE (drops new tables + auction columns).
 * Guarded: CONFIRM_ROLLBACK_078=YES; against production also CONFIRM_ROLLBACK_078_PROD=YES + owner approval.
 * Prefer a Neon backup restore for production.
 */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const SQL = `
BEGIN;
  ALTER TABLE auctions DROP COLUMN IF EXISTS is_syndicated;
  ALTER TABLE auctions DROP COLUMN IF EXISTS marketplace_status;
  ALTER TABLE auctions DROP COLUMN IF EXISTS is_featured;
  ALTER TABLE auctions DROP COLUMN IF EXISTS is_promoted;
  ALTER TABLE auctions DROP COLUMN IF EXISTS marketplace_updated_at;
  ALTER TABLE auctions DROP COLUMN IF EXISTS marketplace_updated_by;
  DROP TABLE IF EXISTS legal_acceptances;
  DROP TABLE IF EXISTS legal_document_versions;
  DROP TABLE IF EXISTS legal_documents;
  DROP TABLE IF EXISTS organization_config;
  DROP TABLE IF EXISTS platform_config;
  DROP TABLE IF EXISTS plan_capabilities;
  -- capability GRANTS from 078 backfill remain (source='plan') on organization_capabilities;
  -- they are harmless and re-derivable. Remove explicitly if a full reversal is required.
  DELETE FROM schema_migrations WHERE filename = '078_partner_foundation.sql';
COMMIT;
`;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (process.env.CONFIRM_ROLLBACK_078 !== 'YES') { console.error('REFUSE: set CONFIRM_ROLLBACK_078=YES (destructive).'); return 2; }
  if (raw.includes(PROD_EP) && process.env.CONFIRM_ROLLBACK_078_PROD !== 'YES') {
    console.error('REFUSE: PRODUCTION — also set CONFIRM_ROLLBACK_078_PROD=YES (and obtain owner approval).'); return 2;
  }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    console.log('ROLLBACK 078 on: ' + dbn + (raw.includes(PROD_EP) ? ' (PRODUCTION)' : ''));
    await c.query(SQL);
    const gone = (await c.query("SELECT to_regclass('public.plan_capabilities') AS t")).rows[0].t === null;
    console.log('RESULT: ' + (gone ? 'ROLLED BACK' : 'FAIL'));
    return gone ? 0 : 1;
  } catch (e) { console.error('ROLLBACK FAILED:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
