'use strict';

/**
 * Advantage Auction Platform — Discovery Ranking Service
 *
 * Deterministic, additive marketplace ranking for auction discovery feeds.
 *
 * V1 SCORING MODEL
 *   Score = featured_score + freshness_score + shipping_score + cover_image_score
 *
 *   featured_score:
 *     Auctions with marketplace_priority > 0 receive FEATURED_BASE + priority
 *     (capped). This guarantees every featured auction outranks every
 *     non-featured auction regardless of freshness or shipping.
 *
 *   freshness_score:
 *     Brand-new auction: FRESHNESS_MAX points.
 *     Decays linearly to 0 at FRESHNESS_DECAY_DAYS days old.
 *     Older auctions: 0. Prevents score from going negative.
 *
 *   shipping_score:
 *     Flat SHIPPING points for shipping-enabled auctions.
 *     NULL shipping_available treated as false (0 boost).
 *
 *   geo_signal:
 *     Handled by distance_km ASC ordering in geo-aware endpoints.
 *     Not incorporated into this composite score (v1 design choice).
 *     Future: blend distance_km inverse into score for single-sort ranking.
 *
 * TIE-BREAKING
 *   All ORDER BY clauses append `id ASC` after score DESC to guarantee
 *   deterministic page-stable ordering across calls. UUID ordering is stable
 *   within a Postgres session.
 *
 * SCORE IS INTERNAL
 *   The ranking score is used only in ORDER BY — it is never selected into
 *   response rows and never appears in any API response envelope.
 *
 * FUTURE EXPANSION HOOKS (not v1)
 *   - Engagement signal: bid_count, view_count from analytics_events
 *   - Seller reputation: seller_score from seller_profiles fields
 *   - Admin-configurable weights via platform_settings table
 *   - Geo blend: replace two-sort (distance ASC, score DESC) with one
 *     composite score that incorporates inverse distance
 *
 * LOAD ORDER
 *   Required by: src/routes/public.js
 *   Requires:    nothing (pure function, no DB access)
 */

/**
 * V1 ranking weight constants.
 *
 * These are the tuning levers for the scoring model. Future: load from
 * platform_settings via AAPConfig so admin can adjust without a deploy.
 */
const RANKING_WEIGHTS = {
  // Featured tier floor — guarantees featured > non-featured separation.
  // Any auction with marketplace_priority > 0 earns at least this many points.
  featured_base:          100,

  // marketplace_priority contribution per unit (capped to prevent extreme outliers).
  // priority 1 → +1 pt, priority 50+ → +50 pts (cap).
  featured_priority_cap:   50,

  // Maximum freshness bonus (brand-new auction).
  freshness_max:           30,

  // Days until freshness score fully decays to zero.
  freshness_decay_days:    30,

  // Flat shipping availability boost.
  shipping:                15,

  // Flat boost for auctions that have a cover image set.
  // Surfaces complete listings above image-less drafts in discovery.
  cover_image:              5,

  // ── Future placeholders (not implemented in v1) ────────────────────────────
  // engagement_per_bid:    0,
  // engagement_bid_cap:    0,
  // seller_reputation:     0,
};

/**
 * Returns a SQL expression that computes the v1 ranking score for one
 * auction row. Safe to embed in ORDER BY or a SELECT alias.
 *
 * The expression references only lightweight, indexed columns:
 *   marketplace_priority, created_at, shipping_available, cover_image_url
 *
 * No query parameters are introduced — all constants are inlined as
 * numeric literals. The expression is idempotent and deterministic for
 * any given snapshot of the row.
 *
 * NULL handling:
 *   marketplace_priority NULL  → treated as 0 (no featured boost)
 *   created_at NULL            → EXTRACT returns NULL → GREATEST clips to 0
 *   shipping_available NULL    → CASE ELSE 0.0 (no shipping boost)
 *   cover_image_url NULL       → CASE ELSE 0.0 (no cover image boost)
 *
 * @param {string} alias  — SQL alias of the auctions table (default 'a')
 * @returns {string}       SQL fragment, no parameters needed
 */
function auctionScoreSQL(alias) {
  const t  = alias || 'a';
  const w  = RANKING_WEIGHTS;
  const ds = w.freshness_decay_days * 86400;  // decay window in seconds

  return `(
    CASE WHEN ${t}.marketplace_priority > 0
      THEN ${w.featured_base}.0
           + LEAST(${t}.marketplace_priority::float, ${w.featured_priority_cap}.0)
      ELSE 0.0
    END
    + GREATEST(0.0,
        ${w.freshness_max}.0
        * (1.0 - EXTRACT(EPOCH FROM (NOW() - ${t}.created_at)) / ${ds}.0)
      )
    + CASE WHEN ${t}.shipping_available = true THEN ${w.shipping}.0 ELSE 0.0 END
    + CASE WHEN ${t}.cover_image_url IS NOT NULL THEN ${w.cover_image}.0 ELSE 0.0 END
  )`;
}

