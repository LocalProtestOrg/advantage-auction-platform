#!/usr/bin/env node
/* prod-migrate-153.js — PRODUCTION-guarded apply of ONLY 153_event_partner_authorization_foundation.sql.
   Additive + idempotent: the Event Partner authorization registry, its hashed single-use tokens, the
   secure organization-claim token foundation, events.host_organization_id, and the per-event /
   per-organization analytics columns.

   MUST RUN BEFORE the application deploy: the public event feed joins events.host_organization_id and
   analytics writes the two new columns, so code running against an unmigrated database would fail.

   Verification deliberately proves the mission's safety promises, not just that the SQL ran:
     - every new Owner gate is OFF (nothing can authorize, collect or send)
     - no import source was created, activated or re-owned
     - not a single historical event was reassigned or attributed
     - A15 exists and holds no publish/spend/review authority
     - the existing paid-growth and publishing gates are untouched */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '153_event_partner_authorization_foundation.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const NEW_GATES = ['event_partners.enabled', 'event_partners.collection_enabled', 'event_partners.outreach_enabled'];
// Pre-existing gates that this migration must not have disturbed.
const UNTOUCHED_OFF = ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled',
  'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled'];
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

    // Baseline BEFORE the change, so the "nothing moved" assertions below are real comparisons.
    const before = (await c.query(
      `SELECT (SELECT count(*)::int FROM import_sources) AS sources,
              (SELECT count(*)::int FROM import_sources WHERE status='active') AS active_sources,
              (SELECT count(*)::int FROM events) AS events,
              (SELECT count(*)::int FROM events WHERE status='published') AS published`)).rows[0];

    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      // The migration file carries its own BEGIN/COMMIT; send it as one statement batch.
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 153 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }

    const after = (await c.query(
      `SELECT (SELECT count(*)::int FROM import_sources) AS sources,
              (SELECT count(*)::int FROM import_sources WHERE status='active') AS active_sources,
              (SELECT count(*)::int FROM events) AS events,
              (SELECT count(*)::int FROM events WHERE status='published') AS published,
              (SELECT count(*)::int FROM authorized_event_sources) AS authorizations,
              (SELECT count(*)::int FROM event_partner_authorization_tokens) AS auth_tokens,
              (SELECT count(*)::int FROM organization_claim_tokens) AS claim_tokens,
              (SELECT count(*)::int FROM events WHERE host_organization_id IS NOT NULL) AS attributed_events,
              (SELECT count(*)::int FROM information_schema.columns
                WHERE table_name='analytics_events' AND column_name IN ('event_id','organization_id')) AS analytics_cols`)).rows[0];

    const gatesOn = (await c.query(
      `SELECT key FROM platform_config WHERE key = ANY($1) AND (value='true'::jsonb OR value='"true"'::jsonb)`, [NEW_GATES])).rows.map((r) => r.key);
    const strayOn = (await c.query(
      `SELECT key FROM platform_config WHERE key = ANY($1) AND (value='true'::jsonb OR value='"true"'::jsonb)`, [UNTOUCHED_OFF])).rows.map((r) => r.key);
    const minMetric = (await c.query(`SELECT value FROM platform_config WHERE key='event_partners.performance_min_metric'`)).rows[0];
    const claimPolicy = (await c.query(`SELECT value FROM platform_config WHERE key='organizations.claim_proof_policy'`)).rows[0];
    const a15 = (await c.query(`SELECT can_publish, can_spend, can_review, capabilities FROM marketing_agents WHERE code='A15'`)).rows[0];

    const checks = {
      tables_created: after.authorizations === 0 && after.auth_tokens === 0 && after.claim_tokens === 0,
      analytics_columns_added: after.analytics_cols === 2,
      // Nothing about collection changed: no new source, none newly activated.
      import_sources_unchanged: after.sources === before.sources && after.active_sources === before.active_sources,
      // Not one historical event was reassigned, published, unpublished or attributed.
      events_unchanged: after.events === before.events && after.published === before.published,
      no_event_attributed: after.attributed_events === 0,
      new_gates_all_off: gatesOn.length === 0,
      existing_gates_untouched: strayOn.length === 0,
      performance_minimum_is_100: minMetric && Number(minMetric.value) === 100,
      claim_proof_required: claimPolicy && /token/.test(JSON.stringify(claimPolicy.value)),
      a15_registered_and_powerless: !!a15 && a15.can_publish === false && a15.can_spend === false && a15.can_review === false,
      a15_cannot_send: !!a15 && !JSON.stringify(a15.capabilities).includes('send'),
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
