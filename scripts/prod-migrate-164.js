#!/usr/bin/env node
/* prod-migrate-164.js — PRODUCTION-guarded apply of ONLY 164_tristate_in_home_market.sql.

   Verified against the SAFETY PROPERTIES: ceilings unchanged, Houston untouched and still the only
   ACTIVE market, NYC retired (not deleted, history versioned), the Tri-State market PREPARED and
   un-authorized with coverage PENDING, no market can be ACTIVE without Owner geography approval, no
   per-market money exists, and nothing in Event Partner outreach moved. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '164_tristate_in_home_market.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP)) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes(PROD_EP)) { console.error('REFUSE: not the PRODUCTION endpoint (' + PROD_EP + ').'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const snap = async () => (await c.query(
      `SELECT (SELECT count(*)::int FROM marketing_paid_campaigns) campaigns,
              (SELECT count(*)::int FROM marketing_paid_campaigns WHERE state='ACTIVE') active_paid,
              (SELECT count(*)::int FROM marketing_provider_objects) provider_objects,
              (SELECT count(*)::int FROM marketing_paid_budget_ledger) ledger_rows,
              (SELECT committed_cents FROM marketing_paid_budget_months WHERE month='2026-09-01') sept_committed,
              (SELECT count(*)::int FROM marketing_audience_experiments) experiments,
              (SELECT count(*)::int FROM event_partner_cohort_members) cohort_members`)).rows[0];
    const before = await snap();

    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 164 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const m = {};
    (await c.query('SELECT * FROM marketing_paid_markets')).rows.forEach((r) => { m[r.market_key] = r; });
    const cfg = {};
    (await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'marketing.paid%' OR key LIKE 'event_partners.%'`)).rows.forEach((r) => { cfg[r.key] = r.value; });

    // An un-approved geography can never be ACTIVE (database-enforced).
    let coverageGuard = false;
    await c.query('BEGIN');
    try {
      await c.query(`UPDATE marketing_paid_markets SET launch_authorized=true, geo_validation='VALID' WHERE market_key='ny_tristate'`);
      await c.query(`UPDATE marketing_paid_markets SET status='ACTIVE' WHERE market_key='ny_tristate'`);
    } catch (e) { coverageGuard = /chk_mpm_active_requires_coverage/.test(e.message); }
    await c.query('ROLLBACK');

    const checks = {
      ledger: await ledgerHas(c),
      monthly_ceiling_1000: Number(cfg['marketing.paid_growth.monthly_ceiling_usd']) === 1000,
      campaign_ceiling_400: Number(cfg['marketing.paid_growth.campaign_ceiling_usd']) === 400,
      houston_active_and_approved: m.houston && m.houston.status === 'ACTIVE' && m.houston.coverage_approval === 'OWNER_APPROVED',
      tristate_prepared: m.ny_tristate && m.ny_tristate.status === 'PREPARED' && m.ny_tristate.launch_authorized === false,
      tristate_coverage_pending: m.ny_tristate && m.ny_tristate.coverage_approval === 'PENDING_OWNER_GEOGRAPHY_APPROVAL',
      tristate_no_allocation: m.ny_tristate && m.ny_tristate.allocation_cents === null,
      nyc_retired_not_deleted: m.nyc && m.nyc.status === 'RETIRED' && m.nyc.superseded_by === 'ny_tristate',
      nyc_history_versioned: (await c.query(`SELECT 1 FROM marketing_paid_market_versions WHERE market_key='nyc'`)).rowCount === 1,
      active_requires_owner_geography: coverageGuard,
      no_per_market_money: (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='marketing_paid_markets' AND column_name ILIKE '%ceiling%'`)).rowCount === 0,
      campaigns_unchanged: after.campaigns === before.campaigns && after.active_paid === before.active_paid,
      provider_objects_unchanged: after.provider_objects === before.provider_objects,
      ledger_unchanged: after.ledger_rows === before.ledger_rows && after.sept_committed === before.sept_committed,
      experiments_unchanged: after.experiments === before.experiments,
      kill_off_unchanged: cfg['marketing.paid.global_kill'] === false,
      ep_collection_off: cfg['event_partners.collection_enabled'] === false,
      ep_inbound_off: cfg['event_partners.inbound_enabled'] === false,
      ep_members_unchanged: after.cohort_members === before.cohort_members,
    };
    console.log('Before:', JSON.stringify(before));
    console.log('After: ', JSON.stringify(after));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    if (failed.length) console.error('FAILED CHECKS:', failed.join(', '));
    console.log('RESULT: ' + (failed.length ? 'FAIL' : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
