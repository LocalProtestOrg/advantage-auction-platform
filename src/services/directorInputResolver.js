'use strict';

/**
 * directorInputResolver — Phase 3O Wave 2, blocker 6. Resolves the AUTHORITATIVE inputs the Wave 2 executors
 * need, from production data where available: purchase snapshot, obligations, auction status + publish/closing
 * dates, seller type, catalog + lot categories, Wave 1 creative availability, geography, shippability,
 * followers, first-party audience pools (registered non-bidders, watchers/no-bid, local-event, behavioral),
 * consent/suppression/bounce/complaint/frequency-cap posture, channel readiness, available owned inventory,
 * email + social calendars, and economic authority where relevant.
 *
 * It also persists ACTUAL Director decisions at each production decision site (not only ESCALATE), using ONLY
 * the bounded Phase 3O decision types already certified (PLAN / SELECT_DISCRETIONARY / SCHEDULE / SCOPE_AUDIENCE
 * / ADJUST / RUNG_ADVANCE / UPSELL_PROMPT / ESCALATE). No refusal/refund/repricing decisions are ever produced.
 */

const db = require('../db');
const obligationEngine = require('./marketingObligationEngine');
const readiness = require('./channelReadinessService');
const paidAllocation = require('./paidAllocationBridge');
const directorDecision = require('./directorDecisionService');

async function safe(r, sql, params) { try { return (await r.query(sql, params)).rows; } catch (_) { return []; } }
async function safeOne(r, sql, params) { const rows = await safe(r, sql, params); return rows[0] || null; }

/**
 * Resolve everything an executor needs for a package purchase. Every lookup is best-effort — a missing optional
 * table yields null/empty rather than throwing, so the resolver degrades gracefully in any environment.
 */