/**
 * V1 lot-level discovery ranking weights (Featured Items Available Now).
 *
 * Blends objective, already-available signals only (no subjective AI scoring in v1).
 * Centralized + configurable here; future: load from platform_settings via AAPConfig.
 * The relative proportions mirror the approved product spec (image/freshness/urgency/
 * engagement/completeness/fulfillment). Diversity + exploration are applied AFTER this
 * score, as a deterministic post-rank interleave in discoveryService (not in SQL).
 */
const LOT_RANKING_WEIGHTS = {
  // Image quality & completeness (objective): has a primary image, plus a bonus for multiple.
  image_primary:      20,   // thumbnail_url present
  image_multiple:     8,    // images_count > 1 (added on top of image_primary)

  // Freshness — full points brand-new, linear decay to 0 over the window.
  freshness_max:      15,
  freshness_days:     21,

  // Closing urgency — tiered boost; capped so not everything reads as "ending soon".
  urgency_lt2h:       15,
  urgency_lt12h:      11,
  urgency_lt24h:      8,
  urgency_lt3d:       4,
  // >3d: 0

  // Engagement — bids + watches, each capped so older lots don't runaway-dominate.
  engagement_per_bid:   1.5,
  engagement_bid_cap:   12,   // max points from bids
  engagement_per_watch: 1.0,
  engagement_watch_cap: 6,    // max points from watches

  // Listing completeness — reward useful public detail.
  complete_description: 3,   // non-empty description
  complete_category:    3,   // category present
  complete_condition:   2,   // condition present
  complete_dimensions:  2,   // dimensions present

  // Fulfillment usefulness — modest boost; do NOT bury local-pickup-only inventory.
  fulfillment_ships:    5,
  fulfillment_pickup:   3,
};

/**
 * SQL expression computing the v1 lot discovery score for one lot row. Safe to embed
 * in ORDER BY or a SELECT alias. References only lightweight lot columns plus a
 * pre-computed watch-count expression (passed in, since it comes from a subquery/join).
 *
 * @param {string} lotAlias   — SQL alias of the lots table (default 'l')
 * @param {string} watchExpr  — SQL expression yielding the watch count (default '0')
 * @returns {string}           SQL fragment, no bind parameters introduced
 */
function lotDiscoveryScoreSQL(lotAlias, watchExpr) {
  const l = lotAlias || 'l';
  const wc = watchExpr || '0';
  const w = LOT_RANKING_WEIGHTS;
  const freshSecs = w.freshness_days * 86400;
  return `(
    CASE WHEN ${l}.thumbnail_url IS NOT NULL AND ${l}.thumbnail_url <> '' THEN ${w.image_primary}.0 ELSE 0.0 END
    + CASE WHEN COALESCE(${l}.images_count, 0) > 1 THEN ${w.image_multiple}.0 ELSE 0.0 END
    + GREATEST(0.0, ${w.freshness_max}.0 * (1.0 - EXTRACT(EPOCH FROM (NOW() - ${l}.created_at)) / ${freshSecs}.0))
    + CASE
        WHEN ${l}.closes_at IS NULL THEN 0.0
        WHEN ${l}.closes_at <= NOW() + INTERVAL '2 hours'  THEN ${w.urgency_lt2h}.0
        WHEN ${l}.closes_at <= NOW() + INTERVAL '12 hours' THEN ${w.urgency_lt12h}.0
        WHEN ${l}.closes_at <= NOW() + INTERVAL '24 hours' THEN ${w.urgency_lt24h}.0
        WHEN ${l}.closes_at <= NOW() + INTERVAL '3 days'   THEN ${w.urgency_lt3d}.0
        ELSE 0.0
      END
    + LEAST(${w.engagement_bid_cap}.0, COALESCE(${l}.bid_count, 0) * ${w.engagement_per_bid})
    + LEAST(${w.engagement_watch_cap}.0, (${wc}) * ${w.engagement_per_watch})
    + CASE WHEN ${l}.description IS NOT NULL AND length(trim(${l}.description)) > 0 THEN ${w.complete_description}.0 ELSE 0.0 END
    + CASE WHEN ${l}.category IS NOT NULL AND ${l}.category <> '' THEN ${w.complete_category}.0 ELSE 0.0 END
    + CASE WHEN ${l}.condition IS NOT NULL AND ${l}.condition <> '' THEN ${w.complete_condition}.0 ELSE 0.0 END
    + CASE WHEN ${l}.dimensions IS NOT NULL AND ${l}.dimensions <> '{}'::jsonb AND ${l}.dimensions <> 'null'::jsonb THEN ${w.complete_dimensions}.0 ELSE 0.0 END
    + CASE WHEN ${l}.shippable = true THEN ${w.fulfillment_ships}.0 ELSE 0.0 END
    + CASE WHEN ${l}.pickup_category IS NOT NULL AND ${l}.pickup_category <> '' THEN ${w.fulfillment_pickup}.0 ELSE 0.0 END
  )`;
}

module.exports = { RANKING_WEIGHTS, auctionScoreSQL, LOT_RANKING_WEIGHTS, lotDiscoveryScoreSQL };
