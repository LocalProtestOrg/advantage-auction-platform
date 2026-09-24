'use strict';

/**
 * Claimed Listing eligibility screening (handoff section 2).
 *
 * Evaluated in this order; the FIRST hit wins; every decision is persisted with its reason, the matched
 * record and the signals, the same pattern as Event Partner segmentation (migration 162):
 *
 *   1  EXCLUDE_SUPPRESSED          address or company on the global, listing or Event Partner list, or a
 *                                  linked prospect marked do-not-contact. A STOP anywhere stops everything.
 *   2  EXCLUDE_NO_PUBLIC_CONTACT   no valid address on the listing, or a no-reply address. Free mailboxes
 *                                  are ALLOWED here: the invitation goes to the address already published
 *                                  on the listing, and redeeming the link proves mailbox control.
 *   3  EXCLUDE_RECENT_OUTREACH     this programme or Event Partner in 90 days, or 1:1 rep email in 30 days,
 *                                  to the same COMPANY (not just the same address).
 *   4  EXCLUDE_CLAIMED_LISTING     the listing already has an owner (it moves to the activation track).
 *   5  EXCLUDE_EVENT_PARTNER       the company's journey is Event Partner.
 *   6  EXCLUDE_PRO_SELLER          the company is a professional seller.
 *   7  EXCLUDE_OUT_OF_SCOPE        removed from the directory, non-US, national/data-quality exclusion list,
 *                                  or the owner asked for the listing to be removed.
 *   8  REVIEW_AMBIGUOUS_IDENTITY   a rare-name resemblance to a company we have a relationship with.
 *   9  REVIEW_OTHER_RELATIONSHIP   a rep is working a linked prospect, the address belongs to a staff/test
 *                                  account, or a person holds the company contact lock.
 *  10  REVIEW_DATA_QUALITY         email domain differs from the website domain, the address is shared by
 *                                  several listings (only the primary may be contacted), or the listing
 *                                  shows a paid plan badge the company never bought.
 *  11  ELIGIBLE_UNCLAIMED_LISTING
 *
 * Fail closed: any lookup error aborts the screen with an error; nothing becomes ELIGIBLE by default.
 */

const db = require('../../db');
const { normalizeEmail } = require('../../lib/emailNormalize');
const listingContext = require('./listingContext');
const seg = require('../eventPartners/relationshipSegmentationService');
const identity = require('../acquisition/companyIdentityService');

const D = Object.freeze({
  ELIGIBLE: 'ELIGIBLE_UNCLAIMED_LISTING',
  CLAIMED: 'EXCLUDE_CLAIMED_LISTING',
  EVENT_PARTNER: 'EXCLUDE_EVENT_PARTNER',
  PRO_SELLER: 'EXCLUDE_PRO_SELLER',
  SUPPRESSED: 'EXCLUDE_SUPPRESSED',
  RECENT: 'EXCLUDE_RECENT_OUTREACH',
  NO_CONTACT: 'EXCLUDE_NO_PUBLIC_CONTACT',
  OUT_OF_SCOPE: 'EXCLUDE_OUT_OF_SCOPE',
  AMBIGUOUS: 'REVIEW_AMBIGUOUS_IDENTITY',
  OTHER: 'REVIEW_OTHER_RELATIONSHIP',
  DATA_QUALITY: 'REVIEW_DATA_QUALITY',
});
const SENDABLE = new Set([D.ELIGIBLE]);
const ENGAGED_PROSPECT = new Set(['contacted', 'follow_up', 'interested', 'demo_scheduled', 'demo_completed', 'signup_sent', 'professional_seller']);

const out = (decision, reason, extra) => Object.assign({ decision, reason }, extra || {});

/** Does another cluster carry a relationship a cold invitation must not ignore? */
function hasRelationship(cluster) {
  if (!cluster) return false;
  if (cluster.journey === 'EVENT_PARTNER') return true;
  return cluster.members.some((m) =>
    (m.entity_type === 'organization' && (m.row.has_owner || m.row.linked_seller_profile_id))
    || m.entity_type === 'seller_profile'
    || (m.entity_type === 'sales_prospect' && m.row.assigned_rep_user_id));
}

/**
 * Decide for ONE listing entity (companyIdentityService entity of type organization). Pure given ctx.
 * `sequenceId` = the listing's own live sequence (its own sends don't count as "recent outreach").
 */
