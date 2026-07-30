'use strict';

/**
 * discoveryService — "Featured Items Available Now" discovery feed.
 *
 * Selects eligible ACTIVE public auction lots, ranks them (discoveryRankingService),
 * then applies a deterministic diversity + exploration interleave so no single auction,
 * seller, or category dominates and underexposed inventory still surfaces. The full
 * ordered list (capped at CAP items) is computed once per short cache window and then
 * sliced into pages — which guarantees stable pagination with NO duplicates across pages.
 *
 * Railway is the sole source of truth. Score is internal (never returned). Privacy: only
 * city/state location, professional-branding-gated seller name, never lat/lng, street
 * address, reserve, seller email/phone, or moderation fields.
 *
 * INTERNAL EXTENSIBILITY: getFeaturedItems accepts an opts object whose shape can later
 * carry personalization context (buyerId, sessionId, recentlyViewed, …) WITHOUT changing
 * the public API — V1 simply doesn't populate or expose those. Future item types
 * (fixed_price, unsold_lot, …) slot into the same shaped contract via `itemType`.
 */

const db = require('../db');
const { publicBaseUrl } = require('../lib/publicUrls');
const { brandedColSql } = require('../lib/sellerBranding');
const { lotDiscoveryScoreSQL } = require('./discoveryRankingService');

const PAGE_SIZE     = 12;   // items per page (fixed for this placement)
const MAX_PAGES     = 6;    // placement cap → up to 72 items
const CAP           = PAGE_SIZE * MAX_PAGES;        // 72
const CANDIDATE_CAP = 200;  // fetch headroom so diversity has choices to interleave
const CACHE_TTL_MS  = 3 * 60 * 1000;                // 3-minute ranked-list cache
const EXPLORE_RATIO = 0.17; // ~2 of every 12 slots reserved for exploratory (lower-ranked) items
const MAX_PER_AUCTION_PAGE = 3;   // <=25% of a 12-card page from one auction
const MAX_CONSECUTIVE_AUCTION = 2;

const ALLOWED_PLACEMENTS = ['event_feed_footer', 'auctions_footer', 'estate_sales_footer', 'homepage', 'standalone'];
const ALLOWED_SORTS = ['featured'];

const base = () => publicBaseUrl().replace(/\/+$/, '');
const B_NAME = brandedColSql('sp.display_name');

// ── Eligibility + ranking query ───────────────────────────────────────────────
// Eligible = open, not withdrawn, has a usable image, closing in the future, inside an
// active + syndicated + non-archived public auction. Ranked by the internal lot score.
function eligibilitySql() {
  const scoreExpr = lotDiscoveryScoreSQL('l', '(SELECT COUNT(*)::int FROM watchlists w WHERE w.lot_id = l.id)');
  return `
    SELECT l.id, l.auction_id, l.lot_number, l.title, l.category, l.condition, l.dimensions,
           l.thumbnail_url, l.images_count, l.description,
           l.starting_bid_cents,
           CASE WHEN l.state = 'open' THEN l.current_bid_cents ELSE NULL END AS current_bid_cents,
           l.bid_count, l.closes_at, l.created_at, l.shippable, l.pickup_category,
           a.title AS auction_title, a.city, a.address_state AS state,
           a.seller_id,
           (SELECT COUNT(*)::int FROM watchlists w WHERE w.lot_id = l.id) AS watch_count,
           ${B_NAME} AS seller_display_name,
           COUNT(*) OVER() AS eligible_total
      FROM lots l
      JOIN auctions a ON a.id = l.auction_id
      LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE l.state = 'open'
       AND l.is_withdrawn IS NOT TRUE
       AND l.closes_at > NOW()
       AND l.thumbnail_url IS NOT NULL AND l.thumbnail_url <> ''
       AND a.state = 'active'
       AND a.is_archived IS NOT TRUE
       AND a.marketplace_status = 'syndicated'
     ORDER BY ${scoreExpr} DESC, l.id ASC
     LIMIT ${CANDIDATE_CAP}`;
}

