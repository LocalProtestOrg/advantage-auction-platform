'use strict';

/**
 * marketingEligibilityService — server-authoritative evaluation of whether a seller may PURCHASE a
 * marketing package for an auction, right now. Combines the 48-hour cutoff (from the auction's
 * authoritative close time, auctions.end_time) with the clothing/apparel >50% rule (from the existing
 * free-text lot category, over VALID catalog lots = state <> 'withdrawn'). Returns a reason + an audit
 * snapshot. Server time only (never browser time).
 */

const db = require('../db');
const elig = require('../lib/marketingEligibility');

// Build the SQL predicate for clothing categories that mirrors marketingEligibility.isClothingCategory
// (case-insensitive; startsWith 'clothing' OR contains 'apparel'/'clothes'). Kept in one place.
const CLOTHING_SQL = `(
  lower(coalesce(category,'')) LIKE 'clothing%'
  OR lower(coalesce(category,'')) LIKE '%apparel%'
  OR lower(coalesce(category,'')) LIKE '%clothes%'
)`;

/**
 * Evaluate purchase eligibility for an auction.
 * @returns {{available:boolean, reason:string, snapshot:object, close_time:Date|null}}
 */
async function evaluateAuction(auctionId, { runner = db, nowMs = Date.now() } = {}) {
  const a = (await runner.query('SELECT id, end_time FROM auctions WHERE id = $1', [auctionId])).rows[0];
  if (!a) return { available: false, reason: 'auction_not_found', snapshot: null, close_time: null };

  // Valid catalog lots = everything not withdrawn (matches publishAuction's lot-count semantics).
  const counts = (await runner.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ${CLOTHING_SQL})::int AS clothing
       FROM lots WHERE auction_id = $1 AND state <> 'withdrawn'`, [auctionId])).rows[0];
  const totalValid = counts.total || 0;
  const clothingLots = counts.clothing || 0;

  const closeMs = a.end_time ? new Date(a.end_time).getTime() : NaN;
  const withinWindow = elig.isWithinPurchaseWindow(nowMs, closeMs);
  const clothingOk = elig.isClothingEligible(totalValid, clothingLots);

  const snapshot = {
    total_valid_lots: totalValid,
    clothing_lots: clothingLots,
    clothing_pct_bps: elig.clothingRatioBps(totalValid, clothingLots),
    rule_version: elig.RULE_VERSION,
    evaluated_at: new Date(nowMs).toISOString(),
    within_window: withinWindow,
    clothing_ok: clothingOk,
  };

  let available = true, reason = 'ok';
  if (!a.end_time) { available = false; reason = 'no_close_time'; }
  else if (!withinWindow) { available = false; reason = 'past_cutoff'; }        // inside final 48h (or closed)
  else if (!clothingOk) { available = false; reason = 'too_much_clothing'; }    // >50% clothing/apparel

  return { available, reason, snapshot, close_time: a.end_time || null };
}

module.exports = { evaluateAuction, CLOTHING_SQL };
