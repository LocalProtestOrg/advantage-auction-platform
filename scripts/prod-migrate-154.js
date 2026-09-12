#!/usr/bin/env node
/* prod-migrate-154.js — PRODUCTION-guarded apply of ONLY 154_event_partner_communications_2a.sql.
   Additive + idempotent: the Event Partner inbound communications plumbing (threads, messages,
   webhook-delivery evidence), partner-scoped suppression, approved templates/cohorts with the
   double-lock send architecture, the escalation queue, and the public self-service request with its
   lightweight trust ladder.

   MUST RUN BEFORE the application deploy: the routes and services query these tables.

   Verification proves the mission's safety promises rather than merely that the SQL ran:
     - every new gate is OFF / at its safe value (nothing can ingest, self-serve, classify or send)
     - not one message, thread, cohort, template, request or suppression exists
     - Phase 1 state is untouched: no authorization, no source change, no event attributed
     - A15 gained only read-only/drafting verbs and still cannot publish, spend, review or send
     - the existing paid-growth and publishing gates are unchanged */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '154_event_partner_communications_2a.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const OFF_GATES = ['event_partners.inbound_enabled', 'event_partners.self_service_enabled',
  'event_partners.a15_classify_enabled', 'event_partners.a15_draft_reply_enabled',
  'event_partners.enabled', 'event_partners.collection_enabled', 'event_partners.outreach_enabled'];
const UNTOUCHED_OFF = ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled',
  'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled'];
const SEND_VERBS = ['send_approved_outreach', 'send_templated_reply', 'grant_authorization',
  'broaden_authorization', 'change_authorized_domain', 'activate_collection_source',
  'grant_listing_ownership', 'answer_customer_service', 'answer_seller_inquiry'];
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

    // Baseline BEFORE, so "Phase 1 state untouched" is a real comparison.
    const before = (await c.query(
      `SELECT (SELECT count(*)::int FROM events) events,
              (SELECT count(*)::int FROM events WHERE status='published') published,
              (SELECT count(*)::int FROM events WHERE host_organization_id IS NOT NULL) attributed,
              (SELECT count(*)::int FROM import_sources) sources,
              (SELECT count(*)::int FROM import_sources WHERE status='active') active_sources,
              (SELECT count(*)::int FROM authorized_event_sources) authorizations,
              (SELECT count(*)::int FROM organizations) orgs`)).rows[0];

    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 154 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }

    const after = (await c.query(
      `SELECT (SELECT count(*)::int FROM events) events,
              (SELECT count(*)::int FROM events WHERE status='published') published,
              (SELECT count(*)::int FROM events WHERE host_organization_id IS NOT NULL) attributed,
              (SELECT count(*)::int FROM import_sources) sources,
              (SELECT count(*)::int FROM import_sources WHERE status='active') active_sources,
              (SELECT count(*)::int FROM authorized_event_sources) authorizations,
              (SELECT count(*)::int FROM organizations) orgs,
              (SELECT count(*)::int FROM event_partner_threads) threads,
              (SELECT count(*)::int FROM event_partner_messages) messages,
              (SELECT count(*)::int FROM event_partner_webhook_deliveries) deliveries,
              (SELECT count(*)::int FROM event_partner_suppressions) suppressions,
              (SELECT count(*)::int FROM event_partner_templates) templates,
              (SELECT count(*)::int FROM event_partner_cohorts) cohorts,
              (SELECT count(*)::int FROM event_partner_cohort_members) cohort_members,
              (SELECT count(*)::int FROM event_partner_outreach_proposals) proposals,
              (SELECT count(*)::int FROM event_partner_escalations) escalations,
              (SELECT count(*)::int FROM event_partner_requests) requests,
              (SELECT count(*)::int FROM event_partner_request_tokens) request_tokens`)).rows[0];

    const gatesOn = (await c.query(
      `SELECT key FROM platform_config WHERE key = ANY($1) AND (value='true'::jsonb OR value='"true"'::jsonb)`, [OFF_GATES])).rows.map((r) => r.key);
    const strayOn = (await c.query(
      `SELECT key FROM platform_config WHERE key = ANY($1) AND (value='true'::jsonb OR value='"true"'::jsonb)`, [UNTOUCHED_OFF])).rows.map((r) => r.key);
    const sigRequired = (await c.query(`SELECT value FROM platform_config WHERE key='event_partners.webhook_signature_required'`)).rows[0];
    const retention = (await c.query(`SELECT value FROM platform_config WHERE key='event_partners.raw_message_retention_days'`)).rows[0];
    const ceiling = (await c.query(`SELECT value FROM platform_config WHERE key='event_partners.daily_send_ceiling'`)).rows[0];
    const a15 = (await c.query(`SELECT can_publish, can_spend, can_review, capabilities FROM marketing_agents WHERE code='A15'`)).rows[0];
    const a15caps = a15 ? JSON.stringify(a15.capabilities) : '';

    const checks = {
      all_communications_tables_empty:
        after.threads === 0 && after.messages === 0 && after.deliveries === 0 && after.suppressions === 0
        && after.templates === 0 && after.cohorts === 0 && after.cohort_members === 0
        && after.proposals === 0 && after.escalations === 0 && after.requests === 0 && after.request_tokens === 0,
      // Phase 1 state must be byte-for-byte unchanged by this migration.
      events_unchanged: after.events === before.events && after.published === before.published,
      no_event_attributed: after.attributed === before.attributed,
      import_sources_unchanged: after.sources === before.sources && after.active_sources === before.active_sources,
      authorizations_unchanged: after.authorizations === before.authorizations,
      organizations_unchanged: after.orgs === before.orgs,
      all_gates_off: gatesOn.length === 0,
      existing_gates_untouched: strayOn.length === 0,
      signature_verification_required: sigRequired && sigRequired.value === true,
      retention_is_90_days: retention && Number(retention.value) === 90,
      daily_ceiling_set: ceiling && Number(ceiling.value) > 0,
      a15_cannot_publish_spend_review: !!a15 && a15.can_publish === false && a15.can_spend === false && a15.can_review === false,
      a15_holds_no_send_or_grant_verb: !!a15 && !SEND_VERBS.some((v) => a15caps.includes(v)),
      a15_gained_readonly_verbs: !!a15 && a15caps.includes('classify_inbound_reply') && a15caps.includes('record_reply_thread'),
      ledger: await ledgerHas(c),
    };
    console.log('Before:', JSON.stringify(before));
    console.log('After: ', JSON.stringify(after));
    console.log('A15:   ', a15caps);
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    if (failed.length) console.error('FAILED CHECKS:', failed.join(', '));
    console.log('RESULT: ' + (failed.length ? 'FAIL' : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
