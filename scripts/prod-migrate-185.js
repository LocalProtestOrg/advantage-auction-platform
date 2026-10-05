#!/usr/bin/env node
/* prod-migrate-185.js — PRODUCTION-guarded apply of ONLY 185_founding_auction_partners.sql (Founding Auction Partner
   foundation: FOUNDING_PARTNER journey, two screening decisions, the founding_partners table, auctions.founding_partner_id).
   Verifies the schema landed and that NOTHING else changed: no platform_config value (fees, switches), no seller rate,
   no journey assignment, no contact lock, no cohort member, no outreach sequence, no auction pricing. */
const fs = require('fs'); const path = require('path');
const FILE = '185_founding_auction_partners.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  // Direct (non-pooler) connection for DDL, through the project's own connection module.
  process.env.DATABASE_URL = raw.replace('-pooler', '');
  const db = require('../src/db');
  const c = await db.connect();
  try {
    const h = async (sql) => (await c.query(sql)).rows[0].h;
    const snap = async () => ({
      config: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config`),
      seller_fees: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(platform_fee_bps::text,'null'), ',' ORDER BY id), '')) h FROM seller_profiles`),
      journeys: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || journey || ':' || status, ',' ORDER BY id), '')) h FROM acquisition_journey_assignments`),
      locks: await h(`SELECT md5(coalesce(string_agg(company_id::text, ',' ORDER BY company_id), '')) h FROM company_contact_locks`),
      cohort: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status, ',' ORDER BY id), '')) h FROM listing_outreach_cohort_members`),
      sequences: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || state, ',' ORDER BY id), '')) h FROM listing_outreach_sequences`),
      auction_pricing: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(platform_fee_bps::text,'-') || ':' || coalesce(processing_fee_bps::text,'-') || ':' || coalesce(pricing_model,'-'), ',' ORDER BY id), '')) h FROM auctions`),
    });
    const before = await snap();
    if ((await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount) console.log('SKIP (already recorded).');
    else {
      try {
        // The file carries its own BEGIN/COMMIT; the schema_migrations row is written right after it commits.
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        console.log('APPLIED', FILE);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    }
    const after = await snap();
    const def = async (rel, like) => (await c.query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE $2`, [rel, like])).rows.map((r) => r.d);
    const journeyChecks = await def('acquisition_journey_assignments', '%CLAIMED_LISTING%');
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      founding_partners_table_empty: Number((await c.query('SELECT count(*) n FROM founding_partners')).rows[0].n) === 0,
      journey_check_single_and_includes_fp: journeyChecks.length === 1 && journeyChecks[0].includes('FOUNDING_PARTNER') && journeyChecks[0].includes('SALES_DIRECT'),
      listing_decision_includes_fp: (await def('listing_outreach_eligibility_decisions', '%EXCLUDE_FOUNDING_PARTNER%')).length === 1,
      ep_decision_includes_fp: (await def('event_partner_eligibility_decisions', '%EXCLUDE_FOUNDING_PARTNER%')).length === 1,
      auctions_founding_partner_id: (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='auctions' AND column_name='founding_partner_id'`)).rowCount === 1,
      no_auction_stamped: Number((await c.query('SELECT count(*) n FROM auctions WHERE founding_partner_id IS NOT NULL')).rows[0].n) === 0,
      platform_config_unchanged: before.config === after.config,
      seller_fees_unchanged: before.seller_fees === after.seller_fees,
      journeys_unchanged: before.journeys === after.journeys,
      contact_locks_unchanged: before.locks === after.locks,
      cohort_members_unchanged: before.cohort === after.cohort,
      sequences_unchanged: before.sequences === after.sequences,
      auction_pricing_unchanged: before.auction_pricing === after.auction_pricing,
    };
    const cfg = Object.fromEntries((await c.query(`SELECT key, value FROM platform_config WHERE key IN
      ('pricing.auction.professional.platform_fee_bps','pricing.auction.processing_fee_bps','pricing.storefront.seller_fee_bps',
       'claimed_listings.sending_enabled','event_partners.outreach_enabled')`)).rows.map((r) => [r.key, r.value]));
    checks.pro_fee_400 = Number(cfg['pricing.auction.professional.platform_fee_bps']) === 400;
    checks.processing_300 = Number(cfg['pricing.auction.processing_fee_bps']) === 300;
    checks.storefront_1100 = Number(cfg['pricing.storefront.seller_fee_bps']) === 1100;
    checks.claimed_listing_sending_off = cfg['claimed_listings.sending_enabled'] === false;
    checks.event_partner_outreach_off = cfg['event_partners.outreach_enabled'] === false;
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
