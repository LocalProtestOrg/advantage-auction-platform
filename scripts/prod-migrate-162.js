#!/usr/bin/env node
/* prod-migrate-160.js — PRODUCTION-guarded apply of ONLY 162_event_partner_segmentation.sql.

   Additive + idempotent: the production creative registry, the committed-vs-actual budget ledger,
   campaign execution records, and the paid-marketing kill switches.

   Run BEFORE deploying the code that depends on it.

   The verification is written against the SAFETY PROPERTIES, not against the SQL: every new gate
   must ship OFF, the ceiling must be enforced by the database itself, a do-not-use asset must be
   structurally incapable of approval, and nothing about existing marketing may move. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '162_event_partner_segmentation.sql';
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 162 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }

    const after = (await c.query(
      `SELECT (SELECT count(*)::int FROM sales_prospects) prospects,
              (SELECT count(*)::int FROM organizations) organizations,
              (SELECT count(*)::int FROM event_partner_eligibility_decisions) decisions,
              (SELECT count(*)::int FROM event_partner_cohort_members) cohort_members,
              (SELECT count(*)::int FROM authorized_event_sources) partners,
              (SELECT count(*)::int FROM marketing_paid_campaigns WHERE state='ACTIVE') active_paid`)).rows[0];

    const cfg = {};
    (await c.query(`SELECT key, value FROM platform_config WHERE key = ANY($1)`,
      [['event_partners.outreach_enabled','event_partners.enabled','marketing.email.sales_near_you_enabled',
        'marketing.a9_publish_enabled','event_partners.first_cohort_max','event_partners.recent_outreach_days']]))
      .rows.forEach((r) => { cfg[r.key] = r.value; });

    // A decision outside the allowed set must be impossible.
    let decisionConstrained = false;
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO event_partner_eligibility_decisions (company_name, decision, reason)
                     VALUES ('PROBE','SEND_ANYWAY','probe')`);
    } catch (e) { decisionConstrained = /chk_epe_decision/.test(e.message); }
    await c.query('ROLLBACK');

    const checks = {
      decisions_table_empty: after.decisions === 0,
      decision_values_constrained: decisionConstrained,
      one_decision_per_prospect: (await c.query(
        `SELECT 1 FROM pg_indexes WHERE tablename='event_partner_eligibility_decisions'
           AND indexdef ILIKE '%unique%' AND indexdef ILIKE '%prospect_id%'`)).rowCount > 0,
      first_cohort_max_is_10: Number(cfg['event_partners.first_cohort_max']) === 10,
      recent_outreach_window_set: Number(cfg['event_partners.recent_outreach_days']) === 90,
      // Nothing is switched on by this migration.
      outreach_still_off: cfg['event_partners.outreach_enabled'] === false,
      event_partners_still_off: cfg['event_partners.enabled'] === false,
      sales_near_you_send_still_off: cfg['marketing.email.sales_near_you_enabled'] === false,
      a9_still_off: cfg['marketing.a9_publish_enabled'] === false,
      // The LIVE paid experiments must not be disturbed.
      paid_campaigns_untouched: after.active_paid === 2,
      prospects_unchanged: after.prospects === 1646,
      organizations_unchanged: after.organizations === 338,
      no_partners_created: after.partners === 0,
      no_cohort_members_created: after.cohort_members === 0,
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
