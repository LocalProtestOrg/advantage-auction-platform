'use strict';

/**
 * marketplaceVisibility — the SINGLE canonical definition of "publicly listable" marketplace inventory.
 *
 * Phase 6A platform rule: there is ONE authoritative source of public marketplace information. Every
 * canonical public API (and only the canonical public APIs) decides visibility, and it must use THESE
 * predicates — never a re-implemented copy. New listing surfaces MUST import from here; the Marketplace
 * Integrity Suite fails the deployment if a surface's counts diverge from what these predicates produce.
 *
 * Two inventory kinds share the public marketplace:
 *   • events (the events table: imported + native events; sale_type='auction' | else 'estate_sale')
 *   • native auctions (the auctions table)
 *
 * These functions emit SQL fragments (alias-configurable) so existing routes can adopt them without a
 * rewrite, plus canonicalCounts() which is the authoritative tally the integrity suite compares against.
 */

// An event is publicly listable when it is published and not past its end.
function activeEventSql(alias = 'e') {
  return `${alias}.status = 'published' AND (${alias}.end_at IS NULL OR ${alias}.end_at >= now())`;
}

// A native auction is publicly listable when published/active, not archived, marketplace-syndicated,
// and NOT a sales-demo auction. Demo auctions are also set to marketplace_status='hidden', so this
// is-demo clause is defense-in-depth: it keeps the demo out of the public feed even if someone later
// re-syndicates it. Because canonicalCounts() uses this same predicate, the integrity suite stays
// consistent (demo is excluded everywhere identically).
function activeNativeAuctionSql(alias = 'a') {
  return `${alias}.state IN ('published','active') AND ${alias}.is_archived IS NOT TRUE`
    + ` AND ${alias}.marketplace_status = 'syndicated' AND ${alias}.is_demo IS NOT TRUE`;
}

// Canonical event type classification (mirrors the public feed): auction vs estate_sale.
function eventKindSql(alias = 'e') {
  return `(CASE WHEN ${alias}.sale_type = 'auction' THEN 'auction' ELSE 'estate_sale' END)`;
}

// A fixed-price Marketplace item is publicly listable when it is active and not a demo record.
function activeMarketplaceItemSql(alias = 'm') {
  return `${alias}.status = 'active' AND ${alias}.is_demo IS NOT TRUE`;
}

// A directory company is publicly listable (the "Marketplace" family) when it is a real, geocoded,
// non-sample BD-imported organization that has not been reconciled away.
function activeMarketplaceCompanySql(alias = 'o') {
  return `${alias}.source = 'bd_import' AND ${alias}.lat IS NOT NULL AND ${alias}.lng IS NOT NULL`
    + ` AND ${alias}.name IS NOT NULL AND btrim(${alias}.name) <> ''`
    + ` AND (${alias}.bd_sync_status IS NULL OR ${alias}.bd_sync_status <> 'removed')`
    + ` AND lower(${alias}.name) NOT LIKE 'sample %' AND lower(${alias}.name) NOT LIKE 'test %' AND lower(${alias}.name) NOT LIKE 'demo %'`;
}

/**
 * canonicalCounts(db) → the authoritative public inventory tally. This is the source of truth the
 * integrity suite holds every public API and surface to. Read-only; never throws to the caller path.
 */
async function canonicalCounts(db) {
  const ev = (await db.query(
    `SELECT ${eventKindSql('e')} AS kind,
            count(*)::int AS n,
            count(*) FILTER (WHERE e.lat IS NOT NULL AND e.lng IS NOT NULL)::int AS n_coord
       FROM events e
      WHERE ${activeEventSql('e')}
      GROUP BY 1`)).rows;
  const byKind = ev.reduce((m, r) => { m[r.kind] = { n: r.n, coord: r.n_coord }; return m; }, {});
  const auction = byKind.auction || { n: 0, coord: 0 };
  const estate = byKind.estate_sale || { n: 0, coord: 0 };

  const nativeAuctions = (await db.query(
    `SELECT count(*)::int AS n FROM auctions a WHERE ${activeNativeAuctionSql('a')}`)).rows[0].n;

  // PROFESSIONALS directory (a SEPARATE concept from the Marketplace product family). Broken out by
  // profession so the map key can show each category. profession_id: 3=auction houses, 4=estate-sale
  // companies, 5=appraisers.
  const prof = (await db.query(
    `SELECT (o.bd_metadata->>'profession_id') AS pid, count(*)::int AS n FROM organizations o
      WHERE ${activeMarketplaceCompanySql('o')} GROUP BY 1`)).rows;
  const companies = prof.reduce((s, r) => s + r.n, 0);
  const professionals = { estate_sale_companies: 0, auction_houses: 0, appraisers: 0, total: companies };
  for (const r of prof) {
    if (r.pid === '3') professionals.auction_houses += r.n;
    else if (r.pid === '4') professionals.estate_sale_companies += r.n;
    else if (r.pid === '5') professionals.appraisers += r.n;
  }

  // MARKETPLACE = fixed-price Advantage.Bid items ONLY (locked product rule). Now backed by the
  // marketplace_items table: active, non-demo listings only (demo excluded like auctions/events).
  const marketplaceItems = (await db.query(
    `SELECT count(*)::int AS n FROM marketplace_items m WHERE ${activeMarketplaceItemSql('m')}`)).rows[0].n;

  return {
    events: {
      auction: auction.n,
      estate_sale: estate.n,
      total: auction.n + estate.n,
      auction_with_coords: auction.coord,
      estate_sale_with_coords: estate.coord,
    },
    native_auctions: nativeAuctions,
    professionals,                                  // directory companies (NOT a product family)
    // The four owner-locked customer-facing product families (locked vocabulary) as authoritative counts:
    families: {
      advantage_auction: nativeAuctions,  // Advantage.Bid Auctions (native hosted auctions)
      partner_event: auction.n,           // Auction Partner Events (imported/partner auction EVENTS)
      estate_sale: estate.n,              // Estate Sales
      marketplace: marketplaceItems,      // Marketplace = fixed-price items only (0 until implemented)
    },
    // Derived expectations for each canonical public API (what the integrity suite asserts):
    expect: {
      feed_all_events: nativeAuctions + auction.n + estate.n, // /marketplace/feed?preset=all-events
      feed_auctions:   nativeAuctions + auction.n,            // /marketplace/feed?preset=auctions (native + auction-events)
      feed_estate_sales: estate.n,                            // /marketplace/feed?preset=estate-sales
      map_auction:  auction.coord,                            // /events/map counts.auction (coord-gated, events-only)
      map_estate_sale: estate.coord,                          // /events/map counts.estate_sale
      professionals_total: companies,                         // /marketplace total (directory, NOT Marketplace family)
      marketplace_items: marketplaceItems,                    // Marketplace product family (fixed-price)
    },
    at: new Date().toISOString(),
  };
}

module.exports = { activeEventSql, activeNativeAuctionSql, activeMarketplaceItemSql, eventKindSql, canonicalCounts };
