'use strict';

/**
 * relationshipSegmentationService — decides whether a company may receive COLD Event Partner
 * outreach, by asking whether Advantage.Bid already has a relationship with it.
 *
 * THE OWNER'S RULE, made mechanical: a business that has already claimed a listing, is already an
 * Event Partner, or is already a Professional Seller must never receive a cold "authorize us"
 * invitation. Those are different journeys and mixing them makes Advantage.Bid look like it does
 * not know its own customers.
 *
 * WHY EMAIL MATCHING IS NOT ENOUGH. A claimed listing may be held by jane@gmail.com while the
 * company's public business address is info@smithestates.com. Same company, different mailbox. So
 * identity is resolved across whichever signals the two records happen to share:
 *
 *   normalised company name   ·   root website domain   ·   email domain   ·   normalised phone
 *
 * STRONG signals (domain, phone, exact normalised name) are enough to EXCLUDE on their own, because
 * a false exclusion merely costs one prospect while a false inclusion emails an existing customer.
 * WEAK agreement (a fuzzy name resemblance and nothing else) returns REVIEW_AMBIGUOUS_IDENTITY,
 * which does NOT send. The asymmetry is deliberate: this fails closed.
 */

const db = require('../../db');
const configService = require('../configService');
const { normalizeEmail } = require('../../lib/emailNormalize');

const DECISIONS = Object.freeze({
  ELIGIBLE: 'ELIGIBLE_UNAFFILIATED',
  EVENT_PARTNER: 'EXCLUDE_EVENT_PARTNER',
  CLAIMED_LISTING: 'EXCLUDE_CLAIMED_LISTING',
  PRO_SELLER: 'EXCLUDE_PRO_SELLER',
  SUPPRESSED: 'EXCLUDE_SUPPRESSED',
  RECENT_OUTREACH: 'EXCLUDE_RECENT_OUTREACH',
  NO_CONTACT: 'EXCLUDE_NO_PUBLIC_CONTACT',
  AMBIGUOUS: 'REVIEW_AMBIGUOUS_IDENTITY',
  OTHER_RELATIONSHIP: 'REVIEW_OTHER_RELATIONSHIP',
  // Migration 169: the company belongs to the Claimed Listing journey (a directory listing). It is
  // invited to claim its listing, never cold-invited into Event Partner.
  LISTING_JOURNEY: 'EXCLUDE_LISTING_JOURNEY',
});

/** Free/consumer mail domains: sharing one says nothing about company identity. */
const GENERIC_EMAIL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'me.com', 'msn.com', 'live.com', 'comcast.net', 'sbcglobal.net',
  'verizon.net', 'att.net', 'protonmail.com', 'mail.com', 'gmx.com', 'ymail.com']);

/** Words that carry no identity: two companies sharing only these are not the same company. */
const NAME_STOPWORDS = new Set(['the', 'and', 'llc', 'inc', 'co', 'company', 'corp', 'ltd', 'group',
  'services', 'service', 'auction', 'auctions', 'auctioneers', 'auctioneer', 'estate', 'estates',
  'sale', 'sales', 'liquidation', 'liquidators', 'antiques', 'antique', 'gallery', 'galleries', 'of']);

// ── normalisation ─────────────────────────────────────────────────────────────────────────────

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

/** Distinctive tokens only — the words that actually identify a company. */
function nameTokens(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !NAME_STOPWORDS.has(t));
}

/** Registrable-ish root: strips scheme, path, www and any url-encoding the source left behind. */
function rootDomain(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  try { s = decodeURIComponent(s); } catch (_) { /* leave as-is */ }
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0].split(':')[0];
  if (!s || s.indexOf('.') === -1) return null;
  const parts = s.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : s;
}

function emailDomain(email) {
  const e = String(email || '').toLowerCase().trim();
  const at = e.lastIndexOf('@');
  return at > 0 ? rootDomain(e.slice(at + 1)) : null;
}

function normalizePhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return d.length === 10 ? d : null;
}

/** A corporate (non-free) email domain is a strong company identifier; a free one is not. */
const isCorporateDomain = (d) => !!d && !GENERIC_EMAIL_DOMAINS.has(d);

// ── identity comparison ───────────────────────────────────────────────────────────────────────

/**
 * How strongly do two company records look like the same company?
 * Returns { strong: [...], weak: [...] } naming the signals that agreed.
 */
