#!/usr/bin/env node
/* prod-migrate-159.js — PRODUCTION-guarded apply of ONLY 159_paid_execution_and_production_creative.sql.

   Additive + idempotent: the production creative registry, the committed-vs-actual budget ledger,
   campaign execution records, and the paid-marketing kill switches.

   Run BEFORE deploying the code that depends on it.

   The verification is written against the SAFETY PROPERTIES, not against the SQL: every new gate
   must ship OFF, the ceiling must be enforced by the database itself, a do-not-use asset must be
   structurally incapable of approval, and nothing about existing marketing may move. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '159_paid_execution_and_production_creative.sql';
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 159 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }

    const after = (await c.query(
      `SELECT (SELECT count(*)::int FROM marketing_contacts) contacts,
              (SELECT count(*)::int FROM terms_acceptances) acceptances,
              (SELECT count(*)::int FROM marketing_paid_growth_proposals) proposals,
              (SELECT count(*)::int FROM auctions) auctions,
              (SELECT count(*)::int FROM events) events,
              (SELECT count(*)::int FROM marketing_production_creative) creative,
              (SELECT count(*)::int FROM marketing_paid_campaigns) campaigns,
              (SELECT count(*)::int FROM marketing_paid_budget_ledger) ledger_entries,
              (SELECT count(*)::int FROM marketing_paid_budget_months) budget_months`)).rows[0];

    const cfg = {};
    (await c.query(`SELECT key, value FROM platform_config WHERE key = ANY($1)`, [MUST_BE_OFF]))
      .rows.forEach((r) => { cfg[r.key] = r.value; });

    // Prove the ceiling is enforced by the DATABASE, not merely by application code: attempt to
    // commit past a ceiling inside a savepoint and require the write to be rejected.
    let ceilingEnforced = false;
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO marketing_paid_budget_months (month, ceiling_cents, committed_cents)
                     VALUES ('1999-01-01', 1000, 5000)`);
    } catch (e) {
      ceilingEnforced = /chk_mpbm_within_ceiling/.test(e.message);
    }
    await c.query('ROLLBACK');

    // Prove a do-not-use asset cannot be recorded as approved.
    let doNotUseEnforced = false;
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO marketing_production_creative
        (asset_key, sha256, filename, relative_path, category, owner_approved_for_production, production_eligible)
        VALUES ('PROBE','x','x.png','do-not-use/x.png','do-not-use', true, true)`);
    } catch (e) {
      doNotUseEnforced = /chk_mpc_do_not_use_never_approved/.test(e.message);
    }
    await c.query('ROLLBACK');

    const checks = {
      registry_table: after.creative === 0,
      campaigns_table: after.campaigns === 0,
      ledger_table: after.ledger_entries === 0,
      budget_months_table: after.budget_months === 0,
      // Safety properties enforced by the schema.
      monthly_ceiling_enforced_by_database: ceilingEnforced,
      do_not_use_cannot_be_approved: doNotUseEnforced,
      eligible_requires_approval_constraint: await constraintExists(c, 'chk_mpc_eligible_requires_approval'),
      active_campaign_must_name_creative: await constraintExists(c, 'chk_mpcam_active_is_complete'),
      ledger_idempotency_unique: (await c.query(
        `SELECT 1 FROM pg_indexes WHERE tablename='marketing_paid_budget_ledger' AND indexdef ILIKE '%unique%' AND indexdef ILIKE '%idempotency_key%'`)).rowCount > 0,
      // Every new gate ships OFF, and nothing previously off turned on.
      global_kill_defined_and_off: cfg['marketing.paid.global_kill'] === false,
      paid_execution_off: cfg['marketing.paid.execution_enabled'] === false,
      meta_ads_still_off: cfg['marketing.destinations.meta_ads_enabled'] === false,
      google_ads_still_off: cfg['marketing.destinations.google_ads_enabled'] === false,
      a9_publish_still_off: cfg['marketing.a9_publish_enabled'] === false,
      sales_near_you_send_still_off: cfg['marketing.email.sales_near_you_enabled'] === false,
      presence_never_implies_approval: cfg['marketing.production_creative.filesystem_presence_implies_approval'] === false,
      // Nothing else moved.
      contacts_unchanged: after.contacts === before.contacts,
      acceptances_unchanged: after.acceptances === before.acceptances,
      proposals_unchanged: after.proposals === before.proposals,
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
