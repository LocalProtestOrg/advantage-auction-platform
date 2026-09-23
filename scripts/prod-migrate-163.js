#!/usr/bin/env node
/* prod-migrate-163.js — PRODUCTION-guarded apply of ONLY 163_paid_spend_governance.sql.

   Additive + idempotent: markets (Houston ACTIVE, NYC PREPARED), spend-sync evidence, ledger audit
   columns, internal-record flags (the Owner's own subscription), touch user-agent class, and the
   pacing / freshness configuration.

   Run BEFORE deploying the code that depends on it (conversions and touches write the new columns).

   Verified against the SAFETY PROPERTIES: the Owner's ceilings are unchanged, no new authority
   exists anywhere, NYC cannot launch, the live Houston campaigns are untouched, and the Owner's
   subscription still exists — only its reporting classification changed. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '163_paid_spend_governance.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const OWNER_CONTACT = '28904056-bf01-4438-86c0-167a72da1b02';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP)) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes(PROD_EP)) { console.error('REFUSE: not the PRODUCTION endpoint (' + PROD_EP + ').'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const snap = async () => (await c.query(
      `SELECT (SELECT count(*)::int FROM marketing_contacts) contacts,
              (SELECT count(*)::int FROM marketing_conversion_events) conversions,
              (SELECT count(*)::int FROM marketing_paid_campaigns WHERE state='ACTIVE') active_paid,
              (SELECT count(*)::int FROM marketing_paid_budget_ledger) ledger_rows,
              (SELECT committed_cents FROM marketing_paid_budget_months WHERE month='2026-09-01') sept_committed,
              (SELECT ceiling_cents FROM marketing_paid_budget_months WHERE month='2026-09-01') sept_ceiling,
              (SELECT count(*)::int FROM event_partner_cohort_members) cohort_members`)).rows[0];
    const before = await snap();

    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 163 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();

    const cfg = {};
    (await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'marketing.paid%' OR key LIKE 'marketing.destinations.%'
                     OR key IN ('marketing.email.sales_near_you_enabled','event_partners.collection_enabled','event_partners.inbound_enabled')`))
      .rows.forEach((r) => { cfg[r.key] = r.value; });
    const markets = {};
    (await c.query('SELECT * FROM marketing_paid_markets')).rows.forEach((m) => { markets[m.market_key] = m; });
    const owner = (await c.query('SELECT is_internal, internal_reason FROM marketing_contacts WHERE id=$1', [OWNER_CONTACT])).rows[0];
    const ownerConv = (await c.query(`SELECT count(*)::int n FROM marketing_conversion_events WHERE is_internal = true`)).rows[0].n;
    const houstonCampaigns = (await c.query(
      `SELECT count(*)::int n FROM marketing_paid_campaigns WHERE market_key='houston'
          AND campaign_key IN ('2026-10-individual-seller-houston','2026-10-professional-seller-houston')`)).rows[0].n;

    // A market can never be ACTIVE without authorization + validated geography (database-enforced).
    let activeGuard = false;
    await c.query('BEGIN');
    try { await c.query(`UPDATE marketing_paid_markets SET status='ACTIVE' WHERE market_key='nyc'`); }
    catch (e) { activeGuard = /chk_mpm_active_requires_authority/.test(e.message); }
    await c.query('ROLLBACK');

    const perMarketCeilingColumn = (await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='marketing_paid_markets' AND column_name ILIKE '%ceiling%'`)).rowCount > 0;

    const checks = {
      ledger: await ledgerHas(c),
      // Owner authority unchanged.
      monthly_ceiling_1000: Number(cfg['marketing.paid_growth.monthly_ceiling_usd']) === 1000,
      campaign_ceiling_400: Number(cfg['marketing.paid_growth.campaign_ceiling_usd']) === 400,
      daily_plan_50_unchanged: Number(cfg['marketing.paid_growth.daily_ceiling_usd']) === 50,
      sept_ceiling_unchanged: after.sept_ceiling === before.sept_ceiling,
      sept_commitment_unchanged: after.sept_committed === before.sept_committed,
      ledger_rows_unchanged: after.ledger_rows === before.ledger_rows,
      // Live experiment untouched and attributed to its market.
      houston_campaigns_still_active: after.active_paid === before.active_paid,
      houston_campaigns_in_houston_market: houstonCampaigns === 2,
      houston_market_active: markets.houston && markets.houston.status === 'ACTIVE' && markets.houston.geo_validation === 'VALID',
      // NYC prepared, cannot launch, creates no money.
      nyc_prepared_only: markets.nyc && markets.nyc.status === 'PREPARED' && markets.nyc.launch_authorized === false,
      nyc_has_no_allocation: markets.nyc && markets.nyc.allocation_cents === null,
      no_per_market_ceiling_column: !perMarketCeilingColumn,
      active_market_requires_authority: activeGuard,
      // Owner subscription preserved, reclassified.
      owner_subscription_preserved: after.contacts === before.contacts && !!owner,
      owner_marked_internal: !!owner && owner.is_internal === true && owner.internal_reason === 'owner_account',
      owner_conversion_marked_internal: ownerConv >= 1,
      conversions_preserved: after.conversions === before.conversions,
      // Nothing switched on or off.
      auto_pause_on: cfg['marketing.paid.auto_pause_on_breach'] === true,
      safety_factor_075: Number(cfg['marketing.paid.pacing.daily_budget_safety_factor']) === 0.75,
      kill_unchanged: cfg['marketing.paid.global_kill'] === false,
      google_ads_still_off: cfg['marketing.destinations.google_ads_enabled'] === false,
      sales_near_you_send_still_off: cfg['marketing.email.sales_near_you_enabled'] === false,
      ep_collection_still_off: cfg['event_partners.collection_enabled'] === false,
      ep_inbound_still_off: cfg['event_partners.inbound_enabled'] === false,
      no_event_partner_change: after.cohort_members === before.cohort_members,
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
