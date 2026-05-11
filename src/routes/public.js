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
             sp.display_name    AS seller_display_name,
             sp.location_label  AS seller_location_label,
             sp.logo_url        AS seller_logo_url
        FROM auctions a
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
        LEFT JOIN lots l ON l.auction_id = a.id AND l.state != 'withdrawn'
       WHERE ${where.join(' AND ')}
       GROUP BY a.id, sp.id
       ORDER BY a.marketplace_priority DESC, a.start_time DESC
       LIMIT $${li} OFFSET $${oi}
    `, params);

    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ success: true, data: rows });
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
             l.shipping_notes
        FROM lots l
       WHERE l.auction_id = $1
         AND l.state != 'withdrawn'
       ORDER BY l.lot_number ASC
       LIMIT $2 OFFSET $3
    `, [id, limit, offset]);

    res.set('Cache-Control', LIVE_CACHE);
    return res.json({ success: true, data: rows });
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
             a.cover_image_url  AS auction_cover_image_url
        FROM lots l
        JOIN auctions a ON a.id = l.auction_id
       WHERE l.is_featured = true
         AND l.state != 'withdrawn'
         AND ${stateClause}
       ORDER BY a.marketplace_priority DESC, l.lot_number ASC
       LIMIT $1
    `, [limit]);

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
             a.end_time      AS auction_end_time
        FROM auction_walkthrough_videos v
        JOIN auctions a ON a.id = v.auction_id
       WHERE v.visible_public = true
         AND v.review_status = 'approved'
       ORDER BY v.created_at DESC
       LIMIT $1
    `, [limit]);

    res.set('Cache-Control', SLOW_CACHE);
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

module.exports = router;
