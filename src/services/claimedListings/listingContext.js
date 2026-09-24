'use strict';

/**
 * listingContext — everything the Claimed Listing decisions need, loaded ONCE per run.
 *
 * Eligibility, scoring and the Toolbox all read the same facts about a directory listing: its company
 * (companyIdentityService.snapshot), suppressions across all three B2B lists, recent contact from any
 * programme, contact locks, staff/test accounts and the Owner's configuration. Loading them in bulk keeps
 * each per-listing decision a pure function of (listing, context), which is what the tests exercise.
 */

const db = require('../../db');
const identity = require('../acquisition/companyIdentityService');
const { normalizeEmail } = require('../../lib/emailNormalize');

const US_STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
  IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', PR: 'puerto rico',
};

/** A US state code for whatever the listing holds ("TX", "Texas", "TEXAS", the truncated "LOUISIAN"), or null. */
function usStateCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (US_STATES[up]) return up;
  const low = s.toLowerCase();
  for (const [code, name] of Object.entries(US_STATES)) if (name === low) return code;
  if (low.length >= 5) for (const [code, name] of Object.entries(US_STATES)) if (name.startsWith(low)) return code;
  return null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const NO_REPLY_RE = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|noreply)[@+.-]/i;
// Social-network relay addresses (e.g. a Facebook page's proxy mailbox) are not the business's inbox.
const RELAY_DOMAINS = new Set(['fb.com', 'facebook.com', 'instagram.com', 'facebookmail.com', 'messenger.com']);
// An address carried by more than this many differently-named listings is not any one business's own
// address (a franchise head office, a scraped provider mailbox): none of those listings is contacted.
const MAX_LISTINGS_PER_ADDRESS = 3;

/** Is this a listing (directory) organization? */
const isListingOrg = (o) => !!(o && (o.bd_listing_id || o.source === 'bd_import'));

async function load(runner = db, { snapshot = null } = {}) {
  const snap = snapshot || (await identity.snapshot(runner));
  // Read through the same runner so a run inside a transaction sees one consistent state.
  const cfg = async (k, d) => {
    const r = (await runner.query('SELECT value FROM platform_config WHERE key = $1', [k]).catch(() => ({ rows: [] }))).rows[0];
    const v = r ? r.value : null;
    return v == null ? d : v;
  };
  const config = {
    recentDays: Number(await cfg('claimed_listings.recent_outreach_days', 90)) || 90,
    salesCooldownDays: Number(await cfg('claimed_listings.sales_outreach_cooldown_days', 30)) || 30,
    excludedBdIds: new Set((await cfg('claimed_listings.excluded_bd_listing_ids', [])).map(String)),
    excludedCompanyIds: new Set((await cfg('claimed_listings.excluded_company_ids', [])).map(String)),
    paidBadgeBdIds: new Set((await cfg('claimed_listings.paid_badge_bd_listing_ids', [])).map(String)),
    weights: await cfg('claimed_listings.score_weights', {}),
  };

  const listings = snap.entities.filter((e) => e.entity_type === 'organization' && isListingOrg(e.row));
  const emails = [...new Set(listings.map((e) => normalizeEmail(e.row.contact_email || '')).filter(Boolean))];

  // Suppression across all three lists (errors propagate: the caller fails closed).
  const supp = new Map();
  for (const r of (await runner.query(
    `SELECT normalized_email, 'global' AS src, reason FROM email_suppressions WHERE normalized_email = ANY($1)
     UNION ALL SELECT normalized_email, 'listing', reason FROM listing_outreach_suppressions WHERE normalized_email = ANY($1)
     UNION ALL SELECT normalized_email, 'event_partner', reason FROM event_partner_suppressions WHERE normalized_email = ANY($1)`,
    [emails])).rows) if (!supp.has(r.normalized_email)) supp.set(r.normalized_email, r);
  const companySupp = new Map();
  for (const r of (await runner.query(
    `SELECT organization_id, company_id, reason FROM listing_outreach_suppressions WHERE organization_id IS NOT NULL OR company_id IS NOT NULL`)).rows) {
    if (r.organization_id) companySupp.set('org:' + r.organization_id, r);
    if (r.company_id) companySupp.set('co:' + r.company_id, r);
  }

  // Recent contact from every programme.
  const listingSends = (await runner.query(
    `SELECT m.organization_id, m.company_id, m.sequence_id, m.sent_at FROM listing_outreach_messages m
      WHERE m.direction = 'outbound' AND m.status = 'sent' AND m.sent_at > now() - ($1 || ' days')::interval`,
    [String(config.recentDays)])).rows;
  const epSends = (await runner.query(
    `SELECT organization_id, recipient_email_normalized, sent_at FROM event_partner_cohort_members
      WHERE status = 'sent' AND sent_at > now() - ($1 || ' days')::interval`, [String(config.recentDays)])).rows;
  const salesSends = (await runner.query(
    `SELECT prospect_id, recipient_email, created_at FROM sales_outreach_emails
      WHERE status = 'sent' AND created_at > now() - ($1 || ' days')::interval`, [String(config.salesCooldownDays)])).rows;

  const activeSequences = new Map();
  for (const r of (await runner.query(
    `SELECT id, organization_id, state, step, cycle_no FROM listing_outreach_sequences WHERE state IN ('queued','active','paused','dormant')`)).rows) {
    activeSequences.set(r.organization_id, r);
  }

  const internalAccounts = new Map();
  for (const r of (await runner.query(
    `SELECT lower(email) AS email, role, staff_role, COALESCE(is_demo,false) AS is_demo FROM users
      WHERE lower(email) = ANY($1) AND (role = 'admin' OR staff_role IS NOT NULL OR COALESCE(is_demo,false) = true)`, [emails])).rows) {
    internalAccounts.set(r.email, r);
  }

  const locks = new Map();
  for (const r of (await runner.query(
    `SELECT l.company_id, l.holder_type, l.holder_user_id, l.sequence_id, l.acquired_at, u.full_name AS holder_name
       FROM company_contact_locks l LEFT JOIN users u ON u.id = l.holder_user_id WHERE l.expires_at > now()`)).rows) locks.set(r.company_id, r);

  // Company ids persisted for clusters (locks and journeys hang off them).
  const companyIdOf = (cluster) => (cluster && cluster.companyId) || null;

  // Listings that share one contact address: only the primary (lowest BD id) may be contacted.
  const byEmail = new Map();
  for (const e of listings) {
    const n = normalizeEmail(e.row.contact_email || '');
    if (!n) continue;
    if (!byEmail.has(n)) byEmail.set(n, []);
    byEmail.get(n).push(e);
  }
  const primaryFor = new Map();
  for (const [n, list] of byEmail) {
    const sorted = list.slice().sort((a, b) => (Number(a.row.bd_listing_id) || 1e9) - (Number(b.row.bd_listing_id) || 1e9) || (a.entity_id < b.entity_id ? -1 : 1));
    const names = new Set(list.map((x) => x.signals.normalized_name || x.label));
    primaryFor.set(n, { primary: sorted[0].entity_id, count: list.length, distinct_names: names.size, others: sorted.slice(1).map((x) => x.label) });
  }

  return { snap, config, listings, supp, companySupp, listingSends, epSends, salesSends, activeSequences, internalAccounts, locks, primaryFor, companyIdOf };
}

module.exports = { load, usStateCode, isListingOrg, US_STATES, EMAIL_RE, NO_REPLY_RE, RELAY_DOMAINS, MAX_LISTINGS_PER_ADDRESS };