function compareIdentity(a, b) {
  const strong = [];
  const weak = [];

  const aDomains = new Set([a.website_domain, a.email_domain].filter(isCorporateDomain));
  const bDomains = new Set([b.website_domain, b.email_domain].filter(isCorporateDomain));
  for (const d of aDomains) if (bDomains.has(d)) { strong.push('domain:' + d); break; }

  if (a.normalized_phone && b.normalized_phone && a.normalized_phone === b.normalized_phone) {
    strong.push('phone:' + a.normalized_phone);
  }

  if (a.normalized_name && b.normalized_name && a.normalized_name === b.normalized_name) {
    strong.push('name_exact');
  } else if (a.name_tokens && b.name_tokens && a.name_tokens.length && b.name_tokens.length) {
    const shared = a.name_tokens.filter((t) => b.name_tokens.indexOf(t) !== -1);
    // Two or more distinctive words in common, or one long distinctive word that is the whole of
    // the shorter name, is a resemblance worth a human look — never an automatic send.
    if (shared.length >= 2) weak.push('name_tokens:' + shared.join('+'));
    else if (shared.length === 1 && shared[0].length >= 6) weak.push('name_token:' + shared[0]);
  }

  return { strong, weak };
}

/** Normalise whatever a record gives us into one comparable shape. */
function identityOf({ name, website, email, phone }) {
  return {
    normalized_name: normalizeName(name),
    name_tokens: nameTokens(name),
    website_domain: rootDomain(website),
    email_domain: emailDomain(email),
    normalized_phone: normalizePhone(phone),
  };
}

// ── the existing relationships we screen against ──────────────────────────────────────────────

/** Claimed listings: an organization that a real account actually holds. */
async function claimedListings(runner = db) {
  const { rows } = await runner.query(`
    SELECT o.id, o.name, o.contact_email, o.website_url, o.contact_phone, o.bd_listing_id,
           (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = o.id) AS members
      FROM organizations o
     WHERE EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id)`);
  return rows.map((r) => Object.assign({ entity: 'organization', id: r.id, label: r.name },
    identityOf({ name: r.name, website: r.website_url, email: r.contact_email, phone: r.contact_phone })));
}

/** Businesses already running as Professional Sellers. */
async function professionalSellers(runner = db) {
  const { rows } = await runner.query(`
    SELECT sp.id, COALESCE(sp.display_name, u.email) AS label, sp.display_name, u.email, sp.seller_type
      FROM seller_profiles sp JOIN users u ON u.id = sp.user_id
     WHERE sp.seller_type IN ('auction_house','estate_sale_company','professional_liquidator')`);
  return rows.map((r) => Object.assign({ entity: 'seller_profile', id: r.id, label: r.label },
    identityOf({ name: r.display_name, website: null, email: r.email, phone: null })));
}

/** Companies that are already authorized Event Partners. */
async function existingEventPartners(runner = db) {
  const { rows } = await runner.query(`
    SELECT a.id, a.company_name, a.company_domain, a.contact_email
      FROM authorized_event_sources a`).catch(() => ({ rows: [] }));
  return rows.map((r) => Object.assign({ entity: 'authorized_event_source', id: r.id, label: r.company_name },
    identityOf({ name: r.company_name, website: r.company_domain, email: r.contact_email, phone: null })));
}

// ── the decision ──────────────────────────────────────────────────────────────────────────────

/**
 * Screen one prospect. Returns { decision, reason, matched..., matched_on, signals }.
 * Order matters: suppression and missing contact first (cheapest and most absolute), then the
 * relationship exclusions, then ambiguity.
 */
