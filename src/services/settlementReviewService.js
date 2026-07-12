'use strict';

/**
 * settlementReviewService — assembles the complete Administrative Settlement Review
 * payload for one auction (Increment 6). READ-ONLY: it composes existing pieces
 * (settlementEngine, adjustments, payout profile, audit_log, marketing_jobs) into one
 * accountant-grade view. Every dollar in the summary is traceable to a subtotal.
 */

const db = require('../db');
const { computeSettlement } = require('./settlementEngine');
const { listAdjustments } = require('./settlementAdjustmentService');
const { getSellerPayoutPreference } = require('./payoutPreferenceService');
const { payoutProfileStatus, maskedPayoutSummary, PAYOUT_STATUS } = require('../lib/payoutProfile');
const { sellerSettlementsEnabled } = require('../lib/launchGuards');
const { SETTLEMENT_STATUS_LABEL } = require('../lib/settlementPolicy');

// Marketing performance = ONLY metrics that genuinely exist (marketing_jobs). Attribution
// (attributed buyers/hammer/conversion) is NOT tracked today -> reported as Not Available.
async function marketingBlock(auctionId) {
  const r = await db.query(
    `SELECT package_type, status, budget, views_count, clicks_count, reach_count,
            watchlist_adds, bidder_conversions, top_lot_count, campaign_started_at, campaign_ended_at
       FROM marketing_jobs WHERE auction_id = $1 ORDER BY created_at DESC LIMIT 1`, [auctionId]);
  const job = r.rows[0] || null;
  return {
    // Settlement DEDUCTIONS come only from the engine (authoritative purchase record); none today.
    charges: { note: 'None', deduction_cents: 0 },
    // Informational statistics only — never alter the settlement calculation.
    performance: job ? {
      package_purchased: job.package_type || null,
      campaign_status: job.status || null,
      views: job.views_count, clicks: job.clicks_count, reach: job.reach_count,
      watchlist_adds: job.watchlist_adds, bidder_conversions: job.bidder_conversions, featured_lots: job.top_lot_count,
      campaign_started_at: job.campaign_started_at, campaign_ended_at: job.campaign_ended_at,
      // Attribution is not tracked yet — honest placeholders, no fabricated analytics.
      attributed_buyers: 'Not Available', attributed_hammer_total: 'Not Available',
      average_winning_bid: 'Not Available', campaign_conversion_rate: 'Not Available',
    } : null,
  };
}

async function auditTimeline(auctionId) {
  const r = await db.query(
    `SELECT a.event_type, a.actor_id, a.metadata, a.created_at, u.email AS actor_email
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.auction_id = $1 ORDER BY a.created_at ASC`, [auctionId]);
  return r.rows.map(x => ({ event_type: x.event_type, actor_id: x.actor_id, actor_email: x.actor_email || null, metadata: x.metadata || null, at: x.created_at }));
}

// Payment-readiness warnings shown prominently at the top of the review.
function readinessWarnings({ totals, payoutStatus, prefMethod, stripeIncomplete }) {
  const w = [];
  if (totals.outstanding_balance_cents > 0) w.push('Outstanding Buyer Payments');
  if (totals.failed_payments_cents > 0) w.push('Failed Payments Present');
  if (!prefMethod) w.push('Payment Method Missing');
  else if (payoutStatus !== PAYOUT_STATUS.READY) {
    w.push(prefMethod === 'check' ? 'Missing Mailing Address' : 'Seller Banking Incomplete');
  }
  if (stripeIncomplete) w.push('Stripe Processing Not Complete');
  return w;
}

async function assembleSettlementReview(auctionId) {
  const spRes = await db.query('SELECT * FROM seller_payouts WHERE auction_id = $1', [auctionId]);
  const sp = spRes.rows[0] || null;

  const aRes = await db.query(
    `SELECT a.id, a.title, a.end_time, a.seller_id, sp.user_id AS seller_user_id, sp.display_name AS seller_name, u.email AS seller_email
       FROM auctions a
       JOIN seller_profiles sp ON sp.id = a.seller_id
       LEFT JOIN users u ON u.id = sp.user_id
      WHERE a.id = $1`, [auctionId]);
  const auction = aRes.rows[0] || null;
  if (!auction) return null;

  const totals = await computeSettlement(auctionId);
  const adjustments = await listAdjustments(auctionId, { includeVoided: true });
  const pref = await getSellerPayoutPreference(auction.seller_user_id);
  const payoutStatus = payoutProfileStatus(pref);
  const marketing = await marketingBlock(auctionId);
  const timeline = await auditTimeline(auctionId);

  // Stripe processing considered incomplete if any collected payment lacks a captured fee.
  const feeRes = await db.query(
    `SELECT count(*)::int AS missing FROM payments
      WHERE auction_id = $1 AND status IN ('paid','partially_refunded','refunded') AND stripe_fee_cents IS NULL`, [auctionId]);
  const stripeIncomplete = (feeRes.rows[0] && feeRes.rows[0].missing > 0);

  const status = sp ? sp.settlement_status : 'pending_review';
  const isPaid = status === 'paid';

  return {
    settlements_enabled: sellerSettlementsEnabled(process.env),
    auction: {
      id: auction.id, title: auction.title, number: String(auction.id).slice(0, 8).toUpperCase(),
      seller_name: auction.seller_name || auction.seller_email || 'Seller', seller_user_id: auction.seller_user_id,
      close_date: auction.end_time,
      settlement_status: status, settlement_status_label: SETTLEMENT_STATUS_LABEL[status] || 'Pending Review',
      settlement_version: sp ? sp.settlement_version : 0,
      payment_method: sp ? sp.payment_method_used : (pref && pref.payout_method) || null,
      payout_profile_status: payoutStatus,
      is_paid: isPaid,
    },
    payout_profile: maskedPayoutSummary(pref),
    buyer_funds: {
      expected_cents: totals.buyer_payments_expected_cents,
      collected_cents: totals.buyer_payments_collected_cents,
      outstanding_cents: totals.outstanding_balance_cents,
      failed_cents: totals.failed_payments_cents,
      refunds_cents: totals.refunds_cents,
      net_collected_cents: totals.net_collected_cents,
    },
    adjustments,
    adjustments_net_cents: totals.adjustments.net_cents,
    marketing,
    stripe: {
      actual_processing_cents: totals.credit_card_processing_fee_cents,
      balance_transaction_incomplete: stripeIncomplete,
    },
    summary: totals,
    payment: sp ? {
      preferred_method: (pref && pref.payout_method) || null,
      payout_status: status,
      payment_reference: sp.payout_reference || null,
      payment_date: sp.paid_at || null,
      payment_note: sp.payment_note || null,
      paid_by_user_id: sp.paid_by_user_id || null,
      final_amount_paid_cents: sp.final_amount_paid_cents,
    } : null,
    readiness: {
      warnings: readinessWarnings({ totals, payoutStatus, prefMethod: (pref && pref.payout_method) || null, stripeIncomplete }),
      can_mark_paid: !isPaid && payoutStatus === PAYOUT_STATUS.READY && totals.outstanding_balance_cents === 0,
    },
    timeline,
  };
}

module.exports = { assembleSettlementReview, readinessWarnings };
