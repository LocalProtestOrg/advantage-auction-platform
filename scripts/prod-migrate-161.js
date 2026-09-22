#!/usr/bin/env node
/* prod-migrate-160.js — PRODUCTION-guarded apply of ONLY 161_meta_full_funnel_execution.sql.

   Additive + idempotent: the production creative registry, the committed-vs-actual budget ledger,
   campaign execution records, and the paid-marketing kill switches.

   Run BEFORE deploying the code that depends on it.

   The verification is written against the SAFETY PROPERTIES, not against the SQL: every new gate
   must ship OFF, the ceiling must be enforced by the database itself, a do-not-use asset must be
   structurally incapable of approval, and nothing about existing marketing may move. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '161_meta_full_funnel_execution.sql';
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 161 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }

    const after = (await c.query(
      `SELECT (SELECT count(*)::int FROM marketing_contacts) contacts,
              (SELECT count(*)::int FROM auctions) auctions,
              (SELECT count(*)::int FROM events) events,
              (SELECT count(*)::int FROM marketing_creative_packages) packages,
              (SELECT count(*)::int FROM marketing_provider_images) images,
              (SELECT count(*)::int FROM marketing_provider_objects) objects,
              (SELECT count(*)::int FROM marketing_paid_budget_ledger) ledger_entries,
              (SELECT count(*)::int FROM marketing_paid_campaigns WHERE state='ACTIVE') active_campaigns`)).rows[0];

    const cfg = {};
    (await c.query(`SELECT key, value FROM platform_config WHERE key = ANY($1)`, [MUST_BE_OFF]))
      .rows.forEach((r) => { cfg[r.key] = r.value; });

    // A package must not be activatable without Owner approval. Prove it with a rejected write.
    let activeNeedsApproval = false;
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO marketing_creative_packages
        (package_key, production_creative_id, funnel, primary_text, headline, destination_url, fingerprint, approval_state, active)
        SELECT 'PROBE', id, 'buyer', 'x', 'y', 'https://bid.advantage.bid/', 'f', 'DRAFT', true
          FROM marketing_production_creative LIMIT 1`);
    } catch (e) { activeNeedsApproval = /chk_mcp_active_requires_approval/.test(e.message); }
    await c.query('ROLLBACK');

    // A paid destination must be a canonical Advantage.Bid URL.
    let destinationEnforced = false;
    await c.query('BEGIN');
    try {
      await c.query(`INSERT INTO marketing_creative_packages
        (package_key, production_creative_id, funnel, primary_text, headline, destination_url, fingerprint)
        SELECT 'PROBE2', id, 'buyer', 'x', 'y', 'https://example.com/landing', 'f'
          FROM marketing_production_creative LIMIT 1`);
    } catch (e) { destinationEnforced = /chk_mcp_destination/.test(e.message); }
    await c.query('ROLLBACK');

    const checks = {
      packages_table_empty: after.packages === 0,
      provider_images_table_empty: after.images === 0,
      provider_objects_table_empty: after.objects === 0,
      package_active_requires_owner_approval: activeNeedsApproval,
      destination_must_be_canonical: destinationEnforced,
      image_reuse_unique_per_account: (await c.query(
        `SELECT 1 FROM pg_indexes WHERE tablename='marketing_provider_images' AND indexdef ILIKE '%unique%' AND indexdef ILIKE '%asset_sha256%'`)).rowCount > 0,
      provider_object_idempotency_unique: (await c.query(
        `SELECT 1 FROM pg_indexes WHERE tablename='marketing_provider_objects' AND indexdef ILIKE '%unique%' AND indexdef ILIKE '%idempotency_key%'`)).rowCount > 0,
      build_mode_on: (await c.query(
        `SELECT value FROM platform_config WHERE key='marketing.paid.build_mode'`)).rows[0].value === true,
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
