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

// The admin-granted professional-type capabilities (professionalProfileSchema.PROFESSIONAL_TYPES). A
// NATIVE org qualifies for the professionals directory only when it holds one of these — never self-set.
const PROFESSIONAL_CAPABILITY_SQL_LIST =
  "'appraiser','auction_house','estate_sale_company','professional_liquidator','consignment_company','moving_company','cleanout_company'";

// A directory company is publicly listable when it is a real, geocoded, non-sample organization —
// ORIGIN-AGNOSTIC (Decision #1): a BD-imported listing OR a legitimate NATIVE Railway organization that
// is (a) in a public lifecycle, (b) admin-PUBLISHED (profile_data.published — never user-writable), and
// (c) holds an admin-granted professional-type capability. Native orgs therefore appear on the SAME terms
// as BD imports, but only after the SAME moderation (publication + verified professional type) — no
// self-service spam, and the $39 individual/hidden orgs (unpublished, no pro capability) are excluded.
function activeMarketplaceCompanySql(alias = 'o') {
  const common = `${alias}.lat IS NOT NULL AND ${alias}.lng IS NOT NULL`
    + ` AND ${alias}.name IS NOT NULL AND btrim(${alias}.name) <> ''`
    + ` AND (${alias}.bd_sync_status IS NULL OR ${alias}.bd_sync_status <> 'removed')`
    + ` AND lower(${alias}.name) NOT LIKE 'sample %' AND lower(${alias}.name) NOT LIKE 'test %' AND lower(${alias}.name) NOT LIKE 'demo %'`;
  const bd = `${alias}.source = 'bd_import'`;
  const native = `(${alias}.source <> 'bd_import'`
    + ` AND ${alias}.lifecycle_state IN ('active_partner','verified')`
    + ` AND (${alias}.profile_data->>'published') = 'true'`
    + ` AND EXISTS (SELECT 1 FROM organization_capabilities oc WHERE oc.organization_id = ${alias}.id`
    + ` AND oc.enabled = true AND oc.capability IN (${PROFESSIONAL_CAPABILITY_SQL_LIST})))`;
  return `(${bd} OR ${native}) AND ${common}`;
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

  // UPCOMING status (WHEN, across every family — distinct from the WHAT/type family counts). A public
  // event/auction is "upcoming" when it passes the SAME public-visibility predicate AND has not started.
  // Native auctions and partner/imported EVENTS live in different tables (auctions vs events), so summing
  // them cannot double-count. Native "upcoming" = a syndicated, non-demo native auction still in
  // 'published' (not yet 'active'), matching the homepage classify() 'coming' semantics.
  const nativeUpcoming = (await db.query(
    `SELECT count(*)::int AS n FROM auctions a WHERE ${activeNativeAuctionSql('a')} AND a.state = 'published'`)).rows[0].n;
  const eventUpcoming = (await db.query(
    `SELECT count(*)::int AS n FROM events e WHERE ${activeEventSql('e')} AND e.start_at IS NOT NULL AND e.start_at > now()`)).rows[0].n;

  // PROFESSIONALS directory (a SEPARATE concept from the Marketplace product family). Broken out by
  // profession so the map key can show each category. profession_id: 3=auction houses, 4=estate-sale
  // companies, 5=appraisers.
  // Category = BD profession_id (3=auction houses, 4=estate-sale companies, 5=appraisers) when present,
  // else the native org's admin-granted professional capability. `companies` (total) is origin-agnostic;
  // buckets sum to it (a native org with no matching category falls to 'other', still counted in total).
  const prof = (await db.query(
    `SELECT COALESCE(
              CASE o.bd_metadata->>'profession_id'
                WHEN '3' THEN 'auction_houses' WHEN '4' THEN 'estate_sale_companies' WHEN '5' THEN 'appraisers' END,
              cap.cat, 'other') AS cat, count(*)::int AS n
       FROM organizations o
       LEFT JOIN LATERAL (
         SELECT CASE WHEN bool_or(capability = 'auction_house') THEN 'auction_houses'
                     WHEN bool_or(capability = 'estate_sale_company') THEN 'estate_sale_companies'
                     WHEN bool_or(capability = 'appraiser') THEN 'appraisers' END AS cat
           FROM organization_capabilities WHERE organization_id = o.id AND enabled = true
       ) cap ON true
      WHERE ${activeMarketplaceCompanySql('o')} GROUP BY 1`)).rows;
  const companies = prof.reduce((s, r) => s + r.n, 0);
  const professionals = { estate_sale_companies: 0, auction_houses: 0, appraisers: 0, total: companies };
  for (const r of prof) {
    if (professionals[r.cat] !== undefined) professionals[r.cat] += r.n;
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
    // Cross-family event STATUS counts (WHEN). Upcoming spans native auctions + partner/imported events;
    // Live/Ending remain native-auction concepts on the map key (preserved semantics). Deduped by design
    // (separate source tables). Feeds the homepage "Upcoming" legend count.
    statuses: {
      upcoming: nativeUpcoming + eventUpcoming,
      native_upcoming: nativeUpcoming,
      event_upcoming: eventUpcoming,
    },
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

module.exports = { activeEventSql, activeNativeAuctionSql, activeMarketplaceItemSql, activeMarketplaceCompanySql, eventKindSql, canonicalCounts };
