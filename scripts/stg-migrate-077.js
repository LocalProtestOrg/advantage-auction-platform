#!/usr/bin/env node
/*
 * stg-migrate-077.js — STAGING-guarded apply of ONLY 077_tenant_foundation.sql.
 * Idempotent (schema_migrations ledger); additive; verifies tenant foundation + backfill.
 *   railway run --service advantage-staging node scripts/stg-migrate-077.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FILE = '077_tenant_foundation.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';

const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*) FROM capabilities)::int AS caps,
    (SELECT count(*) FROM organizations WHERE is_platform_tenant = true)::int AS platform_orgs,
    (SELECT count(*) FROM seller_profiles WHERE organization_id IS NULL)::int AS untenanted_sellers,
    (SELECT count(*) FROM auctions WHERE organization_id IS NULL)::int AS untenanted_auctions,
    (SELECT count(*) FROM organization_capabilities oc JOIN organizations o ON o.id = oc.organization_id
       WHERE o.is_platform_tenant = true)::int AS platform_caps
`)).rows[0];

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint. STAGING-only.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not the STAGING endpoint (${STG_EP}).`); return 2; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    if (await ledgerHas(c)) {
      console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    } else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 077 and recorded its ledger row.');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c);
    const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.caps === 12 && v.platform_orgs === 1
      && v.untenanted_sellers === 0 && v.untenanted_auctions === 0 && v.platform_caps === 12;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