async function resolve(prospect, ctx = {}, runner = db) {
  const self = identityOf({
    name: prospect.company_name, website: prospect.website || prospect.website_domain,
    email: prospect.business_email, phone: prospect.business_phone || prospect.normalized_phone,
  });
  const signals = { self };
  const normalized = normalizeEmail(prospect.business_email || '');

  // A cold invitation needs a genuine public business mailbox.
  if (!normalized) {
    return { decision: DECISIONS.NO_CONTACT, reason: 'no public business email on record', signals };
  }
  if (!isCorporateDomain(self.email_domain)) {
    return { decision: DECISIONS.NO_CONTACT,
      reason: 'the only contact is a personal/free mailbox (' + (self.email_domain || 'unknown')
        + '), not a published business address', signals };
  }

  // Suppression is absolute.
  const supp = (await runner.query(
    `SELECT 'event_partner' AS src FROM event_partner_suppressions WHERE normalized_email = $1
      UNION ALL SELECT 'global' FROM email_suppressions WHERE normalized_email = $1 LIMIT 1`,
    [normalized])).rows[0];
  if (supp) {
    return { decision: DECISIONS.SUPPRESSED, reason: 'suppressed (' + supp.src + ')',
      matched_entity_type: 'suppression', matched_entity_id: normalized, signals };
  }

  // Already contacted by this programme recently.
  const days = Number(await configService.get(null, 'event_partners.recent_outreach_days')) || 90;
  const recent = (await runner.query(
    `SELECT id, sent_at FROM event_partner_cohort_members
      WHERE recipient_email_normalized = $1 AND status = 'sent' AND sent_at > now() - ($2 || ' days')::interval
      ORDER BY sent_at DESC LIMIT 1`, [normalized, String(days)])).rows[0];
  if (recent) {
    return { decision: DECISIONS.RECENT_OUTREACH, reason: 'contacted by this programme within ' + days + ' days',
      matched_entity_type: 'outreach', matched_entity_id: recent.id, signals };
  }

  // Journey lock. A company whose records include a directory listing belongs to the Claimed Listing
  // journey unless it has already entered Event Partner. Unclaimed directory shells have no members, so
  // the relationship sets below cannot see them; this check can. It fails closed: if the company map
  // cannot be built, nothing is sent.
  const listing = await listingJourneyCheck(prospect, self, ctx, runner);
  if (listing) return Object.assign({ signals }, listing);

  // Relationship screening. Each list is compared on every identity signal we hold.
  const sets = [
    { rows: ctx.claimed || (await claimedListings(runner)), decision: DECISIONS.CLAIMED_LISTING,
      what: 'already has a claimed listing on Advantage.Bid' },
    { rows: ctx.partners || (await existingEventPartners(runner)), decision: DECISIONS.EVENT_PARTNER,
      what: 'is already an authorized Event Partner' },
    { rows: ctx.pros || (await professionalSellers(runner)), decision: DECISIONS.PRO_SELLER,
      what: 'is already a Professional Seller' },
  ];

  const weakHits = [];
  for (const set of sets) {
    for (const other of set.rows) {
      const cmp = compareIdentity(self, other);
      if (cmp.strong.length) {
        return { decision: set.decision,
          reason: other.label + ' ' + set.what + ' (matched on ' + cmp.strong.join(', ') + ')',
          matched_entity_type: other.entity, matched_entity_id: String(other.id),
          matched_on: cmp.strong, signals };
      }
      if (cmp.weak.length) weakHits.push({ set, other, weak: cmp.weak });
    }
  }

  // A resemblance we cannot confirm must never become a send.
  if (weakHits.length) {
    const h = weakHits[0];
    return { decision: DECISIONS.AMBIGUOUS,
      reason: 'resembles ' + h.other.label + ' which ' + h.set.what
        + ', but no strong identifier agreed (' + h.weak.join(', ') + ') — held for review rather than contacted',
      matched_entity_type: h.other.entity, matched_entity_id: String(h.other.id),
      matched_on: h.weak, signals };
  }

  return { decision: DECISIONS.ELIGIBLE,
    reason: 'no existing Advantage.Bid relationship found on name, domain, email domain or phone', signals };
}

/**
 * The Claimed Listing journey check (migration 169). Returns a decision object when the prospect must
 * not be cold-invited, or null to continue screening.
 *   strong identity with a CLAIMED_LISTING company → EXCLUDE_LISTING_JOURNEY
 *   rare-name resemblance to a listing company     → REVIEW_AMBIGUOUS_IDENTITY
 *   the company map could not be built             → REVIEW_OTHER_RELATIONSHIP (fail closed)
 */
