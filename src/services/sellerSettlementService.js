'use strict';

/**
 * sellerSettlementService — seller-facing settlement reads (Increment 7). Ownership-scoped
 * (a seller only ever sees their own seller_payouts). Uses the settlement engine + the
 * frozen final snapshot as the single source of truth — no calculations are duplicated.
 * All output passes through the seller-safe serializers (no admin data).
 */

const db = require('../db');
const { computeSettlement } = require('./settlementEngine');
const { getSellerPayoutPreference } = require('./payoutPreferenceService');
const { sellerSettlementListItem, sellerFinancialSummary, sellerSettlementDetailView } = require('../lib/sellerSettlementView');

// Seller-appropriate marketing metrics (real data only; attribution = Not Available).
async function marketingPerf(auctionId) {
  const r = await db.query(
    `SELECT package_type, status, views_count, clicks_count, reach_count, watchlist_adds, bidder_conversions, top_lot_count
       FROM marketing_jobs WHERE auction_id = $1 ORDER BY created_at DESC LIMIT 1`, [auctionId]);
  const j = r.rows[0];
  if (!j) return null;
  return {
    package_purchased: j.package_type || null, campaign_status: j.status || null,
    featured_lots: j.top_lot_count, reach: j.reach_count, views: j.views_count, clicks: j.clicks_count,
    watchlist_adds: j.watchlist_adds, bidder_conversions: j.bidder_conversions,
    attributed_buyers: 'Not Available', attributed_hammer: 'Not Available', campaign_conversion_rate: 'Not Available',
  };
}

async function listSettlements(sellerUserId) {
  const rows = (await db.query(
    `SELECT sp.*, a.title, a.end_time
       FROM seller_payouts sp JOIN auctions a ON a.id = sp.auction_id
      WHERE sp.seller_user_id = $1 ORDER BY a.end_time DESC NULLS LAST`, [sellerUserId])).rows;
  const pref = await getSellerPayoutPreference(sellerUserId);
  return {
    summary: sellerFinancialSummary(rows, pref && pref.payout_method),
    settlements: rows.map(sellerSettlementListItem),
  };
}

async function getDetail(sellerUserId, auctionId) {
  const sp = (await db.query('SELECT * FROM seller_payouts WHERE auction_id = $1', [auctionId])).rows[0];
  if (!sp || sp.seller_user_id !== sellerUserId) return null; // not found OR not the owner -> do not leak

  let totals;
  if (sp.settlement_status === 'paid') {
    const fin = (await db.query('SELECT snapshot FROM settlement_snapshots WHERE auction_id = $1 AND is_final = true', [auctionId])).rows[0];
    totals = fin ? fin.snapshot : await computeSettlement(auctionId); // frozen historical record when paid
  } else {
    const latest = (await db.query('SELECT snapshot FROM settlement_snapshots WHERE auction_id = $1 ORDER BY version DESC LIMIT 1', [auctionId])).rows[0];
    totals = latest ? latest.snapshot : await computeSettlement(auctionId);
  }

  const auction = (await db.query('SELECT title, end_time FROM auctions WHERE id = $1', [auctionId])).rows[0] || {};
  const marketing = await marketingPerf(auctionId);
  return sellerSettlementDetailView({ auctionId, auction, sp, totals, marketing });
}

module.exports = { listSettlements, getDetail };
