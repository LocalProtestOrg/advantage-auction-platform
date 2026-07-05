#!/usr/bin/env node
/*
 * rollback-077.js — reverse 077_tenant_foundation.sql (Tenant Foundation).
 *
 * DESTRUCTIVE (drops the additive columns/tables + removes the seeded platform tenant).
 * Guarded: requires CONFIRM_ROLLBACK_077=YES; against the PRODUCTION endpoint it ALSO
 * requires CONFIRM_ROLLBACK_077_PROD=YES. Runs inside a single transaction. Prefer a
 * Neon backup restore for production; this exists for fast, scoped reversal on staging.
 *
 *   railway run --service advantage-staging node scripts/rollback-077.js            # staging (with CONFIRM_ROLLBACK_077=YES)
 *   (production requires both confirmation env vars AND explicit owner approval)
 */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const SQL = `
BEGIN;
  DELETE FROM organizations WHERE is_platform_tenant = true;          -- cascades members + capabilities
  ALTER TABLE auctions        DROP COLUMN IF EXISTS organization_id;   -- removes backfill
  ALTER TABLE seller_profiles DROP COLUMN IF EXISTS organization_id;
  ALTER TABLE organizations   DROP COLUMN IF EXISTS is_platform_tenant;
  ALTER TABLE organizations   DROP COLUMN IF EXISTS primary_domain;
  ALTER TABLE organizations   DROP COLUMN IF EXISTS custom_domains;
  DROP TABLE IF EXISTS organization_capabilities;
  DROP TABLE IF EXISTS capabilities;
  DELETE FROM schema_migrations WHERE filename = '077_tenant_foundation.sql';
COMMIT;
`;
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (process.env.CONFIRM_ROLLBACK_077 !== 'YES') { console.error('REFUSE: set CONFIRM_ROLLBACK_077=YES to proceed (destructive).'); return 2; }
  if (raw.includes(PROD_EP) && process.env.CONFIRM_ROLLBACK_077_PROD !== 'YES') {
    console.error('REFUSE: PRODUCTION endpoint — also set CONFIRM_ROLLBACK_077_PROD=YES (and obtain owner approval).'); return 2;
  }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const dbn = (await c.query('SELECT current_database() d')).rows[0].d;
    console.log('ROLLBACK 077 on database: ' + dbn + (raw.includes(PROD_EP) ? ' (PRODUCTION)' : ''));
    await c.query(SQL);
    const gone = (await c.query("SELECT to_regclass('public.capabilities') AS t")).rows[0].t === null;
    console.log('RESULT: ' + (gone ? 'ROLLED BACK (capabilities dropped, ledger cleared)' : 'FAIL — capabilities still present'));
    return gone ? 0 : 1;
  } catch (e) { console.error('ROLLBACK FAILED:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
