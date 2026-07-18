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
const { buildLotSearch, clampInt } = require('../services/searchService');

const LIVE_CACHE   = 's-maxage=30, stale-while-revalidate=10';
const PUBLIC_CACHE = 's-maxage=60, stale-while-revalidate=30';
const SLOW_CACHE   = 's-maxage=300, stale-while-revalidate=60';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validUuid(id) { return UUID_RE.test(id); }

// ── GET /api/public/map-config ──────────────────────────────────────────────────
// Client basemap configuration for the Living Map homepage. Returns a MapTiler
// style URL built from the MAPTILER_KEY env var (a domain-restricted, client-side
// key — safe to expose), and falls back to CARTO's key-free styles for local/dev
// when the env var is absent. No secret is stored in the repo.
router.get('/map-config', (req, res) => {
  const key = process.env.MAPTILER_KEY;
  const cfg = key
    ? { provider: 'maptiler',
        styleLight: `https://api.maptiler.com/maps/dataviz/style.json?key=${encodeURIComponent(key)}`,
        styleDark:  `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${encodeURIComponent(key)}` }
    : { provider: 'carto',
        styleLight: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
        styleDark:  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' };
  res.set('Cache-Control', SLOW_CACHE);
  res.json({ success: true, ...cfg });
});

// ── GET /api/public/marketplace ───────────────────────────────────────────────
// Marketplace partner pins for the Living Map (Marketplace Map Phase 1). Serves the
// Brilliant Directories MIRROR that already lives in Railway (organizations rows with
// source='bd_import'). This endpoint NEVER calls BD per request, never exposes BD
// credentials to the browser, and never depends on an MCP session — it only reads the
// curated, geocoded, server-side mirror.
//
// Privacy posture (Phase 1): only public, geocoded, non-sample company records are
// returned. PII (phone / email) and deliberately-withheld logos are NOT surfaced.
// Raw BD profession_id stays in bd_metadata so the taxonomy can be refined later.
// `label` is the PLURAL group label (used by the map legend); `singular` is the
// individual-entity label shown on a single company's profile card. They are kept as
// separate display values on purpose — a card must never inherit the plural legend text.
const MP_CATEGORY = {
  '3': { key: 'auction_houses',        label: 'Auction Houses',        singular: 'Auction House' },
  '4': { key: 'estate_sale_companies', label: 'Estate Sale Companies', singular: 'Estate Sale Company' },
  '5': { key: 'appraisers',            label: 'Appraisers',            singular: 'Appraiser' },
};
const MP_DEFAULT = { key: 'estate_services', label: 'Other Estate Services', singular: 'Estate Service' };
const mpCategory = (professionId) => MP_CATEGORY[String(professionId)] || MP_DEFAULT;
const companyImage = require('../services/marketplace/companyImage');

// Canonical Advantage.Bid directory profile URL for a listing (keeps visitors in-ecosystem —
// the "View Details" action). Built from the authoritative synced `filename` slug; returns null
// for legacy records without one so the card can render a disabled/fallback state.
const MP_DIRECTORY_ORIGIN = 'https://www.advantage.bid';
function mpProfileUrl(path) {
  const p = (path || '').trim().replace(/^\/+/, '');       // slugs are stored without a leading slash
  if (!p || /[<>"'\\\s]/.test(p) || /^https?:/i.test(p)) return null; // reject malformed/absolute values
  return MP_DIRECTORY_ORIGIN + '/' + p.split('/').map(encodeURIComponent).join('/');
}

// Strip HTML/entities and collapse whitespace into a plain card blurb.
function mpBlurb(html, max = 260) {
  if (!html) return null;
  const s = String(html).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

router.get('/marketplace', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT o.id, o.name, o.city, o.state, o.lat, o.lng, o.website_url, o.description,
              o.bd_metadata->>'profession_id' AS profession_id,
              o.bd_metadata->>'bd_image_url'  AS bd_image_url,
              o.bd_metadata->>'bd_image_type' AS bd_image_type,
              o.bd_metadata->>'bd_profile_path' AS bd_profile_path,
              (o.linked_seller_profile_id IS NOT NULL) AS linked,
              -- Only APPROVED, seller-owned imagery is surfaced. BD / unclaimed-org logos stay
              -- withheld by policy (never selected here). sp.logo_url is the linked seller's own
              -- logo; the LATERAL pulls the cover of that seller's soonest-closing syndicated auction.
              sp.logo_url AS seller_logo_url,
              lac.cover_image_url AS linked_auction_cover_url,
              (o.linked_seller_profile_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM auctions a
                  WHERE a.seller_id = o.linked_seller_profile_id
                    AND a.state IN ('published','active') AND a.is_archived IS NOT TRUE
                    AND a.marketplace_status = 'syndicated')) AS has_auctions
         FROM organizations o
         LEFT JOIN seller_profiles sp ON sp.id = o.linked_seller_profile_id
         LEFT JOIN LATERAL (
             SELECT a.cover_image_url
               FROM auctions a
              WHERE a.seller_id = o.linked_seller_profile_id
                AND a.state IN ('published','active') AND a.is_archived IS NOT TRUE
                AND a.marketplace_status = 'syndicated'
                AND a.cover_image_url IS NOT NULL
              ORDER BY a.end_time ASC NULLS LAST
              LIMIT 1
         ) lac ON o.linked_seller_profile_id IS NOT NULL
        WHERE o.source = 'bd_import'
          AND o.lat IS NOT NULL AND o.lng IS NOT NULL
          AND o.name IS NOT NULL AND btrim(o.name) <> ''
          AND (o.bd_sync_status IS NULL OR o.bd_sync_status <> 'removed')  -- reconciled-away listings drop off
          AND lower(o.name) NOT LIKE 'sample %'
          AND lower(o.name) NOT LIKE 'test %'
          AND lower(o.name) NOT LIKE 'demo %'
        ORDER BY o.name ASC`
    );

    // Deterministic de-stacking: where several records share identical coordinates
    // (e.g. only city-level geocoding), fan them out on a small golden-angle spiral
    // (~14 m/step) so co-located pins stay individually discoverable without implying
    // a false exact address. Stable because the query is name-ordered.
    const seen = new Map();
    const partners = rows.map((r) => {
      const cat = mpCategory(r.profession_id);
      let lat = Number(r.lat), lng = Number(r.lng);
      const key = lat.toFixed(5) + ',' + lng.toFixed(5);
      const n = seen.get(key) || 0; seen.set(key, n + 1);
      if (n > 0) {
        const ang = n * 2.399963229; // golden angle (radians)
        lat += 0.00013 * n * Math.cos(ang);
        lng += 0.00013 * n * Math.sin(ang);
      }
      return {
        id:               r.id,
        name:             r.name,
        category:         cat.label,      // plural — legend/group label
        category_singular: cat.singular,  // singular — individual company card label
        category_key:     cat.key,
        city:             r.city || null,
        state:            r.state || null,
        lat, lng,
        website:          r.website_url || null,
        blurb:            mpBlurb(r.description),
        linked:           !!r.linked,
        // Approved card image: linked seller logo/cover → the company's own BD listing image
        // (logo / photo / default directory asset) → null (card draws a monogram).
        image:            companyImage.select(r),
        // Canonical Advantage.Bid listing page for the "View Details" primary action (in-ecosystem).
        profile_url:      mpProfileUrl(r.bd_profile_path),
        // Phase 2: whether this listing is linked to a seller with live auctions. The card
        // lazily fetches the auction list from /marketplace/:id/auctions only when true.
        has_auctions:     !!r.has_auctions,
      };
    });

    const counts = partners.reduce((m, p) => { m[p.category_key] = (m[p.category_key] || 0) + 1; return m; }, {});
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ success: true, data: partners, counts, total: partners.length });
  } catch (err) { next(err); }
});

// ── GET /api/public/marketplace/:orgId/auctions ───────────────────────────────
// Marketplace Phase 2: the linked seller's public auctions for a company card. Lazy —
// the map/legend never load this; the card fetches it only when opened. Returns the same
// public visibility gate as /api/public/auctions, split into current (active) + upcoming
// (published). Returns empty arrays gracefully when the company is unlinked or has none —
// keeping the marketplace layer fully independent of the auction layer.
router.get('/marketplace/:orgId/auctions', async (req, res, next) => {
  try {
    if (!validUuid(req.params.orgId)) return res.status(400).json({ success: false, message: 'Invalid company id' });
    const { rows } = await db.query(
      `SELECT a.id, a.title, a.state, a.start_time, a.end_time, a.cover_image_url, a.city, a.address_state,
              (SELECT COUNT(*)::int FROM lots l WHERE l.auction_id = a.id AND l.state <> 'withdrawn') AS lot_count
         FROM organizations o
         JOIN auctions a ON a.seller_id = o.linked_seller_profile_id
        WHERE o.id = $1
          AND o.source = 'bd_import'
          AND o.linked_seller_profile_id IS NOT NULL
          AND a.state IN ('published','active')
          AND a.is_archived IS NOT TRUE
          AND a.marketplace_status = 'syndicated'
        ORDER BY a.end_time ASC NULLS LAST
        LIMIT 50`, [req.params.orgId]);

    const shape = (a) => ({
      id: a.id, title: a.title, state: a.state,
      lots: a.lot_count || 0,
      start_time: a.start_time, end_time: a.end_time,
      cover_image_url: a.cover_image_url || null,
      href: '/auction-view.html?auctionId=' + encodeURIComponent(a.id),
    });
    // Current = closing sequence underway (active); Upcoming = published, not yet started.
    const current  = rows.filter((a) => a.state === 'active').map(shape);
    const upcoming  = rows.filter((a) => a.state === 'published').map(shape);
    res.set('Cache-Control', LIVE_CACHE);
    res.json({ success: true, current, upcoming, total: current.length + upcoming.length });
  } catch (err) { next(err); }
});

// ── GET /api/public/auctions ──────────────────────────────────────────────────
// Paginated, filterable auction discovery feed.
//
// Query params:
//   state          — published | active | closed   (default: published + active)
//   city           — partial match, case-insensitive
//   address_state  — exact match, e.g. "TX"
//   auction_type   — matches public_auction_type
//   shipping       — "true" to require shipping_available = true
//   sort           — "ending_soon": restrict to end_time within 24h, order by end_time ASC
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
      where.push(`a.state IN ('published', 'active') AND a.is_archived IS NOT TRUE`);
    }
    where.push(`a.is_archived IS NOT TRUE`); // #22: archived auctions never appear publicly
    where.push(`a.marketplace_status = 'syndicated'`); // Phase 2: admin-hidden/removed auctions never appear on the marketplace

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
      where.push(`(a.title ILIKE $${ki} OR a.subtitle ILIKE $${ki} OR a.description ILIKE $${ki} OR a.city ILIKE $${ki} OR sp.display_name ILIKE $${ki})`);
    }

    const sortEndingSoon = q.sort === 'ending_soon';
    if (sortEndingSoon) {
      where.push(`a.end_time > NOW()`);
      where.push(`a.end_time <= NOW() + INTERVAL '24 hours'`);
    }

    const limit  = Math.min(Math.max(parseInt(q.limit,  10) || 20, 1), 100);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    params.push(limit);
    const li = params.length;
    params.push(offset);
    const oi = params.length;

    const orderByClause = sortEndingSoon
      ? 'a.end_time ASC'
      : `${auctionScoreSQL('a')} DESC, a.id ASC`;

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
             a.lat,
             a.lng,
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
             COUNT(l.id) FILTER (WHERE l.winning_amount_cents IS NOT NULL)::int AS sold_lot_count,
             COALESCE(SUM(l.bid_count), 0)::int AS total_bids,
             sp.display_name    AS seller_display_name,
             sp.location_label  AS seller_location_label,
             sp.logo_url        AS seller_logo_url,
             COUNT(*) OVER()    AS total_count
        FROM auctions a
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
        LEFT JOIN lots l ON l.auction_id = a.id AND l.state != 'withdrawn'
       WHERE ${where.join(' AND ')}
       GROUP BY a.id, sp.id
       ORDER BY ${orderByClause}
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
             AND a.state IN ('published', 'active') AND a.is_archived IS NOT TRUE
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
             a.lat,
             a.lng,
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
         AND a.state IN ('published', 'active', 'closed') AND a.is_archived IS NOT TRUE
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
      `SELECT id FROM auctions WHERE id = $1 AND state IN ('published', 'active', 'closed') AND is_archived IS NOT TRUE AND marketplace_status <> 'removed'`,
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
    let stateClause = `a.state IN ('published', 'active') AND a.is_archived IS NOT TRUE`;
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
             WHERE a.state IN ('published', 'active') AND a.is_archived IS NOT TRUE
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
         WHERE a.state IN ('published', 'active') AND a.is_archived IS NOT TRUE
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
               WHERE a.state IN ('published', 'active') AND a.is_archived IS NOT TRUE
             )::int AS active_count
        FROM auctions a
       WHERE a.city IS NOT NULL
         AND a.address_state IS NOT NULL
         AND a.state IN ('published', 'active', 'closed') AND a.is_archived IS NOT TRUE
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
               WHERE a.state IN ('published', 'active', 'closed') AND a.is_archived IS NOT TRUE
             )::int AS auction_count,
             COUNT(DISTINCT a.id) FILTER (
               WHERE a.state IN ('published', 'active') AND a.is_archived IS NOT TRUE
             )::int AS active_auction_count
        FROM seller_profiles sp
        LEFT JOIN auctions a ON a.seller_id = sp.id
       WHERE sp.id = $1
         AND EXISTS (
               SELECT 1 FROM auctions ea
                WHERE ea.seller_id = sp.id
                  AND ea.state IN ('published', 'active', 'closed') AND ea.is_archived IS NOT TRUE
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

// ── GET /api/public/lots/search — buyer lot-level search (Phase 2) ────────────
// Params: q (text: title/description/category/maker), category (exact),
//   address_state, city, shippable, status (active|upcoming|closed),
//   ending_soon, sort (ending_soon|newest|most_bids), limit (1–50), offset.
// Realized prices are withheld for closed lots (anonymous endpoint, #20.1).
router.get('/lots/search', async (req, res, next) => {
  try {
    const { where, params, orderBy } = buildLotSearch(req.query);
    const limit  = clampInt(req.query.limit, 24, 1, 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit);  const li = params.length;
    params.push(offset); const oi = params.length;
    const { rows } = await db.query(`
      SELECT l.id, l.auction_id, l.lot_number, l.title, l.category,
             l.thumbnail_url, l.images_count, l.state AS lot_state,
             l.starting_bid_cents,
             CASE WHEN l.state = 'open' THEN l.current_bid_cents ELSE NULL END AS current_bid_cents,
             l.bid_count, l.closes_at, l.shippable,
             a.title AS auction_title, a.state AS auction_state,
             a.city AS auction_city, a.address_state AS auction_address_state,
             a.end_time AS auction_end_time, a.public_auction_type AS auction_public_type,
             sp.display_name AS seller_display_name,
             COUNT(*) OVER() AS total_count
        FROM lots l
        JOIN auctions a ON a.id = l.auction_id
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${li} OFFSET $${oi}
    `, params);
    const total_count = rows.length ? parseInt(rows[0].total_count, 10) : 0;
    const data = rows.map(({ total_count: _tc, ...rest }) => rest);
    res.set('Cache-Control', LIVE_CACHE);
    return res.json({ success: true, data, total_count, has_more: offset + data.length < total_count, offset, limit });
  } catch (err) { next(err); }
});

// ── GET /api/public/categories — real lot categories with counts (browse) ─────
router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT l.category, COUNT(*)::int AS lot_count
        FROM lots l
        JOIN auctions a ON a.id = l.auction_id
       WHERE l.category IS NOT NULL AND l.category <> ''
         AND l.state <> 'withdrawn'
         AND a.is_archived IS NOT TRUE
         AND a.state IN ('published','active')
       GROUP BY l.category
       ORDER BY lot_count DESC, l.category ASC
       LIMIT 100
    `);
    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/lots/ending-soon ─────────────────────────────────────────
// Individual lots closing within 48 hours, sorted most-urgent first.
//
// Query params:
//   limit         — 1–50, default 20
//   shippable     — "true" to restrict to shippable lots
//   address_state — exact state abbreviation, e.g. "TX"
router.get('/lots/ending-soon', async (req, res, next) => {
  try {
    const limit      = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const params     = [];
    const extraWhere = [];

    if (req.query.shippable === 'true') {
      extraWhere.push('l.shippable = true');
    }
    if (req.query.address_state) {
      params.push(req.query.address_state.trim().toUpperCase());
      extraWhere.push(`a.address_state = $${params.length}`);
    }
    params.push(limit);
    const limitIdx     = params.length;
    const extraWhereSQL = extraWhere.length ? 'AND ' + extraWhere.join(' AND ') : '';

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
         AND a.state = 'active' AND a.is_archived IS NOT TRUE
         ${extraWhereSQL}
       ORDER BY l.closes_at ASC
       LIMIT $${limitIdx}
    `, params);

    res.set('Cache-Control', LIVE_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/lots/recently-added ──────────────────────────────────────
// Lots added in the last 21 days, newest first.
//
// Query params:
//   limit         — 1–50, default 20
//   shippable     — "true" to restrict to shippable lots
//   address_state — exact state abbreviation, e.g. "TX"
router.get('/lots/recently-added', async (req, res, next) => {
  try {
    const limit      = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const params     = [];
    const extraWhere = [];

    if (req.query.shippable === 'true') {
      extraWhere.push('l.shippable = true');
    }
    if (req.query.address_state) {
      params.push(req.query.address_state.trim().toUpperCase());
      extraWhere.push(`a.address_state = $${params.length}`);
    }
    params.push(limit);
    const limitIdx      = params.length;
    const extraWhereSQL = extraWhere.length ? 'AND ' + extraWhere.join(' AND ') : '';

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
         AND a.state = 'active' AND a.is_archived IS NOT TRUE
         ${extraWhereSQL}
       ORDER BY l.created_at DESC
       LIMIT $${limitIdx}
    `, params);

    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/lots/trending ─────────────────────────────────────────────
// Most-bid lots in active auctions, sorted by bid activity descending.
//
// Query params:
//   limit         — 1–50, default 20
//   shippable     — "true" to restrict to shippable lots
//   address_state — exact state abbreviation, e.g. "TX"
router.get('/lots/trending', async (req, res, next) => {
  try {
    const limit      = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const params     = [];
    const extraWhere = [];

    if (req.query.shippable === 'true') {
      extraWhere.push('l.shippable = true');
    }
    if (req.query.address_state) {
      params.push(req.query.address_state.trim().toUpperCase());
      extraWhere.push(`a.address_state = $${params.length}`);
    }
    params.push(limit);
    const limitIdx      = params.length;
    const extraWhereSQL = extraWhere.length ? 'AND ' + extraWhere.join(' AND ') : '';

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
         AND a.state = 'active' AND a.is_archived IS NOT TRUE
         ${extraWhereSQL}
       ORDER BY l.bid_count DESC, l.closes_at ASC
       LIMIT $${limitIdx}
    `, params);

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