async function listingJourneyCheck(prospect, self, ctx, runner) {
  try {
    // Lazy require: companyIdentityService imports this module's normalizers.
    const identity = require('../acquisition/companyIdentityService');
    const snap = ctx.companies || (await identity.snapshot(runner));
    let clusters = [];
    const own = prospect.id ? snap.clusterFor('sales_prospect', String(prospect.id)) : null;
    if (own) clusters.push(own);
    const strongSelf = identity.signalsOf({
      name: prospect.company_name, website: prospect.website || prospect.website_domain,
      email: prospect.business_email, phone: prospect.business_phone || prospect.normalized_phone,
      googlePlaceId: prospect.google_place_id || null,
    });
    for (const c of snap.matchSignals(strongSelf).clusters) if (c && clusters.indexOf(c) === -1) clusters.push(c);
    const hit = clusters.find((c) => c.journey === 'CLAIMED_LISTING');
    if (hit) {
      const org = hit.members.find((m) => m.entity_type === 'organization') || hit.members[0];
      return { decision: DECISIONS.LISTING_JOURNEY,
        reason: (org ? org.label : 'this company') + ' is a directory listing in the Claimed Listing journey'
          + ' (' + (hit.journey_reason || 'directory listing') + ') and is never cold-invited to Event Partner',
        matched_entity_type: org ? org.entity_type : 'company', matched_entity_id: org ? org.entity_id : null,
        matched_on: ['journey:CLAIMED_LISTING'] };
    }
    if (prospect.id) {
      const weak = snap.ambiguousFor('sales_prospect', String(prospect.id)).find((a) => {
        const otherKey = a.a === 'sales_prospect:' + prospect.id ? a.b : a.a;
        const [type, id] = otherKey.split(/:(.+)/);
        const c = snap.clusterFor(type, id);
        return c && c.journey === 'CLAIMED_LISTING';
      });
      if (weak) {
        return { decision: DECISIONS.AMBIGUOUS,
          reason: 'resembles the directory listing ' + (weak.a_label || '') + ' but no strong identifier agreed ('
            + weak.weak.join(', ') + ') and is held for review rather than contacted',
          matched_entity_type: 'organization', matched_entity_id: weak.a.split(/:(.+)/)[1] || null, matched_on: weak.weak };
      }
    }
    return null;
  } catch (e) {
    return { decision: DECISIONS.OTHER_RELATIONSHIP,
      reason: 'could not verify whether this company is a directory listing (' + e.message + '); held rather than contacted' };
  }
}

/** Screen many prospects, loading the relationship sets once. Persists every decision. */
async function screen({ prospectIds = null, limit = 500, persist = true, runner = db } = {}) {
  const ctx = {
    claimed: await claimedListings(runner),
    partners: await existingEventPartners(runner),
    pros: await professionalSellers(runner),
    companies: await require('../acquisition/companyIdentityService').snapshot(runner),
  };
  const { rows } = await runner.query(
    `SELECT id, company_name, business_email, business_phone, website, website_domain,
            normalized_name, normalized_phone, business_type, city, state, contact_source, contact_status
       FROM sales_prospects
      WHERE business_email IS NOT NULL AND business_email <> ''
        AND ($1::uuid[] IS NULL OR id = ANY($1))
      ORDER BY company_name LIMIT $2`, [prospectIds, limit]);

  const out = [];
  for (const p of rows) {
    const d = await resolve(p, ctx, runner);
    out.push(Object.assign({ prospect_id: p.id, company_name: p.company_name,
      business_email: p.business_email, business_type: p.business_type,
      city: p.city, state: p.state, contact_source: p.contact_source,
      website_domain: p.website_domain }, d));
    if (persist) {
      await runner.query(
        `INSERT INTO event_partner_eligibility_decisions
           (prospect_id, company_name, normalized_name, website_domain, business_email,
            normalized_email, normalized_phone, decision, reason, matched_entity_type,
            matched_entity_id, matched_on, signals)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
         ON CONFLICT (prospect_id) DO UPDATE SET
           decision=EXCLUDED.decision, reason=EXCLUDED.reason,
           matched_entity_type=EXCLUDED.matched_entity_type, matched_entity_id=EXCLUDED.matched_entity_id,
           matched_on=EXCLUDED.matched_on, signals=EXCLUDED.signals, evaluated_at=now()`,
        [p.id, p.company_name, normalizeName(p.company_name), p.website_domain, p.business_email,
         normalizeEmail(p.business_email || ''), normalizePhone(p.business_phone), d.decision, d.reason,
         d.matched_entity_type || null, d.matched_entity_id || null,
         JSON.stringify(d.matched_on || []), JSON.stringify(d.signals || {})]);
    }
  }
  return { screened: out.length, decisions: out,
    counts: out.reduce((m, d) => { m[d.decision] = (m[d.decision] || 0) + 1; return m; }, {}) };
}

module.exports = {
  DECISIONS, GENERIC_EMAIL_DOMAINS, NAME_STOPWORDS,
  normalizeName, nameTokens, rootDomain, emailDomain, normalizePhone, isCorporateDomain,
  identityOf, compareIdentity, claimedListings, professionalSellers, existingEventPartners,
  resolve, screen,
};
