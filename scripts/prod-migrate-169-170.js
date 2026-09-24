#!/usr/bin/env node
/* prod-migrate-169-170.js — PRODUCTION-guarded apply of 169_company_identity_and_journeys.sql and
   170_claimed_listing_system.sql (Claimed Listing). Both are additive and idempotent.

   Verifies: both recorded; the one-active-journey index exists; EP decision vocabulary gains
   EXCLUDE_LISTING_JOURNEY; the claimed_listing mail stream is allowed; EVERY Claimed Listing switch is OFF
   and the postal address is empty; no Event Partner row, event, organization, member, seller profile or
   pricing agreement changed (row counts + hashes); nothing was sent (no listing message rows). */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILES = ['169_company_identity_and_journeys.sql', '170_claimed_listing_system.sql'];
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  const hash = async (sql) => (await c.query(`SELECT count(*)::int n, md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) h FROM (${sql}) t`)).rows[0];
  try {
    const snap = async () => ({
      events: await hash('SELECT id, status, organization_id, host_organization_id, updated_at FROM events'),
      organizations: await hash('SELECT id, name, lifecycle_state, contact_email, website_url, profile_data, bd_listing_id FROM organizations'),
      members: await hash('SELECT * FROM organization_members'),
      seller_profiles: await hash('SELECT id, seller_type, platform_fee_bps, organization_id FROM seller_profiles'),
      pricing: await hash('SELECT * FROM professional_pricing_agreements'),
      ep_sources: await hash('SELECT * FROM authorized_event_sources'),
      ep_members: await hash('SELECT * FROM event_partner_cohort_members'),
      ep_decisions: await hash('SELECT * FROM event_partner_eligibility_decisions'),
      claim_tokens: await hash('SELECT id, used_at FROM organization_claim_tokens'),
    });
    const before = await snap();
    for (const f of FILES) {
      const done = (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [f])).rowCount > 0;
      if (done) { console.log('SKIP (already recorded):', f); continue; }
      try {
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        console.log('APPLIED', f);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', f, e.message); return 1; }
    }
    const after = await snap();
    const cfg = (await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'claimed_listings.%' OR key = 'company.postal_address'`)).rows
      .reduce((m, r) => { m[r.key] = r.value; return m; }, {});
    const same = (k) => before[k].n === after[k].n && before[k].h === after[k].h;
    const checks = {
      recorded: (await c.query('SELECT count(*)::int n FROM schema_migrations WHERE filename = ANY($1)', [FILES])).rows[0].n === 2,
      one_active_journey_index: (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_one_active_journey'`)).rowCount === 1,
      ep_vocabulary_has_listing_journey: (await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'chk_epe_decision'`)).rows[0].d.includes('EXCLUDE_LISTING_JOURNEY'),
      claimed_listing_stream_allowed: (await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'chk_ses_feedback_mail_stream'`)).rows[0].d.includes('claimed_listing'),
      template_immutability_trigger: (await c.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'trg_listing_template_immutable'`)).rowCount === 1,
      sending_off: cfg['claimed_listings.sending_enabled'] === false,
      inbound_off: cfg['claimed_listings.inbound_enabled'] === false,
      activation_reminders_off: cfg['claimed_listings.activation_emails_enabled'] === false,
      self_request_off: cfg['claimed_listings.self_request_enabled'] === false,
      postal_address_empty: cfg['company.postal_address'] === '',
      paid_badge_list_41: Array.isArray(cfg['claimed_listings.paid_badge_bd_listing_ids']) && cfg['claimed_listings.paid_badge_bd_listing_ids'].length === 41,
      nothing_sent: (await c.query(`SELECT count(*)::int n FROM listing_outreach_messages`)).rows[0].n === 0,
      events_unchanged: same('events'), organizations_unchanged: same('organizations'), members_unchanged: same('members'),
      seller_profiles_unchanged: same('seller_profiles'), pricing_unchanged: same('pricing'),
      event_partner_unchanged: same('ep_sources') && same('ep_members') && same('ep_decisions'),
      claim_tokens_unchanged: same('claim_tokens'),
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