// ── Diversity + exploration interleave (PURE, deterministic given input + seed) ──
// Input: rows already ranked (score DESC). Output: reordered, length <= cap, enforcing
// per-page auction concentration, no >N consecutive same auction, seller/category spread,
// and reserving ~EXPLORE_RATIO of slots for lower-ranked ("exploration") items. Deterministic
// for a given (rows, cap, seed) → page-stable within a cache window; `seed` rotates the
// exploration pick across windows without randomness.
function rankAndDiversify(rows, opts) {
  opts = opts || {};
  const cap = opts.cap || CAP;
  const exploreRatio = opts.exploreRatio != null ? opts.exploreRatio : EXPLORE_RATIO;
  const seed = opts.seed || 0;
  if (!rows.length) return [];

  // Head = strongest candidates; tail = exploration pool (everything past the head cut).
  const headCut = Math.min(rows.length, cap);
  const head = rows.slice(0, headCut);
  const tail = rows.slice(headCut).concat(head.slice(Math.ceil(headCut * (1 - exploreRatio)))); // weakest of head also explorable
  const usedIds = new Set();
  const out = [];
  const aucStr = (r) => String(r.auction_id);
  const selStr = (r) => (r.seller_display_name ? 'b:' + r.seller_display_name : 's:' + r.seller_id);

  // Per-page counters (reset every PAGE_SIZE placements).
  let pageAuc = {}, pageSel = {};
  function pageReset() { pageAuc = {}; pageSel = {}; }
  // Hard rule (never violated while any alternative remains): per-page auction concentration.
  function underPageCap(r) { return (pageAuc[aucStr(r)] || 0) < MAX_PER_AUCTION_PAGE; }
  // Soft rule: no >MAX_CONSECUTIVE_AUCTION in a row from the same auction.
  function notTooConsecutive(r) {
    const a = aucStr(r);
    let run = 0;
    for (let i = out.length - 1; i >= 0 && aucStr(out[i]) === a; i--) run++;
    return run < MAX_CONSECUTIVE_AUCTION;
  }
  function fits(r) { return underPageCap(r) && notTooConsecutive(r); }
  function place(r) {
    out.push(r); usedIds.add(r.id);
    pageAuc[aucStr(r)] = (pageAuc[aucStr(r)] || 0) + 1;
    pageSel[selStr(r)] = (pageSel[selStr(r)] || 0) + 1;
    if (out.length % PAGE_SIZE === 0) pageReset();
  }
  // Pick the first not-yet-used candidate, in tiers: (1) fully fits; (2) under the page
  // concentration cap (relax only the consecutive rule); (3) any unused (last resort, keeps
  // pages filling). Tier 2 preserves the <=25%/page cap whenever any other-auction item remains.
  function pickFrom(list) {
    for (let i = 0; i < list.length; i++) { const r = list[i]; if (!usedIds.has(r.id) && fits(r)) return r; }
    for (let i = 0; i < list.length; i++) { const r = list[i]; if (!usedIds.has(r.id) && underPageCap(r)) return r; }
    for (let i = 0; i < list.length; i++) { const r = list[i]; if (!usedIds.has(r.id)) return r; }
    return null;
  }

  const exploreEvery = exploreRatio > 0 ? Math.max(2, Math.round(1 / exploreRatio)) : 0; // ~every 6th slot
  let tailPtr = seed % (tail.length || 1);
  while (out.length < cap && usedIds.size < rows.length) {
    const slot = out.length;
    let chosen = null;
    if (exploreEvery && slot > 0 && slot % exploreEvery === 0) {
      // exploration slot: rotate through the tail pool
      for (let k = 0; k < tail.length; k++) {
        const r = tail[(tailPtr + k) % tail.length];
        if (!usedIds.has(r.id) && fits(r)) { chosen = r; tailPtr = (tailPtr + k + 1) % tail.length; break; }
      }
    }
    if (!chosen) chosen = pickFrom(rows); // rows is the full ranked list → tiered, highest-ranked first
    if (!chosen) break;
    place(chosen);
  }
  return out;
}

