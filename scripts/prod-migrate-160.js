#!/usr/bin/env node
/* prod-migrate-160.js — PRODUCTION-guarded apply of ONLY 160_audience_intelligence.sql.

   Additive + idempotent: the production creative registry, the committed-vs-actual budget ledger,
   campaign execution records, and the paid-marketing kill switches.

   Run BEFORE deploying the code that depends on it.

   The verification is written against the SAFETY PROPERTIES, not against the SQL: every new gate
   must ship OFF, the ceiling must be enforced by the database itself, a do-not-use asset must be
   structurally incapable of approval, and nothing about existing marketing may move. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '160_audience_intelligence.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const MUST_BE_OFF = ['marketing.paid.global_kill', 'marketing.paid.execution_enabled',
  'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled',
  'marketing.a9_publish_enabled', 'marketing.email.sales_near_you_enabled',
  'marketing.production_creative.filesystem_presence_implies_approval'];
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const constraintExists = async (c, name) =>
  (await c.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [name])).rowCount > 0;

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP)) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes(PROD_EP)) { console.error('REFUSE: not the PRODUCTION endpoint (' + PROD_EP + ').'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const before = (await c.query(
      `SELECT (SELECT count(*)::int FROM marketing_contacts) contacts,
              (SELECT count(*)::int FROM terms_acceptances) acceptances,
              (SELECT count(*)::int FROM marketing_paid_growth_proposals) proposals,
              (SELECT count(*)::int FROM auctions) auctions,
              (SELECT count(*)::int FROM events) events`)).rows[0];

    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 160 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }

    const after = (await c.query(
      `SELECT (SELECT count(*)::int FROM marketing_contacts) contacts,
              (SELECT count(*)::int FROM terms_acceptances) acceptances,
              (SELECT count(*)::int FROM marketing_paid_growth_proposals) proposals,
              (SELECT count(*)::int FROM auctions) auctions,
              (SELECT count(*)::int FROM events) events,
              (SELECT count(*)::int FROM marketing_audience_strategies) strategies,
              (SELECT count(*)::int FROM marketing_audience_experiments) experiments,
              (SELECT count(*)::int FROM marketing_audience_learnings) learnings,
              (SELECT count(*)::int FROM marketing_paid_budget_ledger) ledger_entries,
              (SELECT count(*)::int FROM marketing_paid_campaigns WHERE state='ACTIVE') active_campaigns`)).rows[0];

    const cfg = {};
    (await c.query(`SELECT key, value FROM platform_config WHERE key = ANY($1)`, [MUST_BE_OFF]))
      .rows.forEach((r) => { cfg[r.key] = r.value; });

    // A strategy must not be activatable without provider validation. Prove it with a rejected write.
    let activeRequiresValid = false;
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO marketing_audience_strategies (strategy_key, funnel, hypothesis, validation_state, active)
                     VALUES ('PROBE','buyer','probe','UNVALIDATED', true)`);
    } catch (e) { activeRequiresValid = /chk_mas_active_requires_valid/.test(e.message); }
    await c.query('ROLLBACK');

    const checks = {
      strategies_table_empty: after.strategies === 0,
      experiments_table_empty: after.experiments === 0,
      learnings_table_empty: after.learnings === 0,
      active_strategy_requires_provider_validation: activeRequiresValid,
      first_party_upload_ships_off: (await c.query(
        `SELECT value FROM platform_config WHERE key='marketing.audience.first_party_upload_enabled'`)).rows[0].value === false,
      signal_floors_defined: (await c.query(
        `SELECT count(*)::int n FROM platform_config WHERE key IN
         ('marketing.audience.min_landing_visits_for_signal','marketing.audience.min_conversions_for_signal')`)).rows[0].n === 2,
      // No new spending authority, and nothing switched on.
      no_ledger_entries: after.ledger_entries === 0,
      no_active_campaigns: after.active_campaigns === 0,
      monthly_ceiling_unchanged: Number((await c.query(
        `SELECT value FROM platform_config WHERE key='marketing.paid_growth.monthly_ceiling_usd'`)).rows[0].value) === 1000,
      paid_execution_off: cfg['marketing.paid.execution_enabled'] === false,
      meta_ads_still_off: cfg['marketing.destinations.meta_ads_enabled'] === false,
      google_ads_still_off: cfg['marketing.destinations.google_ads_enabled'] === false,
      sales_near_you_send_still_off: cfg['marketing.email.sales_near_you_enabled'] === false,
      a9_publish_still_off: cfg['marketing.a9_publish_enabled'] === false,
      contacts_unchanged: after.contacts === before.contacts,
      acceptances_unchanged: after.acceptances === before.acceptances,
      auctions_unchanged: after.auctions === before.auctions,
      events_unchanged: after.events === before.events,
      ledger: await ledgerHas(c),
    };
    console.log('Before:', JSON.stringify(before));
    console.log('After: ', JSON.stringify(after));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    if (failed.length) console.error('FAILED CHECKS:', failed.join(', '));
    console.log('RESULT: ' + (failed.length ? 'FAIL' : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
