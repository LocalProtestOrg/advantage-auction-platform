'use strict';

/**
 * liveAuctionDiagnosisService — runs the deterministic auction diagnosis (opportunityService.diagnoseAuction)
 * against REAL current auctions, gathering evidence from platform facts (views from analytics_events,
 * registrations from auction_buyers, watchers from watchlists, bidders/bids from bids, lots). Produces
 * Director EVIDENCE — never a campaign. Returns a classification + the facts behind it.
 */
const db = require('../db');
const { diagnoseAuction } = require('./opportunityService');

async function evidenceFor(r, auctionId) {
  const views = (await r.query(`SELECT count(*)::int n FROM analytics_events WHERE auction_id=$1 AND event_type IN ('auction_view','page_view')`, [auctionId])).rows[0].n;
  const registrations = (await r.query(`SELECT count(*)::int n FROM auction_buyers WHERE auction_id=$1`, [auctionId])).rows[0].n;
  const lots = (await r.query(`SELECT count(*)::int n FROM lots WHERE auction_id=$1`, [auctionId])).rows[0].n;
  const watchers = (await r.query(`SELECT count(DISTINCT w.user_id)::int n FROM watchlists w JOIN lots l ON l.id=w.lot_id WHERE l.auction_id=$1`, [auctionId])).rows[0].n;
  const bidAgg = (await r.query(`SELECT count(*)::int bids, count(DISTINCT b.bidder_user_id)::int bidders FROM bids b JOIN lots l ON l.id=b.lot_id WHERE l.auction_id=$1`, [auctionId])).rows[0];
  return { views, registrations, lots, watchers, bids: bidAgg.bids, bidders: bidAgg.bidders };
}

async function diagnoseAuctionId(auctionId, runner) {
  const r = runner || db;
  const a = (await r.query(`SELECT id, title, state, end_time FROM auctions WHERE id=$1`, [auctionId])).rows[0];
  if (!a) return null;
  const ev = await evidenceFor(r, auctionId);
  const dx = diagnoseAuction(ev);
  const hoursLeft = a.end_time ? Math.max(0, (new Date(a.end_time) - new Date()) / 3600000) : null;
  const timeCritical = hoursLeft != null && hoursLeft <= 24 && dx.influenceability === 'marketing_influenceable';
  return {
    auction_id: a.id, title: a.title, state: a.state,
    diagnosis: dx.diagnosis, influenceability: dx.influenceability, recommendation: dx.recommendation,
    time_critical: !!timeCritical, hours_remaining: hoursLeft != null ? Math.round(hoursLeft) : null,
    evidence: ev,
  };
}

// Diagnose all currently-public auctions (bounded).
async function diagnoseCurrent(runner, limit = 50) {
  const r = runner || db;
  const { rows } = await r.query(
    `SELECT id FROM auctions WHERE state IN ('published','active') AND is_archived IS NOT TRUE AND is_demo IS NOT TRUE ORDER BY end_time ASC NULLS LAST LIMIT $1`, [limit]);
  const out = [];
  for (const row of rows) { const d = await diagnoseAuctionId(row.id, r); if (d) out.push(d); }
  return out;
}

module.exports = { diagnoseAuctionId, diagnoseCurrent, evidenceFor };