async function resolveInputs(purchaseId, runner) {
  const r = runner || db;
  const purchase = await safeOne(r,
    `SELECT id, auction_id, seller_user_id, package_key, amount_paid_cents, guaranteed_deliverables, discretionary_tools, purchased_at
       FROM marketing_package_purchases WHERE id=$1`, [purchaseId]);
  const auctionId = purchase && purchase.auction_id;

  const auction = auctionId ? await safeOne(r,
    `SELECT a.id, a.title, a.state, a.start_time, a.end_time, a.city, a.address_state, a.seller_id
       FROM auctions a WHERE a.id=$1`, [auctionId]) : null;

  const sellerType = auction && auction.seller_id ? await safeOne(r,
    `SELECT seller_type FROM seller_profiles WHERE id=$1`, [auction.seller_id]) : null;

  const lotCategories = auctionId ? await safe(r,
    `SELECT category_key, count(*)::int n FROM lots WHERE auction_id=$1 GROUP BY category_key ORDER BY n DESC`, [auctionId]) : [];

  const shippable = auctionId ? await safeOne(r,
    `SELECT bool_or(COALESCE(shippable,false)) any_shippable, count(*) FILTER (WHERE COALESCE(shippable,false)) shippable_lots FROM lots WHERE auction_id=$1`, [auctionId]) : null;

  const creative = await safeOne(r,
    `SELECT job_id, status FROM marketing_creative_jobs WHERE auction_id::text=$1 AND status='completed' ORDER BY updated_at DESC LIMIT 1`, [String(auctionId)]);

  const followers = auction && auction.seller_id ? await safeOne(r,
    `SELECT count(*)::int n FROM seller_followers WHERE seller_profile_id=$1`, [auction.seller_id]) : null;

  // First-party audience pool SIZES (counts only — never identities here). Behavioral audiences reused.
  const audiencePools = {
    registered_non_bidder: (await safeOne(r, `SELECT count(*)::int n FROM behavioral_audience_members m JOIN behavioral_audiences a ON a.id=m.audience_id WHERE a.audience_key='registered_non_bidder' AND m.exited_at IS NULL`, []) || {}).n || 0,
    watcher_no_bid: (await safeOne(r, `SELECT count(*)::int n FROM behavioral_audience_members m JOIN behavioral_audiences a ON a.id=m.audience_id WHERE a.audience_key='watcher_no_bid' AND m.exited_at IS NULL`, []) || {}).n || 0,
    local_event_interest: (await safeOne(r, `SELECT count(*)::int n FROM behavioral_audience_members m JOIN behavioral_audiences a ON a.id=m.audience_id WHERE a.audience_key='local_event_interest' AND m.exited_at IS NULL`, []) || {}).n || 0,
  };

  const subscribers = await safeOne(r, `SELECT count(*)::int n FROM marketing_contacts WHERE unsubscribed_at IS NULL`, []);
  const suppressed = await safeOne(r, `SELECT count(*)::int n FROM email_suppressions`, []);

  const obligations = purchase ? await obligationEngine.listForPurchase('package', purchaseId, r).catch(() => []) : [];
  const readinessMatrix = await readiness.phase3oMatrix(r).catch(() => ({}));
  const authority = purchase ? await paidAllocation.authorityFor(purchaseId, r).catch(() => null) : null;

  // Owned inventory posture + calendars (counts of active holds; not identities).
  const ownedInventory = await safe(r, `SELECT feature_key, count(*)::int held FROM marketing_placement_reservations WHERE status IN ('reserved','active') GROUP BY feature_key`, []);
  const emailCalendar = await safe(r, `SELECT market, week_key, count(*)::int editions FROM marketing_email_editions WHERE kind='shared' GROUP BY market, week_key`, []);
  const socialCalendar = await safe(r, `SELECT wave, count(*)::int posts FROM marketing_social_jobs GROUP BY wave`, []);

  return {
    purchase, auction,
    auction_status: auction && auction.state,
    publish_date: auction && auction.start_time,
    closing_date: auction && auction.end_time,
    seller_type: sellerType && sellerType.seller_type,
    market: auction ? (auction.city && auction.address_state ? `${auction.city}, ${auction.address_state}` : auction.address_state) : null,
    geography: auction ? { city: auction.city, region: auction.address_state } : null,
    lot_categories: lotCategories,
    shippability: shippable ? { any: shippable.any_shippable === true, shippable_lots: Number(shippable.shippable_lots || 0) } : { any: false, shippable_lots: 0 },
    creative_available: !!creative, creative_job_id: creative && creative.job_id,
    followers: followers ? followers.n : 0,
    audience_pools: audiencePools,
    consent_posture: { subscribable: subscribers ? subscribers.n : 0, suppressed: suppressed ? suppressed.n : 0 },
    obligations,
    channel_readiness: readinessMatrix,
    economic_authority_cents: authority && authority.ceiling_cents != null ? authority.ceiling_cents : null,
    owned_inventory: ownedInventory,
    email_calendar: emailCalendar,
    social_calendar: socialCalendar,
  };
}

/**
 * Persist a bounded Director decision at an executor decision site. Wraps directorDecisionService (which
 * structurally rejects prohibited kinds), attaching the remaining internal authority. Returns the record or a
 * structured rejection — never throws for a disallowed kind.
 */
async function persistDecision({ kind, purchaseId, obligationIds, inputs, evidenceLine, outputs }, runner) {
  const r = runner || db;
  if (!directorDecision.isAllowed(kind)) return { ok: false, rejected: true, reason: 'decision_kind_not_allowed', kind };
  const authority = purchaseId ? await paidAllocation.authorityFor(purchaseId, r).catch(() => null) : null;
  try {
    const rec = await directorDecision.record({
      kind, purchaseId, obligationIds: obligationIds || [], inputs: inputs || {},
      authorityCentsRemaining: authority && authority.ceiling_cents != null ? authority.ceiling_cents : null,
      evidenceLine: evidenceLine || null, outputs: outputs || {},
    }, r);
    return { ok: true, decision: rec };
  } catch (e) { return { ok: false, rejected: true, reason: e.code || e.message, kind }; }
}

module.exports = { resolveInputs, persistDecision };
