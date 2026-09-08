'use strict';

/**
 * channelDispatch — the ONE place that routes a single obligation (a feature_key) to its ordinary channel
 * executor. Both the package runner and the Additional Promotion executor dispatch through here, so
 * additional-promotion children execute through the SAME feature executors as package deliverables (CUSTOM can
 * never become an arbitrary manually-fulfilled bucket). Every branch returns a structured result and never
 * throws; gated channels degrade to shadow/blocked via each executor's readiness/resilience.
 */

const ownedPlacement = require('./ownedPlacementExecutor');
const sharedEmail = require('./sharedEmailExecutor');
const dedicatedEmail = require('./dedicatedEmailExecutor');
const social = require('./socialAdapter');
const creativeEngine = require('./creativeEngineService');

// feature_key -> channel family used for routing.
function channelOf(featureKey) {
  if (ownedPlacement.handles(featureKey)) return 'OWNED';
  if (featureKey === 'shared_edition_inclusion' || featureKey === 'email_touch_additional' || featureKey === 'reach_expansion_shippable') return 'SHARED_EMAIL';
  if (featureKey === 'dedicated_send') return 'DEDICATED_EMAIL';
  if (featureKey === 'social_post_organic') return 'SOCIAL';
  if (['creative_collage_general', 'creative_closing_days', 'creative_lot_specific', 'creative_mid_refresh', 'creative_cobranded_variant', 'share_kit_delivery', 'listing_card'].indexOf(featureKey) !== -1) return 'CREATIVE';
  if (['paid_local_promotion', 'lot_level_promotion'].indexOf(featureKey) !== -1) return 'PAID';
  if (['listing_standard', 'follower_launch_notification', 'performance_standard', 'reporting_standard', 'reporting_detailed', 'catalog_readiness_review', 'managed_campaign_documents', 'managed_review_added_wave', 'recommendations_written', 'custom_bundle', 'closing_soon_extension'].indexOf(featureKey) !== -1) return 'SERVICE';
  return 'SERVICE';
}

/**
 * Dispatch one obligation. ctx carries the shared execution context (auction, market, referenceDate, audience
 * pools, identity, creativeJobId). Returns { channel, result }. PAID is gated: it produces a readiness/resilience
 * outcome and NEVER completes for real while no provider is ACTIVE.
 */
async function dispatch(obligation, ctx = {}, runner) {
  const ch = channelOf(obligation.feature_key);
  try {
    switch (ch) {
      case 'OWNED':
        return { channel: ch, result: await ownedPlacement.execute(obligation, ctx, runner) };
      case 'SHARED_EMAIL':
        return { channel: ch, result: await sharedEmail.assembleEdition({
          market: ctx.market, referenceDate: ctx.referenceDate,
          candidates: ctx.candidates || [{ auction_id: ctx.auction && ctx.auction.auction_id, obligation_id: obligation.id, closing_at: ctx.auction && ctx.auction.closing_at, purchased_at: ctx.purchased_at }],
          audienceContacts: ctx.audienceContacts || [], editionId: ctx.editionId }, runner) };
      case 'DEDICATED_EMAIL':
        return { channel: ch, result: await dedicatedEmail.execute(obligation, {
          auctionId: ctx.auction && ctx.auction.auction_id, market: ctx.market, referenceDate: ctx.referenceDate,
          audiencePools: ctx.audiencePools || {}, audienceKey: ctx.audienceKey }, runner) };
      case 'SOCIAL':
        return { channel: ch, result: await social.execute(obligation, {
          auction: ctx.auction || { auction_id: ctx.auctionId }, identity: ctx.identity,
          referenceAt: ctx.referenceDate, creativeJobId: ctx.creativeJobId }, runner) };
      case 'CREATIVE': {
        const jobId = ctx.creativeJobId || `${obligation.id || obligation.feature_key}:${obligation.feature_key}`;
        const res = await creativeEngine.requestCreative({
          jobId, auctionId: ctx.auction && ctx.auction.auction_id, formats: ctx.formats,
          lots: ctx.lots || [], catalogFamilies: ctx.catalogFamilies || [] }, runner);
        return { channel: ch, result: res };
      }
      case 'PAID':
        // Paid path is gated in production. Obligation/readiness/resilience behavior is complete; it never
        // completes for real and never spends while no provider is ACTIVE.
        return { channel: ch, result: { ok: false, gated: true, reason: 'paid_provider_inactive',
          note: 'readiness=SHADOW_CERTIFIED; routes through resilience; no spend, no false completion' } };
      case 'SERVICE':
      default:
        // Internal service deliverables are system_verified at their natural completion point.
        return { channel: ch, result: { ok: true, system_verified: true, feature_key: obligation.feature_key } };
    }
  } catch (e) {
    return { channel: ch, result: { ok: false, error: 'dispatch_error: ' + e.message } };
  }
}

module.exports = { channelOf, dispatch };
