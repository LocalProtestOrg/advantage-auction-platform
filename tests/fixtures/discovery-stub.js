'use strict';
/**
 * Realistic, varied STUB inventory for Featured Items discovery tests (unit + headless).
 * Pure fabricated data — never touches production and is never reachable by the bidding API.
 * Covers: multiple auctions (incl. one over-represented), branded + anonymous sellers, many
 * categories, bid/no-bid, price spread, freshly-listed + ending-soon, shippable + pickup-only.
 *
 * makeRows(n) → raw eligibility-query-shaped rows (what discoveryService expects from the DB).
 * The `now` is passed in so callers can keep results deterministic.
 */
const CATEGORIES = ['furniture', 'fine-art', 'jewelry', 'tools', 'decor', 'books', 'rugs', 'lighting'];
// auctionId → { seller_id, seller_display_name (null = anonymous/private), weight (relative lot share) }
const AUCTIONS = [
  { id: 'auc-1', seller_id: 'sel-1', seller_display_name: 'Advantage Estate Services', weight: 30 }, // over-represented → tests concentration cap
  { id: 'auc-2', seller_id: 'sel-2', seller_display_name: null, weight: 10 },                          // anonymous/private seller
  { id: 'auc-3', seller_id: 'sel-3', seller_display_name: 'Heritage Auction Co', weight: 10 },
  { id: 'auc-4', seller_id: 'sel-4', seller_display_name: null, weight: 8 },
  { id: 'auc-5', seller_id: 'sel-5', seller_display_name: 'Lakeside Liquidators', weight: 8 },
  { id: 'auc-6', seller_id: 'sel-6', seller_display_name: 'Midtown Galleries', weight: 6 },
  { id: 'auc-7', seller_id: 'sel-7', seller_display_name: null, weight: 5 },
  { id: 'auc-8', seller_id: 'sel-8', seller_display_name: 'Northgate Estates', weight: 5 },
];
const CITIES = [['Adrian', 'MI'], ['Tecumseh', 'MI'], ['Ann Arbor', 'MI'], ['Chicago', 'IL'], ['Houston', 'TX'], ['Toledo', 'OH']];

// Deterministic pseudo-spread (no Math.random) so tests are stable.
function pick(arr, i) { return arr[i % arr.length]; }

function makeRows(n, nowMs) {
  const now = nowMs || Date.parse('2026-07-29T12:00:00Z');
  const rows = [];
  // Weighted but INTERLEAVED auction sequence (round-robin) so auc-1 is over-represented
  // yet spread throughout — small samples still contain multiple auctions/sellers.
  const seq = [];
  let round = 0, added = true;
  while (added) {
    added = false;
    for (const a of AUCTIONS) { if (round < a.weight) { seq.push(a); added = true; } }
    round++;
  }
  for (let i = 0; i < n; i++) {
    const a = seq[i % seq.length];
    const bidCount = [0, 0, 1, 2, 3, 5, 8, 12, 0, 1][i % 10];
    const starting = 50 + (i % 12) * 75;
    const hasBids = bidCount > 0;
    const closesInH = [1, 6, 18, 30, 60, 120, 240, 9][i % 8];       // 1h .. 10d
    const ageDays = [0, 0.2, 1, 2, 5, 10, 18, 25][i % 8];           // fresh .. old
    const [city, state] = pick(CITIES, i);
    rows.push({
      id: 'lot-' + (i + 1),
      auction_id: a.id,
      lot_number: i + 1,
      title: pick(CATEGORIES, i).replace('-', ' ') + ' piece #' + (i + 1),
      category: pick(CATEGORIES, i),
      condition: i % 3 === 0 ? 'Very Good' : (i % 3 === 1 ? 'Good' : ''),
      dimensions: null,
      thumbnail_url: 'https://bid.advantage.bid/img/social-card.png',
      images_count: 1 + (i % 5),
      description: i % 4 === 0 ? '' : 'A nicely presented lot with useful detail.',
      starting_bid_cents: starting * 100,
      current_bid_cents: hasBids ? (starting + bidCount * 25) * 100 : null,
      bid_count: bidCount,
      closes_at: new Date(now + closesInH * 3600 * 1000).toISOString(),
      created_at: new Date(now - ageDays * 24 * 3600 * 1000).toISOString(),
      shippable: i % 2 === 0,
      pickup_category: i % 2 === 0 ? null : 'standard',
      auction_title: a.seller_display_name ? (a.seller_display_name + ' Estate Auction') : 'Private Estate Auction',
      city, state,
      seller_id: a.seller_id,
      watch_count: (i * 3) % 11,
      seller_display_name: a.seller_display_name, // already branding-gated (null = anonymous)
      eligible_total: n,
    });
  }
  return rows;
}

module.exports = { makeRows, CATEGORIES, AUCTIONS };
