'use strict';

/**
 * Public discovery API — /api/public/*
 *
 * No authentication required. All responses use explicit field allowlists to
 * prevent accidental leakage of internal fields (seller_id FKs, reserve_cents,
 * winning_buyer_user_id, capabilities, admin flags, etc.).
 *
 * Cache-Control headers are set on every response for CDN/edge caching.
 *   LIVE_CACHE  — 30s  (active lots, single auction detail)
 *   PUBLIC_CACHE — 60s  (auction lists, featured lots)
 *   SLOW_CACHE  — 300s (seller profiles, featured videos)
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auctionScoreSQL } = require('../services/discoveryRankingService');

const LIVE_CACHE   = 's-maxage=30, stale-while-revalidate=10';
const PUBLIC_CACHE = 's-maxage=60, stale-while-revalidate=30';
const SLOW_CACHE   = 's-maxage=300, stale-while-revalidate=60';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validUuid(id) { return UUID_RE.test(id); }

// ── GET /api/public/auctions ──────────────────────────────────────────────────
// Paginated, filterable auction discovery feed.
//
// Query params:
//   state          — published | active | closed   (default: published + active)
//   city           — partial match, case-insensitive
//   address_state  — exact match, e.g. "TX"
//   auction_type   — matches public_auction_type
//   shipping       — "true" to require shipping_available = true
//   limit          — 1–100, default 20
//   offset         — default 0
router.get('/auctions', async (req, res, next) => {
  try {
    const q = req.query;
    const params = [];
    const where  = [];

    const VISIBLE_STATES = ['published', 'active', 'closed'];
    if (q.state && VISIBLE_STATES.includes(q.state)) {
      params.push(q.state);
      where.push(`a.state = $${params.length}`);
    } else {
      where.push(`a.state IN ('published', 'active')`);
    }

    if (q.city) {
      params.push(`%${q.city.trim()}%`);
      where.push(`a.city ILIKE $${params.length}`);
    }

    if (q.address_state) {
      params.push(q.address_state.trim().toUpperCase());
      where.push(`a.address_state = $${params.length}`);
    }

    if (q.auction_type) {
      params.push(q.auction_type.trim());
      where.push(`a.public_auction_type = $${params.length}`);
    }

    if (q.shipping === 'true') {
      where.push(`a.shipping_available = true`);
    }

    if (q.q && typeof q.q === 'string' && q.q.trim().length > 0) {
      params.push(`%${q.q.trim().slice(0, 100)}%`);
      const ki = params.length;
      where.push(`(a.title ILIKE $${ki} OR a.description ILIKE $${ki} OR a.city ILIKE $${ki})`);
    }

    const limit  = Math.min(Math.max(parseInt(q.limit,  10) || 20, 1), 100);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    params.push(limit);
    const li = params.length;
    params.push(offset);
    const oi = params.length;

    const { rows } = await db.query(`
      SELECT a.id,
             a.title,
             a.subtitle,
             a.description,
             a.public_auction_type,
             a.state,
             a.city,
             a.address_state,
             a.zip,
             a.shipping_available,
             a.start_time,
             a.end_time,
             a.pickup_window_start,
             a.pickup_window_end,
             a.preview_start,
             a.preview_end,
             a.cover_image_url,
             a.banner_image_url,
             a.created_at,
             COUNT(l.id)::int   AS lot_count,
             COUNT(l.id) FILTER (WHERE l.shippable = true)::int AS shippable_lot_count,
             sp.display_name    AS seller_display_name,
             sp.location_label  AS seller_location_label,
             sp.logo_url        AS seller_logo_url,
             COUNT(*) OVER()    AS total_count
        FROM auctions a
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
        LEFT JOIN lots l ON l.auction_id = a.id AND l.state != 'withdrawn'
       WHERE ${where.join(' AND ')}
       GROUP BY a.id, sp.id
       ORDER BY ${auctionScoreSQL('a')} DESC, a.id ASC
       LIMIT $${li} OFFSET $${oi}
    `, params);

    const total_count = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    const data = rows.map(({ total_count: _tc, ...rest }) => rest);
    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ success: true, data, total_count, has_more: offset + data.length < total_count, offset, limit });
  } catch (err) { next(err); }
});

// ── GET /api/public/auctions/near ─────────────────────────────────────────────
// Radius-based auction discovery using Haversine distance.
// Only returns auctions that have lat/lng coordinates set (admin-populated).
// Results ordered by distance ascending, then marketplace_priority descending.
//
// Required query params:
//   lat        — latitude  (-90 to 90)
//   lng        — longitude (-180 to 180)
//
// Optional query params:
//   radius_km  — search radius in km (1–800, default 100)
//   shipping   — "true" to require shipping_available = true
//   limit      — 1–100, default 20
//   offset     — default 0
router.get('/auctions/near', async (req, res, next) => {
  try {
    const q = req.query;

    const lat      = parseFloat(q.lat);
    const lng      = parseFloat(q.lng);
    const radiusKm = Math.min(Math.max(parseFloat(q.radius_km) || 100, 1), 800);

    if (!q.lat || !q.lng || isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    }
    if (lat < -90 || lat > 90) {
      return res.status(400).json({ success: false, message: 'lat must be between -90 and 90' });
    }
    if (lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, message: 'lng must be between -180 and 180' });
    }

    const limit  = Math.min(Math.max(parseInt(q.limit,  10) || 20, 1), 100);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

    const extraWhere = q.shipping === 'true' ? 'AND a.shipping_available = true' : '';

    // Haversine distance computed in subquery so it can be referenced in outer WHERE + ORDER BY.
    // marketplace_priority included in subquery for secondary sort; excluded from outer SELECT.
    const { rows } = await db.query(`
      SELECT id, title, subtitle, description, public_auction_type,
             state, city, address_state, zip,
             shipping_available, start_time, end_time,
             pickup_window_start, pickup_window_end,
             preview_start, preview_end,
             cover_image_url, banner_image_url, created_at,
             lot_count, shippable_lot_count,
             seller_display_name, seller_location_label, seller_logo_url,
             distance_km,
             COUNT(*) OVER() AS total_count
        FROM (
          SELECT a.id,
                 a.title,
                 a.subtitle,
                 a.description,
                 a.public_auction_type,
                 a.state,
                 a.city,
                 a.address_state,
                 a.zip,
                 a.shipping_available,
                 a.start_time,
                 a.end_time,
                 a.pickup_window_start,
                 a.pickup_window_end,
                 a.preview_start,
                 a.preview_end,
                 a.cover_image_url,
                 a.banner_image_url,
                 a.created_at,
                 a.marketplace_priority,
                 COUNT(l.id)::int AS lot_count,
                 COUNT(l.id) FILTER (WHERE l.shippable = true)::int AS shippable_lot_count,
                 sp.display_name    AS seller_display_name,
                 sp.location_label  AS seller_location_label,
                 sp.logo_url        AS seller_logo_url,
                 6371.0 * acos(
                   LEAST(1.0,
                     cos(radians(a.lat)) * cos(radians($1::float))
                     * cos(radians(a.lng) - radians($2::float))
                     + sin(radians(a.lat)) * sin(radians($1::float))
                   )
                 ) AS distance_km,
                 ${auctionScoreSQL('a')} AS ranking_score
            FROM auctions a
            LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
            LEFT JOIN lots l ON l.auction_id = a.id AND l.state != 'withdrawn'
           WHERE a.lat IS NOT NULL
             AND a.lng IS NOT NULL
             AND a.state IN ('published', 'active')
             ${extraWhere}
           GROUP BY a.id, sp.id
        ) sub
       WHERE sub.distance_km <= $3::float
       ORDER BY sub.distance_km ASC, sub.ranking_score DESC, sub.id ASC
       LIMIT $4 OFFSET $5
    `, [lat, lng, radiusKm, limit, offset]);

    const total_count = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    const data = rows.map(({ total_count: _tc, ...rest }) => rest);
    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ success: true, data, total_count, has_more: offset + data.length < total_count, offset, limit });
  } catch (err) { next(err); }
});

// ── GET /api/public/auctions/:id ──────────────────────────────────────────────
// Single auction detail. Only published/active/closed auctions are visible.
// Includes auction_terms and full seller profile snapshot.
router.get('/auctions/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!validUuid(id)) return res.status(404).json({ success: false, message: 'Auction not found' });

    const { rows } = await db.query(`
      SELECT a.id,
             a.title,
             a.subtitle,
             a.description,
             a.auction_terms,
             a.public_auction_type,
             a.state,
             a.city,
             a.address_state,
             a.zip,
             a.shipping_available,
             a.start_time,
             a.end_time,
             a.pickup_window_start,
             a.pickup_window_end,
             a.preview_start,
             a.preview_end,
             a.cover_image_url,
             a.banner_image_url,
             a.created_at,
             COUNT(l.id)::int   AS lot_count,
             sp.id              AS seller_profile_id,
             sp.display_name    AS seller_display_name,
             sp.bio             AS seller_bio,
             sp.location_label  AS seller_location_label,
             sp.logo_url        AS seller_logo_url,
             sp.seller_type
        FROM auctions a
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
        LEFT JOIN lots l ON l.auction_id = a.id AND l.state != 'withdrawn'
       WHERE a.id = $1
         AND a.state IN ('published', 'active', 'closed')
       GROUP BY a.id, sp.id
    `, [id]);

    if (!rows.length) return res.status(404).json({ success: false, message: 'Auction not found' });
    res.set('Cache-Control', LIVE_CACHE);
    return res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /api/public/auctions/:id/lots ─────────────────────────────────────────
// Paginated lot listing for a single auction.
// Withdrawn lots are excluded. Sensitive fields (reserve, winner) are not selected.
//
// Query params: limit (1–200, default 50), offset (default 0)
router.get('/auctions/:id/lots', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!validUuid(id)) return res.status(404).json({ success: false, message: 'Auction not found' });

    const limit  = Math.min(Math.max(parseInt(req.query.limit,  10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const auctionCheck = await db.query(
      `SELECT id FROM auctions WHERE id = $1 AND state IN ('published', 'active', 'closed')`,
      [id]
    );
    if (!auctionCheck.rows.length) {
      return res.status(404).json({ success: false, message: 'Auction not found' });
    }

    const { rows } = await db.query(`
      SELECT l.id,
             l.auction_id,
             l.lot_number,
             l.title,
             l.description,
             l.size_category,
             l.condition,
             l.material,
             l.era,
             l.maker_artist,
             l.weight,
             l.thumbnail_url,
             l.images_count,
             l.is_featured,
             l.state,
             l.starting_bid_cents,
             l.current_bid_cents,
             l.bid_count,
             l.closes_at,
             l.extended_until,
             l.shippable,
             l.shipping_cost_cents,
             l.shipping_notes,
             COUNT(*) OVER() AS total_count
        FROM lots l
       WHERE l.auction_id = $1
         AND l.state != 'withdrawn'
       ORDER BY l.lot_number ASC
       LIMIT $2 OFFSET $3
    `, [id, limit, offset]);

    const total_count = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    const data = rows.map(({ total_count: _tc, ...rest }) => rest);
    res.set('Cache-Control', LIVE_CACHE);
    return res.json({ success: true, data, total_count, has_more: offset + data.length < total_count, offset, limit });
  } catch (err) { next(err); }
});

// ── GET /api/public/featured-lots ─────────────────────────────────────────────
// Cross-auction featured lots for marketplace showcase.
//
// Query params:
//   auction_state — published | active | closed (default: published + active)
//   limit         — 1–100, default 20
router.get('/featured-lots', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    const validAS = ['published', 'active', 'closed'];
    const as = req.query.auction_state;
    let stateClause = `a.state IN ('published', 'active')`;
    if (as && validAS.includes(as)) stateClause = `a.state = '${as}'`;

    const { rows } = await db.query(`
      SELECT l.id,
             l.auction_id,
             l.lot_number,
             l.title,
             l.description,
             l.size_category,
             l.condition,
             l.material,
             l.thumbnail_url,
             l.images_count,
             l.state            AS lot_state,
             l.starting_bid_cents,
             l.current_bid_cents,
             l.bid_count,
             l.closes_at,
             l.shippable,
             l.shipping_cost_cents,
             a.id               AS auction_id,
             a.title            AS auction_title,
             a.state            AS auction_state,
             a.city             AS auction_city,
             a.address_state    AS auction_address_state,
             a.end_time         AS auction_end_time,
             a.cover_image_url  AS auction_cover_image_url,
             sp.display_name    AS seller_display_name,
             sp.location_label  AS seller_location_label,
             sp.logo_url        AS seller_logo_url
        FROM lots l
        JOIN auctions a ON a.id = l.auction_id
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
       WHERE l.is_featured = true
         AND l.state != 'withdrawn'
         AND ${stateClause}
       ORDER BY ${auctionScoreSQL('a')} DESC, l.lot_number ASC, l.id ASC
       LIMIT $1
    `, [limit]);

    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/featured-auctions ────────────────────────────────────────
// Featured auction feed for marketplace widgets.
// Only returns published/active auctions with marketplace_priority > 0.
//
// Optional query params:
//   lat        — latitude  for "near me" filtering
//   lng        — longitude for "near me" filtering (required if lat provided)
//   radius_km  — radius in km when lat/lng used (1–800, default 200)
//   limit      — 1–50, default 12
//
// When lat/lng provided: filters by radius, adds distance_km to each result,
//   sorts by distance_km ASC.
// Without lat/lng: returns all featured auctions sorted by priority DESC.
router.get('/featured-auctions', async (req, res, next) => {
  try {
    const q     = req.query;
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 12, 1), 50);

    const hasLat = q.lat != null;
    const hasLng = q.lng != null;
    const hasGeo = hasLat && hasLng;
    let lat, lng, radiusKm;

    // Reject partial coordinate pairs
    if (hasLat !== hasLng) {
      return res.status(400).json({ success: false, message: 'Both lat and lng are required together' });
    }

    if (hasGeo) {
      lat      = parseFloat(q.lat);
      lng      = parseFloat(q.lng);
      radiusKm = Math.min(Math.max(parseFloat(q.radius_km) || 200, 1), 800);
      if (isNaN(lat) || isNaN(lng)) {
        return res.status(400).json({ success: false, message: 'lat and lng must be valid numbers' });
      }
      if (lat < -90 || lat > 90) {
        return res.status(400).json({ success: false, message: 'lat must be between -90 and 90' });
      }
      if (lng < -180 || lng > 180) {
        return res.status(400).json({ success: false, message: 'lng must be between -180 and 180' });
      }
    }

    let rows;

    if (hasGeo) {
      // Geo-filtered: subquery computes distance, outer query filters + sorts
      ({ rows } = await db.query(`
        SELECT id, title, subtitle, description, public_auction_type,
               state, city, address_state, zip,
               shipping_available, start_time, end_time,
               preview_start, preview_end,
               cover_image_url, banner_image_url, created_at,
               lot_count, shippable_lot_count,
               seller_display_name, seller_location_label, seller_logo_url,
               distance_km
          FROM (
            SELECT a.id,
                   a.title,
                   a.subtitle,
                   a.description,
                   a.public_auction_type,
                   a.state,
                   a.city,
                   a.address_state,
                   a.zip,
                   a.shipping_available,
                   a.start_time,
                   a.end_time,
                   a.preview_start,
                   a.preview_end,
                   a.cover_image_url,
                   a.banner_image_url,
                   a.created_at,
                   a.marketplace_priority,
                   COUNT(lo.id)::int AS lot_count,
                   COUNT(lo.id) FILTER (WHERE lo.shippable = true)::int AS shippable_lot_count,
                   sp.display_name    AS seller_display_name,
                   sp.location_label  AS seller_location_label,
                   sp.logo_url        AS seller_logo_url,
                   CASE
                     WHEN a.lat IS NOT NULL AND a.lng IS NOT NULL
                     THEN 6371.0 * acos(
                            LEAST(1.0,
                              cos(radians(a.lat)) * cos(radians($1::float))
                              * cos(radians(a.lng) - radians($2::float))
                              + sin(radians(a.lat)) * sin(radians($1::float))
                            )
                          )
                     ELSE NULL
                   END AS distance_km,
                   ${auctionScoreSQL('a')} AS ranking_score
              FROM auctions a
              LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
              LEFT JOIN lots lo ON lo.auction_id = a.id AND lo.state != 'withdrawn'
             WHERE a.state IN ('published', 'active')
               AND a.marketplace_priority > 0
             GROUP BY a.id, sp.id
          ) sub
         WHERE sub.distance_km IS NULL OR sub.distance_km <= $3::float
         ORDER BY sub.distance_km ASC NULLS LAST, sub.ranking_score DESC, sub.id ASC
         LIMIT $4
      `, [lat, lng, radiusKm, limit]));
    } else {
      // No geo: national featured feed ordered by priority
      ({ rows } = await db.query(`
        SELECT a.id,
               a.title,
               a.subtitle,
               a.description,
               a.public_auction_type,
               a.state,
               a.city,
               a.address_state,
               a.zip,
               a.shipping_available,
               a.start_time,
               a.end_time,
               a.preview_start,
               a.preview_end,
               a.cover_image_url,
               a.banner_image_url,
               a.created_at,
               COUNT(lo.id)::int AS lot_count,
               COUNT(lo.id) FILTER (WHERE lo.shippable = true)::int AS shippable_lot_count,
               sp.display_name    AS seller_display_name,
               sp.location_label  AS seller_location_label,
               sp.logo_url        AS seller_logo_url
          FROM auctions a
          LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
          LEFT JOIN lots lo ON lo.auction_id = a.id AND lo.state != 'withdrawn'
         WHERE a.state IN ('published', 'active')
           AND a.marketplace_priority > 0
         GROUP BY a.id, sp.id
         ORDER BY ${auctionScoreSQL('a')} DESC, a.id ASC
         LIMIT $1
      `, [limit]));
    }

    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/featured-videos ───────────────────────────────────────────
// Approved, publicly-visible walkthrough videos (visible_public = true).
// Only admin-approved and explicitly published videos appear here.
//
// Query params: limit (1–50, default 10)
router.get('/featured-videos', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

    const { rows } = await db.query(`
      SELECT v.id,
             v.auction_id,
             v.video_url,
             v.title,
             v.caption,
             a.title         AS auction_title,
             a.city          AS auction_city,
             a.address_state AS auction_address_state,
             a.state         AS auction_state,
             a.end_time      AS auction_end_time,
             sp.display_name AS seller_display_name
        FROM auction_walkthrough_videos v
        JOIN auctions a ON a.id = v.auction_id
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
       WHERE v.visible_public = true
         AND v.review_status = 'approved'
       ORDER BY v.created_at DESC
       LIMIT $1
    `, [limit]);

    res.set('Cache-Control', SLOW_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/locations ─────────────────────────────────────────────────
// City/state aggregation for marketplace discovery navigation.
// Returns distinct city+state combinations with auction counts,
// ordered by active auction count descending.
//
// Query params:
//   address_state — filter by state abbreviation (e.g. "TX")
//   limit         — 1–500, default 200
router.get('/locations', async (req, res, next) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const params = [limit];
    const stateFilter = req.query.address_state
      ? `AND a.address_state = $2`
      : '';
    if (req.query.address_state) {
      params.push(req.query.address_state.trim().toUpperCase());
    }

    const { rows } = await db.query(`
      SELECT a.city,
             a.address_state,
             COUNT(DISTINCT a.id)::int AS auction_count,
             COUNT(DISTINCT a.id) FILTER (
               WHERE a.state IN ('published', 'active')
             )::int AS active_count
        FROM auctions a
       WHERE a.city IS NOT NULL
         AND a.address_state IS NOT NULL
         AND a.state IN ('published', 'active', 'closed')
         ${stateFilter}
       GROUP BY a.city, a.address_state
       ORDER BY active_count DESC, auction_count DESC
       LIMIT $1
    `, params);

    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/sellers/:sellerId/profile ─────────────────────────────────
// Public seller profile. Only visible if the seller has at least one
// published, active, or closed auction (prevents scraping private drafts).
router.get('/sellers/:sellerId/profile', async (req, res, next) => {
  try {
    const { sellerId } = req.params;
    if (!validUuid(sellerId)) return res.status(404).json({ success: false, message: 'Seller not found' });

    const { rows } = await db.query(`
      SELECT sp.id              AS id,
             sp.display_name,
             sp.bio,
             sp.location_label,
             sp.logo_url,
             sp.seller_type,
             COUNT(DISTINCT a.id) FILTER (
               WHERE a.state IN ('published', 'active', 'closed')
             )::int AS auction_count,
             COUNT(DISTINCT a.id) FILTER (
               WHERE a.state IN ('published', 'active')
             )::int AS active_auction_count
        FROM seller_profiles sp
        LEFT JOIN auctions a ON a.seller_id = sp.id
       WHERE sp.id = $1
         AND EXISTS (
               SELECT 1 FROM auctions ea
                WHERE ea.seller_id = sp.id
                  AND ea.state IN ('published', 'active', 'closed')
             )
       GROUP BY sp.id
    `, [sellerId]);

    if (!rows.length) return res.status(404).json({ success: false, message: 'Seller not found' });
    res.set('Cache-Control', SLOW_CACHE);
    return res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /api/public/config ────────────────────────────────────────────────────
// Returns safe marketplace-facing configuration for widget consumption.
// Only exposes presentation variables (badge labels, CTA copy, card controls).
// Never exposes pricing, ranking weights, admin notes, or internal fields.
//
// Widgets call this endpoint via AAPConfig.loadRemote() to receive admin-edited
// values without a page reload or code deploy. 5-minute cache is intentional —
// config changes are low-urgency and cache miss pressure is low.
router.get('/config', async (req, res, next) => {
  try {
    const { PUBLIC_KEY_ALLOWLIST } = require('./adminConfig');
    const publicKeys = Array.from(PUBLIC_KEY_ALLOWLIST);

    const { rows } = await db.query(
      `SELECT key, value
         FROM platform_settings
        WHERE key = ANY($1::text[])`,
      [publicKeys]
    );

    const data = {};
    rows.forEach(r => { data[r.key] = r.value; });

    res.set('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── GET /api/public/lots/ending-soon ─────────────────────────────────────────
// Individual lots closing within 48 hours, sorted most-urgent first.
//
// Query params:
//   limit — 1–50, default 20
router.get('/lots/ending-soon', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    const { rows } = await db.query(`
      SELECT l.id,
             l.auction_id,
             l.lot_number,
             l.title,
             l.thumbnail_url,
             l.images_count,
             l.state            AS lot_state,
             l.starting_bid_cents,
             l.current_bid_cents,
             l.bid_count,
             l.closes_at,
             l.shippable,
             (SELECT COUNT(*)::int FROM watchlists w WHERE w.lot_id = l.id) AS watch_count,
             a.id               AS auction_id,
             a.title            AS auction_title,
             a.state            AS auction_state,
             a.end_time         AS auction_end_time,
             sp.display_name    AS seller_display_name
        FROM lots l
        JOIN auctions a ON a.id = l.auction_id
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
       WHERE l.state = 'open'
         AND l.closes_at > NOW()
         AND l.closes_at <= NOW() + INTERVAL '48 hours'
         AND a.state = 'active'
       ORDER BY l.closes_at ASC
       LIMIT $1
    `, [limit]);

    res.set('Cache-Control', LIVE_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/lots/recently-added ──────────────────────────────────────
// Lots added in the last 21 days, newest first.
//
// Query params:
//   limit — 1–50, default 20
router.get('/lots/recently-added', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    const { rows } = await db.query(`
      SELECT l.id,
             l.auction_id,
             l.lot_number,
             l.title,
             l.thumbnail_url,
             l.images_count,
             l.state            AS lot_state,
             l.starting_bid_cents,
             l.current_bid_cents,
             l.bid_count,
             l.closes_at,
             l.created_at,
             l.shippable,
             (SELECT COUNT(*)::int FROM watchlists w WHERE w.lot_id = l.id) AS watch_count,
             a.id               AS auction_id,
             a.title            AS auction_title,
             a.state            AS auction_state,
             a.end_time         AS auction_end_time,
             sp.display_name    AS seller_display_name
        FROM lots l
        JOIN auctions a ON a.id = l.auction_id
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
       WHERE l.state != 'withdrawn'
         AND l.created_at >= NOW() - INTERVAL '21 days'
         AND a.state IN ('published', 'active')
       ORDER BY l.created_at DESC
       LIMIT $1
    `, [limit]);

    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/lots/trending ─────────────────────────────────────────────
// Most-bid lots in active auctions, sorted by bid activity descending.
//
// Query params:
//   limit — 1–50, default 20
router.get('/lots/trending', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    const { rows } = await db.query(`
      SELECT l.id,
             l.auction_id,
             l.lot_number,
             l.title,
             l.thumbnail_url,
             l.images_count,
             l.state            AS lot_state,
             l.starting_bid_cents,
             l.current_bid_cents,
             l.bid_count,
             l.closes_at,
             l.shippable,
             (SELECT COUNT(*)::int FROM watchlists w WHERE w.lot_id = l.id) AS watch_count,
             a.id               AS auction_id,
             a.title            AS auction_title,
             a.state            AS auction_state,
             a.end_time         AS auction_end_time,
             sp.display_name    AS seller_display_name
        FROM lots l
        JOIN auctions a ON a.id = l.auction_id
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
       WHERE l.state = 'open'
         AND l.bid_count >= 1
         AND a.state = 'active'
       ORDER BY l.bid_count DESC, l.closes_at ASC
       LIMIT $1
    `, [limit]);

    res.set('Cache-Control', LIVE_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/config/widgets/:slug ─────────────────────────────────────
// Returns public widget defaults for a given widget slug.
// Widgets use this to fetch their specific display defaults at init time.
const ALLOWED_WIDGET_SLUGS = ['featured-lots', 'featured-near-you'];

router.get('/config/widgets/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!ALLOWED_WIDGET_SLUGS.includes(slug)) {
      return res.status(404).json({ success: false, message: 'Widget not found' });
    }

    const { rows } = await db.query(
      `SELECT settings FROM widget_settings WHERE widget_slug = $1`,
      [slug]
    );

    const settings = rows.length ? rows[0].settings : {};
    res.set('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.json({ success: true, data: { widget_slug: slug, settings } });
  } catch (err) { next(err); }
});

module.exports = router;
