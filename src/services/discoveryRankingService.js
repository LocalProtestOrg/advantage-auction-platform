'use strict';

/**
 * Advantage Auction Platform — Discovery Ranking Service
 *
 * Deterministic, additive marketplace ranking for auction discovery feeds.
 *
 * V1 SCORING MODEL
 *   Score = featured_score + freshness_score + shipping_score
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
 *   marketplace_priority, created_at, shipping_available
 *
 * No query parameters are introduced — all constants are inlined as
 * numeric literals. The expression is idempotent and deterministic for
 * any given snapshot of the row.
 *
 * NULL handling:
 *   marketplace_priority NULL  → treated as 0 (no featured boost)
 *   created_at NULL            → EXTRACT returns NULL → GREATEST clips to 0
 *   shipping_available NULL    → CASE ELSE 0.0 (no shipping boost)
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
  )`;
}

module.exports = { RANKING_WEIGHTS, auctionScoreSQL };