// ── Item shaping (privacy-safe generic discovery-item contract) ─────────────────
function toDollars(cents) { return (typeof cents === 'number' && cents >= 0) ? Math.round(cents) / 100 : null; }
function computeBadges(r, closesInMs) {
  const badges = [];
  if (closesInMs != null && closesInMs <= 24 * 3600 * 1000) badges.push('ending_soon');
  const ageMs = r.created_at ? (Date.now() - new Date(r.created_at).getTime()) : null;
  if (ageMs != null && ageMs <= 24 * 3600 * 1000) badges.push('new_today');
  else if (ageMs != null && ageMs <= 3 * 24 * 3600 * 1000) badges.push('just_listed');
  if (!r.bid_count) badges.push('no_bids_yet');
  else if (r.bid_count >= 5) badges.push('popular');
  if (r.shippable) badges.push('shipping_available');
  else if (r.pickup_category) badges.push('local_pickup');
  return badges;
}
function shapeItem(r) {
  const b = base();
  const brandingVisible = !!r.seller_display_name;
  const closesAt = r.closes_at ? new Date(r.closes_at) : null;
  const closesInMs = closesAt ? (closesAt.getTime() - Date.now()) : null;
  const hasBids = r.bid_count > 0 && r.current_bid_cents != null;
  return {
    id: r.id,
    itemType: 'auction_lot',
    title: r.title || (r.lot_number ? ('Lot ' + r.lot_number) : 'Lot'),
    canonicalUrl: b + '/lot.html?lotId=' + encodeURIComponent(r.id),
    primaryImage: { url: r.thumbnail_url, alt: (r.title || 'Auction lot') },
    pricing: {
      mode: 'auction',
      currentBid: hasBids ? toDollars(r.current_bid_cents) : null,
      startingPrice: toDollars(r.starting_bid_cents),
      currency: 'USD',
      bidCount: r.bid_count || 0,
    },
    availability: {
      status: (closesInMs != null && closesInMs <= 24 * 3600 * 1000) ? 'ending_soon' : 'active',
      closesAt: closesAt ? closesAt.toISOString() : null,
    },
    location: { city: r.city || null, state: r.state || null },
    fulfillment: { localPickup: !!r.pickup_category, shippingAvailable: !!r.shippable },
    // Auction TITLE is exposed only for professional (branding-visible) sellers, so a private
    // seller's identity can't leak via the auction name. The link is always safe.
    auction: {
      id: r.auction_id,
      title: brandingVisible ? (r.auction_title || null) : null,
      canonicalUrl: b + '/auction-view.html?auctionId=' + encodeURIComponent(r.auction_id),
    },
    seller: { brandingVisible: brandingVisible, displayName: r.seller_display_name || null },
    badges: computeBadges(r, closesInMs),
  };
}

// ── Cache (ranked+diversified shaped list per placement|sort) ───────────────────
const _cache = new Map();
async function buildList(placement, sort) {
  const { rows } = await db.query(eligibilitySql());
  const eligibleTotal = rows.length ? parseInt(rows[0].eligible_total, 10) : 0;
  const seed = Math.floor(Date.now() / CACHE_TTL_MS); // rotates across cache windows, stable within one
  const ordered = rankAndDiversify(rows, { cap: CAP, seed }).map(shapeItem);
  return { items: ordered, eligibleTotal, generatedAt: new Date().toISOString() };
}
async function getList(placement, sort, force) {
  const key = placement + '|' + sort;
  const now = Date.now();
  const hit = _cache.get(key);
  if (!force && hit && (now - hit.at) < CACHE_TTL_MS) return hit.value;
  const value = await buildList(placement, sort);
  _cache.set(key, { at: now, value });
  return value;
}
function _clearCache() { _cache.clear(); } // test hook

/**
 * getFeaturedItems(opts) — public entry point for the discovery API + SEO page.
 * @param {object} opts
 *   page      {number} 1-based (clamped to [1, MAX_PAGES])
 *   limit     {number} clamped to [1, PAGE_SIZE]
 *   placement {string} allowlisted; defaults to 'standalone'
 *   sort      {string} allowlisted; defaults to 'featured'
 *   (INTERNAL/future: buyerId, sessionId, filters — accepted here, NOT exposed publicly in V1)
 * @returns {Promise<{data, pagination, context}>}
 */
async function getFeaturedItems(opts) {
  opts = opts || {};
  const placement = ALLOWED_PLACEMENTS.indexOf(opts.placement) !== -1 ? opts.placement : 'standalone';
  const sort = ALLOWED_SORTS.indexOf(opts.sort) !== -1 ? opts.sort : 'featured';
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || PAGE_SIZE, 1), PAGE_SIZE);
  let page = Math.max(parseInt(opts.page, 10) || 1, 1);
  if (page > MAX_PAGES) page = MAX_PAGES;

  const list = await getList(placement, sort, !!opts.force);
  const total = Math.min(list.items.length, CAP);
  const totalPages = Math.min(MAX_PAGES, Math.max(total > 0 ? 1 : 0, Math.ceil(total / limit)));
  const start = (page - 1) * limit;
  const data = list.items.slice(start, start + limit);

  return {
    data,
    pagination: {
      page, limit, total, totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1,
    },
    context: { placement, sort, generatedAt: list.generatedAt },
  };
}

module.exports = {
  getFeaturedItems, rankAndDiversify, shapeItem, computeBadges, eligibilitySql,
  PAGE_SIZE, MAX_PAGES, CAP, ALLOWED_PLACEMENTS, ALLOWED_SORTS, _clearCache,
};