function decide(entity, ctx) {
  const o = entity.row;
  const cluster = ctx.snap.clusterFor('organization', entity.entity_id);
  const members = cluster ? cluster.members : [entity];
  const orgIds = new Set(members.filter((m) => m.entity_type === 'organization').map((m) => m.entity_id));
  const prospects = members.filter((m) => m.entity_type === 'sales_prospect');
  const companyId = ctx.companyIdOf(cluster);
  const email = normalizeEmail(o.contact_email || '');
  const signals = { email_domain: seg.emailDomain(email), website_domain: entity.signals.website_domain, company_id: companyId,
    journey: cluster ? cluster.journey : null, members: members.length };

  // 1. Suppression (address, company, or a linked prospect the team marked do-not-contact).
  const s = email ? ctx.supp.get(email) : null;
  if (s) return out(D.SUPPRESSED, 'suppressed (' + s.src + ': ' + s.reason + ')', { matched_entity_type: 'suppression', matched_entity_id: email, signals });
  const cs = ctx.companySupp.get('org:' + o.id) || (companyId && ctx.companySupp.get('co:' + companyId));
  if (cs) return out(D.SUPPRESSED, 'company opted out (' + cs.reason + ')', { matched_entity_type: 'suppression', signals });
  const dnc = prospects.find((p) => p.row.contact_status === 'do_not_contact');
  if (dnc) return out(D.SUPPRESSED, 'linked prospect ' + dnc.label + ' is marked Do Not Contact', { matched_entity_type: 'sales_prospect', matched_entity_id: dnc.entity_id, signals });

  // 2. A usable public address on the listing.
  if (!email || !listingContext.EMAIL_RE.test(email)) return out(D.NO_CONTACT, 'no valid email address on the listing', { signals });
  if (listingContext.NO_REPLY_RE.test(email)) return out(D.NO_CONTACT, 'the listing address is a no-reply address', { signals });
  if (listingContext.RELAY_DOMAINS.has(String(email.split('@')[1] || ''))) {
    return out(D.NO_CONTACT, 'the listing address is a social-network relay (' + email.split('@')[1] + '), not a business mailbox', { signals });
  }

  // 3. Recent contact from any programme, company-wide.
  const own = ctx.activeSequences.get(o.id);
  const listingHit = ctx.listingSends.find((m) => (orgIds.has(m.organization_id) || (companyId && m.company_id === companyId)) && (!own || m.sequence_id !== own.id));
  if (listingHit) return out(D.RECENT, 'contacted by the Claimed Listing programme within ' + ctx.config.recentDays + ' days', { matched_entity_type: 'listing_message', signals });
  const memberEmails = new Set([email, ...prospects.map((p) => normalizeEmail(p.row.business_email || '')).filter(Boolean)]);
  const epHit = ctx.epSends.find((m) => orgIds.has(m.organization_id) || memberEmails.has(m.recipient_email_normalized));
  if (epHit) return out(D.RECENT, 'contacted by the Event Partner programme within ' + ctx.config.recentDays + ' days', { matched_entity_type: 'event_partner_send', signals });
  const prospectIds = new Set(prospects.map((p) => p.entity_id));
  const salesHit = ctx.salesSends.find((m) => prospectIds.has(String(m.prospect_id)) || memberEmails.has(normalizeEmail(m.recipient_email || '')));
  if (salesHit) return out(D.RECENT, 'emailed 1:1 by a representative within ' + ctx.config.salesCooldownDays + ' days', { matched_entity_type: 'sales_outreach_email', signals });

  // 4-6. Relationship exclusions.
  if (o.has_owner || members.some((m) => m.entity_type === 'organization' && m.row.has_owner && m.entity_id === o.id)) {
    return out(D.CLAIMED, 'the listing already has an owner (activation track)', { matched_entity_type: 'organization', matched_entity_id: o.id, signals });
  }
  if (cluster && cluster.journey === 'EVENT_PARTNER') return out(D.EVENT_PARTNER, 'the company is in the Event Partner journey (' + (cluster.journey_reason || '') + ')', { signals });
  const pro = members.find((m) => m.entity_type === 'seller_profile') || (o.linked_seller_profile_id ? { entity_type: 'seller_profile', entity_id: o.linked_seller_profile_id, label: 'linked seller' } : null);
  if (pro) return out(D.PRO_SELLER, 'the company is a Professional Seller', { matched_entity_type: 'seller_profile', matched_entity_id: pro.entity_id, signals });

  // 7. Out of scope.
  if (o.bd_sync_status === 'removed') return out(D.OUT_OF_SCOPE, 'the listing was removed from the directory', { signals });
  if (o.state && !listingContext.usStateCode(o.state)) return out(D.OUT_OF_SCOPE, 'not a US listing (' + o.state + ')', { signals });
  if (o.bd_listing_id && ctx.config.excludedBdIds.has(String(o.bd_listing_id))) return out(D.OUT_OF_SCOPE, 'on the national / data-quality exclusion list', { signals });
  if (companyId && ctx.config.excludedCompanyIds.has(String(companyId))) return out(D.OUT_OF_SCOPE, 'company excluded from outreach', { signals });
  if (o.profile_data && (o.profile_data.removal_requested_at || o.profile_data.hidden_by_request)) return out(D.OUT_OF_SCOPE, 'removal requested', { signals });

  // 8. A resemblance we cannot confirm, to a company we already have a relationship with.
  const weak = ctx.snap.ambiguousFor('organization', entity.entity_id).find((a) => {
    const other = a.a === entity.key ? a.b : a.a;
    const [t, id] = other.split(/:(.+)/);
    return hasRelationship(ctx.snap.clusterFor(t, id));
  });
  if (weak) return out(D.AMBIGUOUS, 'resembles ' + (weak.a === entity.key ? weak.b_label : weak.a_label) + ' (' + weak.weak.join(', ') + ') with no strong identifier; held for review', { matched_on: weak.weak, signals });

  // 9. Someone is already handling this company.
  const worked = prospects.find((p) => p.row.assigned_rep_user_id && ENGAGED_PROSPECT.has(p.row.contact_status));
  if (worked) return out(D.OTHER, 'a representative is working the linked prospect ' + worked.label + ' (' + worked.row.contact_status + ')', { matched_entity_type: 'sales_prospect', matched_entity_id: worked.entity_id, signals });
  const internal = ctx.internalAccounts.get(email);
  if (internal) return out(D.OTHER, 'the listing address belongs to a staff, admin or demo account', { signals });
  const lock = companyId ? ctx.locks.get(companyId) : null;
  if (lock && lock.holder_type === 'user') return out(D.OTHER, (lock.holder_name || 'A team member') + ' holds the contact lock for this company', { signals });

  // 10. Data quality.
  const emailDom = identity.isIdentityDomain(signals.email_domain) ? signals.email_domain : null;
  if (emailDom && entity.signals.website_domain && emailDom !== entity.signals.website_domain) {
    return out(D.DATA_QUALITY, 'the email domain (' + emailDom + ') differs from the website domain (' + entity.signals.website_domain + ')', { signals });
  }
  const shared = ctx.primaryFor.get(email);
  if (shared && shared.distinct_names > listingContext.MAX_LISTINGS_PER_ADDRESS) {
    return out(D.DATA_QUALITY, 'this address is shared by ' + shared.count + ' differently named listings, so it is not this business\'s own address', { signals });
  }
  if (shared && shared.count > 1 && shared.primary !== o.id) {
    return out(D.DATA_QUALITY, 'this address is shared by ' + shared.count + ' listings; only the primary listing may be contacted', { signals });
  }
  if (o.bd_listing_id && ctx.config.paidBadgeBdIds.has(String(o.bd_listing_id))) {
    return out(D.DATA_QUALITY, 'the listing shows a paid plan badge the company never bought (badge correction pending)', { signals });
  }

  return out(D.ELIGIBLE, 'unclaimed directory listing with a usable public address and no conflicting relationship', { signals });
}

