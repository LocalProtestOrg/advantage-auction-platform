'use strict';

/**
 * /api/public/events (+ /events/:slug, /event-markets, /event-categories) — the public,
 * read-only event feed consumed by the BD widget/embed. No auth. Only PUBLISHED,
 * not-yet-ended events. Responses are strictly allowlisted (no moderation fields, user
 * ids, or plan internals). Mounted at /api/public AFTER public.js (falls through for
 * these paths); the global CORS sets '*' for /api/public/* — this router OVERRIDES that
 * with a restricted, BD-origin allow-list for events specifically.
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const eventsService = require('../services/eventsService');
const { asyncRoute, svcErr } = require('../utils/apiError');

const PUBLIC_CACHE = 's-maxage=60, stale-while-revalidate=30';

// Restricted CORS allow-list for the event endpoints (overridable via env).
const EVENT_ORIGINS = (process.env.EVENTS_ALLOWED_ORIGINS
  || 'https://advantage.bid,https://www.advantage.bid,http://localhost:3000,http://localhost:3001')
  .split(',').map((s) => s.trim()).filter(Boolean);

router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && EVENT_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  } else {
    res.header('Access-Control-Allow-Origin', EVENT_ORIGINS[0] || 'https://advantage.bid');
  }
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function serialize(r, images) {
  return {
    id: r.id, slug: r.slug, title: r.title, description: r.description,
    category: r.category_slug, market: r.market_slug,
    venue_name: r.venue_name, city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng,
    start_at: r.start_at, end_at: r.end_at, timezone: r.timezone, external_url: r.external_url,
    // Outbound targets for imported events (present only after migration 100; undefined→omitted otherwise).
    registration_url: r.registration_url || undefined, bidding_url: r.bidding_url || undefined,
    organizer_name: r.organizer_name || undefined,
    is_imported: r.source === 'imported' || undefined,
    is_featured: r.is_featured,
    organizer_badge: eventsService.deriveOrganizerBadge({ source: r.source }, { verification_status: r.org_verif }),
    cover_image_url: r.cover_url || null,
    images: images ? images.map((i) => ({ url: i.url, position: i.position, is_cover: i.is_cover })) : undefined,
    organization: r.org_slug
      ? { name: r.org_name, slug: r.org_slug, logo_url: r.org_logo, website_url: r.org_website, verification_status: r.org_verif }
      : null,
    attribution_source: r.attribution_source || undefined,
    attribution_url: r.attribution_url || undefined,
  };
}

// GET /api/public/events?market=&category=&limit=&offset=
router.get('/events', asyncRoute(async (req, res) => {
  const { market, category } = req.query;
  const params = []; const where = ["e.status = 'published'", '(e.end_at IS NULL OR e.end_at >= now())'];
  if (market) {
    const m = await db.query('SELECT 1 FROM event_markets WHERE slug = $1 AND is_active = true', [market]);
    if (!m.rows.length) throw svcErr(400, 'UNKNOWN_MARKET', 'Unknown market.');
    params.push(market); where.push(`e.market_slug = $${params.length}`);
  }
  if (category) { params.push(category); where.push(`e.category_slug = $${params.length}`); }
  const limit = clampInt(req.query.limit, 12, 1, 50);
  const offset = clampInt(req.query.offset, 0, 0, 10000);
  params.push(limit); const li = params.length;
  params.push(offset); const oi = params.length;
  const { rows } = await db.query(
    `SELECT e.id, e.slug, e.title, e.description, e.category_slug, e.market_slug, e.venue_name, e.city, e.state, e.zip,
            e.lat, e.lng, e.start_at, e.end_at, e.timezone, e.external_url, e.is_featured, e.source,
            e.attribution_source, e.attribution_url,
            o.name AS org_name, o.slug AS org_slug, o.logo_url AS org_logo, o.website_url AS org_website,
            o.verification_status AS org_verif,
            (SELECT url FROM event_images ei WHERE ei.event_id = e.id ORDER BY is_cover DESC, position ASC LIMIT 1) AS cover_url
       FROM events e LEFT JOIN organizations o ON o.id = e.organization_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.is_featured DESC, e.start_at ASC
      LIMIT $${li} OFFSET $${oi}`, params);
  res.set('Cache-Control', PUBLIC_CACHE);
  res.json({ success: true, data: rows.map((r) => serialize(r)) });
}));

// GET /api/public/events/:slug — single published event + all images
router.get('/events/:slug', asyncRoute(async (req, res) => {
  const { rows } = await db.query(
    `SELECT e.*, o.name AS org_name, o.slug AS org_slug, o.logo_url AS org_logo, o.website_url AS org_website,
            o.verification_status AS org_verif
       FROM events e LEFT JOIN organizations o ON o.id = e.organization_id
      WHERE e.slug = $1 AND e.status = 'published' LIMIT 1`, [req.params.slug]);
  if (!rows.length) throw svcErr(404, 'EVENT_NOT_FOUND', 'Event not found.');
  const r = rows[0];
  const images = (await db.query(
    'SELECT url, position, is_cover FROM event_images WHERE event_id = $1 ORDER BY position ASC', [r.id])).rows;
  const cover = (images.find((i) => i.is_cover) || images[0] || {}).url;
  res.set('Cache-Control', PUBLIC_CACHE);
  res.json({ success: true, data: serialize({ ...r, cover_url: cover }, images) });
}));

// GET /api/public/events/:slug/related — keep visitors ON Advantage.Bid. Returns related local events
// (same market), nearby events (great-circle), and companies with public profiles running events here.
// Published + not-ended only; every event carries an INTERNAL /event.html?slug= url (never external).
router.get('/events/:slug/related', asyncRoute(async (req, res) => {
  const ev = (await db.query(
    "SELECT id, market_slug, lat, lng, organization_id FROM events WHERE slug = $1 AND status = 'published' LIMIT 1",
    [req.params.slug])).rows[0];
  if (!ev) throw svcErr(404, 'EVENT_NOT_FOUND', 'Event not found.');

  const CARD_COLS = `e.slug, e.title, e.city, e.state, e.start_at, e.end_at, e.market_slug, e.source,
    (SELECT url FROM event_images ei WHERE ei.event_id = e.id ORDER BY is_cover DESC, position ASC LIMIT 1) AS cover_url,
    o.verification_status AS org_verif`;
  const cardOf = (r) => ({
    slug: r.slug, title: r.title, city: r.city, state: r.state, start_at: r.start_at, end_at: r.end_at,
    market: r.market_slug, cover_image_url: r.cover_url || null,
    organizer_badge: eventsService.deriveOrganizerBadge({ source: r.source }, { verification_status: r.org_verif }),
    url: '/event.html?slug=' + encodeURIComponent(r.slug || ''),
  });

  const related = ev.market_slug ? (await db.query(
    `SELECT ${CARD_COLS} FROM events e LEFT JOIN organizations o ON o.id = e.organization_id
      WHERE e.status = 'published' AND e.market_slug = $1 AND e.id <> $2 AND (e.end_at IS NULL OR e.end_at >= now())
      ORDER BY e.start_at ASC NULLS LAST LIMIT 6`, [ev.market_slug, ev.id])).rows.map(cardOf) : [];

  let nearby = [];
  if (ev.lat != null && ev.lng != null) {
    nearby = (await db.query(
      `SELECT ${CARD_COLS},
              3959.0 * acos(LEAST(1, GREATEST(-1,
                sin(radians($1)) * sin(radians(e.lat)) + cos(radians($1)) * cos(radians(e.lat)) * cos(radians(e.lng) - radians($2))))) AS dist
         FROM events e LEFT JOIN organizations o ON o.id = e.organization_id
        WHERE e.status = 'published' AND e.id <> $3 AND (e.end_at IS NULL OR e.end_at >= now())
          AND e.lat IS NOT NULL AND e.lng IS NOT NULL
        ORDER BY dist ASC LIMIT 12`, [ev.lat, ev.lng, ev.id])).rows
      .filter((r) => r.dist <= 100).slice(0, 6).map(cardOf);
  }

  const companies = ev.market_slug ? (await db.query(
    `SELECT DISTINCT o.name, o.slug, o.logo_url
       FROM events e JOIN organizations o ON o.id = e.organization_id
      WHERE e.status = 'published' AND e.market_slug = $1 AND o.slug IS NOT NULL
        AND ($2::uuid IS NULL OR o.id <> $2)
      LIMIT 4`, [ev.market_slug, ev.organization_id || null])).rows
    .map((o) => ({ name: o.name, slug: o.slug, logo_url: o.logo_url || null })) : [];

  res.set('Cache-Control', PUBLIC_CACHE);
  res.json({ success: true, data: { related, nearby, companies } });
}));

// GET /api/public/event-markets
router.get('/event-markets', asyncRoute(async (req, res) => {
  const { rows } = await db.query('SELECT slug, name FROM event_markets WHERE is_active = true ORDER BY sort_order ASC');
  res.set('Cache-Control', PUBLIC_CACHE);
  res.json({ success: true, data: rows });
}));

// GET /api/public/event-categories
router.get('/event-categories', asyncRoute(async (req, res) => {
  const { rows } = await db.query('SELECT slug, name FROM event_categories WHERE is_active = true ORDER BY sort_order ASC');
  res.set('Cache-Control', PUBLIC_CACHE);
  res.json({ success: true, data: rows });
}));

module.exports = router;