/**
 * Screen listings. Persists every decision unless persist === false. Returns counts per decision and
 * the decisions themselves. A context/lookup error throws (fail closed: nothing is marked ELIGIBLE).
 */
async function screen({ organizationIds = null, persist = true, runner = db, ctx = null } = {}) {
  const c = ctx || (await listingContext.load(runner));
  const wanted = organizationIds ? new Set(organizationIds.map(String)) : null;
  const decisions = [];
  for (const e of c.listings) {
    if (wanted && !wanted.has(e.entity_id)) continue;
    const d = decide(e, c);
    const cluster = c.snap.clusterFor('organization', e.entity_id);
    decisions.push(Object.assign({ organization_id: e.entity_id, company_name: e.label, company_id: c.companyIdOf(cluster) }, d));
    if (persist) {
      await runner.query(
        `INSERT INTO listing_outreach_eligibility_decisions
           (organization_id, company_id, company_name, normalized_email, decision, reason, matched_entity_type, matched_entity_id, matched_on, signals, evaluated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb, now())
         ON CONFLICT (organization_id) DO UPDATE SET company_id = EXCLUDED.company_id, company_name = EXCLUDED.company_name,
           normalized_email = EXCLUDED.normalized_email, decision = EXCLUDED.decision, reason = EXCLUDED.reason,
           matched_entity_type = EXCLUDED.matched_entity_type, matched_entity_id = EXCLUDED.matched_entity_id,
           matched_on = EXCLUDED.matched_on, signals = EXCLUDED.signals, evaluated_at = now()`,
        [e.entity_id, c.companyIdOf(cluster), e.label, normalizeEmail(e.row.contact_email || '') || null, d.decision, d.reason,
         d.matched_entity_type || null, d.matched_entity_id != null ? String(d.matched_entity_id) : null,
         JSON.stringify(d.matched_on || []), JSON.stringify(d.signals || {})]);
    }
  }
  const counts = decisions.reduce((m, d) => { m[d.decision] = (m[d.decision] || 0) + 1; return m; }, {});
  return { screened: decisions.length, counts, decisions };
}

/** Re-screen ONE listing now (the send gate calls this at send time). Never throws: errors → not sendable. */
async function rescreen(organizationId, runner = db) {
  try {
    const r = await screen({ organizationIds: [organizationId], persist: true, runner });
    return r.decisions[0] || { decision: null, reason: 'not a directory listing' };
  } catch (e) {
    return { decision: null, reason: 'eligibility check failed: ' + e.message, error: true };
  }
}

module.exports = { DECISIONS: D, SENDABLE, decide, screen, rescreen, hasRelationship };
