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
const discoveryService = require('../services/discoveryService');
const { coverImageSql } = require('../lib/govSurplusPlaceholder');
const { buildLotSearch, clampInt } = require('../services/searchService');
const { brandedColSql, brandingVisibleSql } = require('../lib/sellerBranding');
const { organizerColSql } = require('../lib/organizerPrivacy');
const { labelForFamily } = require('../lib/marketplaceVocabulary');
const { canonicalCounts } = require('../lib/marketplaceVisibility');
// Buyer-facing seller-identity columns: NULL unless the seller is a professional type WITH branding
// enabled. Private/other/unknown are always anonymous. Applied at the query so buyer feeds never even
// select hidden identity. (The public company DIRECTORY on advantage.bid is separate and NOT scrubbed.)
const B_NAME = brandedColSql('sp.display_name');
const B_LOGO = brandedColSql('sp.logo_url');
const B_LOC  = brandedColSql('sp.location_label');
const B_BIO  = brandedColSql('sp.bio');
const B_PROFILE_ID = brandedColSql('sp.id');

const LIVE_CACHE   = 's-maxage=30, stale-while-revalidate=10';
const PUBLIC_CACHE = 's-maxage=60, stale-while-revalidate=30';

// Default number of event cards per page in the unified marketplace feed. Centralized so the
// page size for all three widget presets (all-events / auctions / estate-sales) changes in one place.
const FEED_PAGE_SIZE = 12;
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

// ── GET /api/public/professionals/:slug ───────────────────────────────────────
// Public professional profile view (Phase 3). Served ONLY when the owner has explicitly
// published (profile_data->>'published' = 'true') — incomplete/native professional orgs are never
// auto-exposed. Reuses the shared profile view builder so it matches the owner preview exactly.
// Never returns internal/admin columns; contact fields are the business details the professional
// chose to publish.
const profileSchemaPub = require('../lib/professionalProfileSchema');
const capabilityServicePub = require('../services/capabilityService');
router.get('/professionals/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    const { rows } = await db.query(
      `SELECT id, slug, name, type, city, state, description, logo_url, cover_image_url,
              contact_email, contact_phone, website_url, verification_status, profile_data
         FROM organizations
        WHERE lower(slug) = $1 AND (profile_data->>'published') = 'true'
        LIMIT 1`, [slug]);
    const org = rows[0];
    if (!org) return res.status(404).json({ success: false, message: 'Profile not found' });
    // Type gate (fail closed): a public professional profile is served ONLY when the org holds an
    // APPROVED professional type (appraiser / auction_house / estate_sale_company / professional_liquidator /
    // consignment_company / moving_company / cleanout_company — professionalProfileSchema.PROFESSIONAL_TYPES,
    // derived from the org's capabilities). Individual/homeowner/private/importer/system orgs and any org
    // without an approved professional type → 404. Never invents a type.
    let types = [];
    try { types = profileSchemaPub.professionalTypesFrom(Array.from(await capabilityServicePub.getEffectiveCapabilities(org.id))); } catch (e) { types = []; }
    if (!types.length) return res.status(404).json({ success: false, message: 'Profile not found' });
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ success: true, profile: profileSchemaPub.buildProfileView(org, types) });
  } catch (err) { next(err); }
});

// ── POST /api/public/feedback ─────────────────────────────────────────────────
// Marketplace feedback → emailed to info@advantage.bid (existing SES infra) + recorded in
// audit_log for future triage. Public + unauthenticated, so: per-IP rate limit, honeypot,
// strict validation, header-injection-safe subject/reply-to, and HTML-escaped bodies. No
// mail credentials ever touch the client. Errors never leak internals.
const { feedbackLimiter, normalLimiter } = require('../middleware/rateLimit');
const geocodeProvider = require('../services/geocoding/mapboxProvider');
const { sendEmail } = require('../services/emailService');
const { writeAuditLog } = require('../lib/auditLog');

const FEEDBACK_TYPES = {
  problem:    'Report a Problem',
  incorrect:  'Incorrect Listing',
  suggestion: 'Suggestion',
  other:      'Other',
};
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A header-safe single-line value: no CR/LF/control chars (blocks email-header injection).
const oneLine = (v, max = 200) => String(v == null ? '' : v).replace(/[\r\n\t\x00-\x1F\x7F]+/g, ' ').trim().slice(0, max);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clampStr = (v, max) => (v == null ? '' : String(v)).slice(0, max);

router.post('/feedback', feedbackLimiter, express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const b = req.body || {};

    // Honeypot: real users never fill this hidden field. Bots do → accept silently, drop.
    if (oneLine(b.company_url, 100)) return res.json({ success: true });

    const typeKey = String(b.type || '').toLowerCase();
    if (!FEEDBACK_TYPES[typeKey]) return res.status(400).json({ success: false, message: 'Please choose a feedback type.' });

    const message = clampStr(b.message, 5000).trim();
    if (message.length < 2) return res.status(400).json({ success: false, message: 'Please enter your feedback.' });

    const name  = oneLine(b.name, 120);
    const email = oneLine(b.email, 200);
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: 'Please enter a valid email, or leave it blank.' });

    // Auto-captured context (client-supplied → treated as untrusted; escaped + size-capped).
    const ctx = (b.context && typeof b.context === 'object') ? b.context : {};
    const context = {
      page_url:     oneLine(ctx.page_url, 500),
      filters:      oneLine(ctx.filters, 300),
      company_id:   oneLine(ctx.company_id, 60),
      company_name: oneLine(ctx.company_name, 200),
      auction_id:   oneLine(ctx.auction_id, 60),
      auction_name: oneLine(ctx.auction_name, 200),
      map:          oneLine(ctx.map, 120),
      user_agent:   oneLine(req.get('user-agent'), 400),
      submitted_at: new Date().toISOString(),
      environment:  process.env.NODE_ENV || 'unknown',
    };

    const typeLabel = FEEDBACK_TYPES[typeKey];
    const subject = oneLine(`[Marketplace Feedback] ${typeLabel} — ${message.slice(0, 60)}`, 180);

    const rowsHtml = [
      ['Type', typeLabel], ['From', name || '(anonymous)'], ['Email', email || '(not provided)'],
      ['Company', context.company_name ? `${context.company_name} (${context.company_id})` : '—'],
      ['Auction', context.auction_name ? `${context.auction_name} (${context.auction_id})` : '—'],
      ['Filters', context.filters || '—'], ['Map', context.map || '—'],
      ['Page', context.page_url || '—'], ['Environment', context.environment],
      ['Submitted', context.submitted_at], ['User agent', context.user_agent || '—'],
    ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#5b6b7e;vertical-align:top;white-space:nowrap">${escHtml(k)}</td><td style="padding:4px 0;color:#0B1B2B">${escHtml(v)}</td></tr>`).join('');
    const html =
      `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:640px">` +
      `<h2 style="margin:0 0 4px;font-size:17px;color:#0B1B2B">Marketplace Feedback — ${escHtml(typeLabel)}</h2>` +
      `<p style="margin:12px 0;white-space:pre-wrap;line-height:1.5;color:#1f2a37">${escHtml(message)}</p>` +
      `<table style="border-collapse:collapse;font-size:13px;margin-top:8px">${rowsHtml}</table></div>`;
    const text = `Marketplace Feedback — ${typeLabel}\n\n${message}\n\n` +
      `From: ${name || '(anonymous)'} <${email || 'n/a'}>\nCompany: ${context.company_name || '—'} ${context.company_id || ''}\n` +
      `Auction: ${context.auction_name || '—'} ${context.auction_id || ''}\nFilters: ${context.filters || '—'}\nMap: ${context.map || '—'}\n` +
      `Page: ${context.page_url || '—'}\nEnv: ${context.environment}\nSubmitted: ${context.submitted_at}\nUA: ${context.user_agent || '—'}`;

    await sendEmail({
      to: 'info@advantage.bid', subject, html, text,
      replyTo: email && EMAIL_RE.test(email) ? email : undefined,   // reply-to only for a valid supplied address
    });

    // Best-effort persistence so a future triage system can review submissions (no new table).
    try {
      await writeAuditLog({ event_type: 'marketplace_feedback_submitted', entity_type: 'feedback',
        entity_id: '00000000-0000-4000-8000-000000000f00', actor_id: null,
        metadata: { type: typeKey, has_email: !!email, message_len: message.length, context } });
    } catch (_) { /* audit is best-effort */ }

    return res.json({ success: true, message: 'Thank you — your feedback was sent.' });
  } catch (err) {
    // Never leak internals; the client keeps the user's text and can retry.
    return res.status(502).json({ success: false, message: 'We could not send your feedback right now. Please try again.' });
  }
});

// ── GET /api/public/auctions ──────────────────────────────────────────────────
// Paginated, filterable auction discovery feed.
//
// ── GET /api/public/geocode ─────────────────────────────────────────────────────
// Resolve a free-text location ("Adrian, MI" · "49221" · "417 Seminole Dr, Tecumseh, MI" ·
// "Lenawee County" · "Downtown Houston") to a lat/lng search point for the Marketplace Feed's radius
// search. Server-side proxy to the platform's approved geocoding provider — the provider token stays
// on the server and is NEVER exposed to the browser/BD. Rate-limited. Returns a neutral shape; never a
// provider/vendor name or internal error. Degrades to {ok:false, reason:'unavailable'} if geocoding is
// not configured, so the widget can fall back to nationwide/text search.
router.get('/geocode', normalLimiter, async (req, res) => {
  try {
    const query = String(req.query.q || '').trim().slice(0, 160);
    if (!query) return res.status(400).json({ ok: false, reason: 'empty' });
    const r = await geocodeProvider.geocode(query);
    if (r && r.ok) {
      res.set('Cache-Control', 'public, max-age=86400'); // resolved coordinates are stable
      return res.json({ ok: true, lat: r.lat, lng: r.lng, label: r.normalized || query });
    }
    if (r && r.status === 'unconfigured') return res.json({ ok: false, reason: 'unavailable' });
    if (r && (r.status === 'failed' || r.status === 'insufficient_location')) return res.json({ ok: false, reason: 'no_match' });
    return res.json({ ok: false, reason: 'no_match' });
  } catch (e) {
    return res.json({ ok: false, reason: 'unavailable' });
  }
});

// ── GET /api/public/marketplace/feed ────────────────────────────────────────────
// THE unified public Marketplace Feed — one source of truth, one search implementation. Returns
// auctions AND estate-sale events normalized into a single event-card shape, so BD's /all-events page
// (and the Railway marketplace) render the SAME cards from the SAME API. Server-side search + pagination
// for scalability; the UNION projection is extensible to more event types and radius later.
//
// Query params (all optional): q (title/city/company keyword) · city (partial) · state (exact, 2-letter)
//   · zip (prefix) · type (auction | estate_sale | all, default all) · sort (soonest|newest, default
//   soonest) · limit (1–48, default 24) · offset. Seller identity honors the buyer-privacy policy
//   (private sellers anonymous via the branded company expression).
// Resolve the effective event type from the feed query. SERVER-ENFORCED preset locks the type for the
// type-specific presets (auctions / estate-sales) so a tampered request can never widen them. The
// all-events preset is NOT locked: it honors the widget's All/Auctions/Estate-Sales chip (?type=),
// which the combined widget sends alongside preset=all-events. Pure + exported for tests.
const FEED_PRESET_TYPE = { 'all-events': 'all', auctions: 'auction', 'estate-sales': 'estate_sale' };
function resolveFeedType(q) {
  q = q || {};
  if (q.preset && Object.prototype.hasOwnProperty.call(FEED_PRESET_TYPE, String(q.preset))) {
    const t = FEED_PRESET_TYPE[String(q.preset)];
    if (t === 'all' && ['auction', 'estate_sale'].includes(String(q.type))) return String(q.type);
    return t;
  }
  return ['auction', 'estate_sale'].includes(String(q.type)) ? String(q.type) : 'all';
}
// Resolve the search point + radius. radiusMi is null (no distance filter) when there is no valid geo
// point or radius is 'nationwide'/absent — so nationwide is never confused with a finite radius. Pure.
function resolveFeedGeo(q) {
  q = q || {};
  const lat = parseFloat(q.lat), lng = parseFloat(q.lng);
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  let radiusMi = null;
  if (hasGeo && q.radius != null && String(q.radius).toLowerCase() !== 'nationwide') {
    const r = parseFloat(q.radius); if (Number.isFinite(r) && r > 0) radiusMi = Math.min(r, 3000);
  }
  return { lat, lng, hasGeo, radiusMi };
}

// GET /api/public/marketplace/counts — the CANONICAL family + professionals counts for the map key and
// any surface that needs headline totals. Sourced from marketplaceVisibility.canonicalCounts (the single
// source of truth) so the browser never computes independent totals. Counts are INVENTORY totals, not
// map-pin/viewport counts: Auction Partner Events includes coordinate-less online auctions.
router.get('/marketplace/counts', async (req, res, next) => {
  try {
    const c = await canonicalCounts(db);
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({
      success: true,
      families: c.families,          // advantage_auction | partner_event | estate_sale | marketplace (fixed-price)
      professionals: c.professionals, // estate_sale_companies | auction_houses | appraisers | total (directory — NOT a family)
      statuses: c.statuses,          // upcoming (cross-family) | native_upcoming | event_upcoming — WHEN, not WHAT
    });
  } catch (err) { next(err); }
});

router.get('/marketplace/feed', async (req, res, next) => {
  try {
    const q = req.query;
    const type = resolveFeedType(q);

    // Pagination — page-based (page + pageSize) is the primary contract; legacy offset/limit is still
    // honored for any older caller. Page size is centralized in FEED_PAGE_SIZE (see top of file).
    const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || parseInt(q.limit, 10) || FEED_PAGE_SIZE, 1), 48);
    let page, limit, offset;
    if (q.page != null) {
      page   = Math.max(parseInt(q.page, 10) || 1, 1);
      limit  = pageSize;
      offset = (page - 1) * pageSize;
    } else {
      limit  = Math.min(Math.max(parseInt(q.limit, 10) || 24, 1), 48);
      offset = Math.max(parseInt(q.offset, 10) || 0, 0);
      page   = Math.floor(offset / limit) + 1;
    }

    // Location search point + radius (miles). 'nationwide'/absent radius = no distance filter.
    const { lat, lng, hasGeo, radiusMi } = resolveFeedGeo(q);

    const params = [];
    const outer = [];
    if (type !== 'all') { params.push(type); outer.push(`feed.kind = $${params.length}`); }
    if (q.q && String(q.q).trim()) {
      params.push('%' + String(q.q).trim().slice(0, 100) + '%');
      const i = params.length;
      outer.push(`(feed.title ILIKE $${i} OR feed.city ILIKE $${i} OR feed.company ILIKE $${i})`);
    }
    if (q.city && String(q.city).trim()) { params.push('%' + String(q.city).trim() + '%'); outer.push(`feed.city ILIKE $${params.length}`); }
    if (q.state && String(q.state).trim()) { params.push(String(q.state).trim().toUpperCase()); outer.push(`upper(feed.state) = $${params.length}`); }
    if (q.zip && String(q.zip).trim()) { params.push(String(q.zip).trim().replace(/[^0-9]/g, '').slice(0, 5) + '%'); outer.push(`feed.zip LIKE $${params.length}`); }
    const outerWhere = outer.length ? ('WHERE ' + outer.join(' AND ')) : '';

    // Distance (miles) via Haversine when a search point is supplied; NULL when the row has no coords.
    let distExpr = 'NULL::float';
    if (hasGeo) {
      params.push(lat); const la = params.length; params.push(lng); const lo = params.length;
      distExpr = `CASE WHEN feed.lat IS NOT NULL AND feed.lng IS NOT NULL THEN 3959.0 * acos(LEAST(1, GREATEST(-1, `
        + `sin(radians($${la})) * sin(radians(feed.lat)) + cos(radians($${la})) * cos(radians(feed.lat)) * cos(radians(feed.lng) - radians($${lo}))))) ELSE NULL END`;
    }
    // A finite radius keeps: PHYSICAL events within the radius, PLUS online/nationwide events (no coords →
    // distance NULL) which are available to a searcher anywhere. Excluding the coordless ones made a radius
    // search return near-empty results once online (e.g. GSA) auctions dominated inventory — this matches the
    // homepage map's approved behavior, which surfaces "Online auctions · nationwide" alongside local results.
    // The `nearest` sort (distance ASC NULLS LAST) still lists the closest physical events first, online after.
    const radiusClause = radiusMi != null ? (function () { params.push(radiusMi); return `WHERE x.distance_mi IS NULL OR x.distance_mi <= $${params.length}`; })() : '';

    // Sort: nearest only makes sense with a search point; else featured/soonest or newest.
    let orderBy;
    if (q.sort === 'nearest' && hasGeo) orderBy = 'x.distance_mi ASC NULLS LAST, x.sort_ts ASC NULLS LAST';
    else if (q.sort === 'newest') orderBy = 'x.created_ts DESC NULLS LAST';
    else orderBy = 'x.is_featured DESC, x.sort_ts ASC NULLS LAST';

    params.push(limit); const limIdx = params.length;
    params.push(offset); const offIdx = params.length;

    const sql = `
      WITH feed AS (
        SELECT 'auction'::text AS kind, 'advantage_auction'::text AS source_family, a.id::text AS ref_id, NULL::text AS slug,
               a.title, a.city, a.address_state AS state, a.zip, a.lat, a.lng,
               COALESCE(a.cover_image_url, a.banner_image_url) AS image_url,
               ${B_NAME} AS company, a.state AS lifecycle,
               a.start_time AS start_ts, a.end_time AS end_ts,
               COALESCE(a.end_time, a.start_time, a.created_at) AS sort_ts,
               a.created_at AS created_ts, a.is_featured
          FROM auctions a
          LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
         WHERE a.state IN ('published','active') AND a.is_archived IS NOT TRUE
           AND a.marketplace_status = 'syndicated'
        UNION ALL
        SELECT (CASE WHEN e.sale_type = 'auction' THEN 'auction' ELSE 'estate_sale' END)::text AS kind,
               (CASE WHEN e.sale_type = 'auction' THEN 'partner_event' ELSE 'estate_sale' END)::text AS source_family, e.id::text AS ref_id, e.slug,
               e.title, e.city, e.state, e.zip, e.lat, e.lng,
               ${coverImageSql('(SELECT url FROM event_images ei WHERE ei.event_id = e.id ORDER BY is_cover DESC, position ASC LIMIT 1)', 'e.external_url', 'e.sale_type')} AS image_url,
               ${organizerColSql('o.name')} AS company, e.status AS lifecycle, -- individual organizers stay anonymous
               e.start_at AS start_ts, e.end_at AS end_ts,
               COALESCE(e.start_at, e.created_at) AS sort_ts,
               e.created_at AS created_ts, e.is_featured
          FROM events e
          LEFT JOIN organizations o ON o.id = e.organization_id
         WHERE e.status = 'published' AND (e.end_at IS NULL OR e.end_at >= now())
      ),
      x AS (
        SELECT kind, source_family, ref_id, slug, title, city, state, zip, lat, lng, image_url, company,
               lifecycle, start_ts, end_ts, sort_ts, created_ts, is_featured, ${distExpr} AS distance_mi
          FROM feed
          ${outerWhere}
      )
      SELECT kind, source_family, ref_id, slug, title, city, state, zip, lat, lng, image_url, company,
             lifecycle, start_ts, end_ts, is_featured, distance_mi, COUNT(*) OVER() AS total_count
        FROM x
        ${radiusClause}
       ORDER BY ${orderBy}
       LIMIT $${limIdx} OFFSET $${offIdx}`;

    const { rows } = await db.query(sql, params);
    const total = rows.length ? parseInt(rows[0].total_count, 10) : 0;
    const items = rows.map((r) => ({
      type: r.kind,                                  // 'auction' | 'estate_sale' (unchanged; back-compat)
      family: r.source_family,                       // 'advantage_auction' | 'partner_event' | 'estate_sale'
      family_label: labelForFamily(r.source_family), // owner-locked display label (Phase 5F vocabulary)
      id: r.ref_id,
      title: r.title,
      city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng,
      image_url: r.image_url || null,
      company: r.company || null,                    // null = anonymous private seller (policy)
      status: r.lifecycle,
      starts_at: r.start_ts, ends_at: r.end_ts,
      is_featured: !!r.is_featured,
      distance_mi: (r.distance_mi != null ? Math.round(Number(r.distance_mi) * 10) / 10 : null),
      // Route by SOURCE, not kind: events (incl. sale_type='auction') carry a slug and open the event
      // page; native auctions (no slug) open the auction page. So an auction-EVENT is classified as an
      // auction yet still links to /event.html (its bidding/registration link lives on the event page).
      url: r.slug
        ? '/event.html?slug=' + encodeURIComponent(r.slug)
        : '/auction-view.html?auctionId=' + encodeURIComponent(r.ref_id),
    }));
    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({
      success: true,
      data: items,
      // Legacy fields (kept for backward compatibility).
      total, offset, limit, has_more: offset + items.length < total,
      // Primary numbered-pagination contract.
      pagination: {
        currentPage: page,
        pageSize: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    });
  } catch (err) { next(err); }
});

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
      // The seller NAME participates in search matching ONLY when the seller is publicly brandable
      // (professional type + branding on) — a private/individual/branding-off seller's name must not be
      // an enumeration vector. The auction stays fully searchable by its own public content (title,
      // subtitle, description, city) regardless of who the seller is.
      where.push(`(a.title ILIKE $${ki} OR a.subtitle ILIKE $${ki} OR a.description ILIKE $${ki} OR a.city ILIKE $${ki} `
        + `OR (${brandingVisibleSql('sp.seller_type', 'sp.show_branding_to_buyers')} AND sp.display_name ILIKE $${ki}))`);
    }

    // Tenant-scoped feeds for company-specific widgets. Filtering uses STABLE UUIDs (never a
    // company-name text match). `organization_id` resolves through the admin-confirmed marketplace
    // link (organizations.linked_seller_profile_id); an org with no linked seller matches nothing.
    // `seller_id` filters directly. Either way the feed can only ever return that one owner's
    // auctions, so a company widget can never expose another organization's auctions.
    if (q.organization_id && validUuid(q.organization_id)) {
      params.push(q.organization_id);
      where.push(`a.seller_id = (SELECT linked_seller_profile_id FROM organizations WHERE id = $${params.length})`);
    }
    if (q.seller_id && validUuid(q.seller_id)) {
      params.push(q.seller_id);
      where.push(`a.seller_id = $${params.length}`);
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
             ${B_NAME}    AS seller_display_name,
             ${B_LOC}  AS seller_location_label,
             ${B_LOGO}        AS seller_logo_url,
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
                 ${B_NAME}    AS seller_display_name,
                 ${B_LOC}  AS seller_location_label,
                 ${B_LOGO}        AS seller_logo_url,
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
             ${B_PROFILE_ID}              AS seller_profile_id,
             ${B_NAME}    AS seller_display_name,
             ${B_BIO}             AS seller_bio,
             ${B_LOC}  AS seller_location_label,
             ${B_LOGO}        AS seller_logo_url,
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
             l.lot_number_display,
             COUNT(*) OVER() AS total_count
        FROM lots l
       WHERE l.auction_id = $1
         AND l.state != 'withdrawn'
       ORDER BY l.lot_number ASC, l.lot_number_display ASC
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
             ${B_NAME}    AS seller_display_name,
             ${B_LOC}  AS seller_location_label,
             ${B_LOGO}        AS seller_logo_url
        FROM lots l
        JOIN auctions a ON a.id = l.auction_id
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
       WHERE l.is_featured = true
         AND l.state != 'withdrawn'
         AND ${stateClause}
       ORDER BY ${auctionScoreSQL('a')} DESC, l.lot_number ASC, l.lot_number_display ASC, l.id ASC
       LIMIT $1
    `, [limit]);

    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/public/featured-auctions ────────────────────────────────────────
// Featured auction feed for marketplace widgets. Native Advantage.Bid Auctions only (the `auctions`
// table) — never events (Auction Partner Events / GSA / Estate Sales) or fixed-price Marketplace items.
// Returns ELIGIBLE published/active, non-archived auctions ordered by ranking_score: featured auctions
// (marketplace_priority > 0) rank first via a featured_base boost, then the freshest — so a normally-
// published auction still appears (it is not gated on an explicit priority flag). Empty only when no
// eligible auction exists. An image is NOT required for eligibility.
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
                   ${B_NAME}    AS seller_display_name,
                   ${B_LOC}  AS seller_location_label,
                   ${B_LOGO}        AS seller_logo_url,
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
               -- Eligible published/active auctions. NOT gated on an explicit marketplace_priority, so a
               -- normally-published auction appears; featured (priority > 0) auctions still rank first via
               -- ranking_score (auctionScoreSQL gives them a featured_base boost).
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
               ${B_NAME}    AS seller_display_name,
               ${B_LOC}  AS seller_location_label,
               ${B_LOGO}        AS seller_logo_url
          FROM auctions a
          LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
          LEFT JOIN lots lo ON lo.auction_id = a.id AND lo.state != 'withdrawn'
         WHERE a.state IN ('published', 'active') AND a.is_archived IS NOT TRUE
           -- Eligible published/active auctions. NOT gated on an explicit marketplace_priority, so a
           -- normally-published auction appears; featured (priority > 0) auctions rank first via the score.
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
             ${B_NAME} AS seller_display_name
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
// Public PROFESSIONAL seller profile. Returns identity ONLY for a professional seller whose branding
// is buyer-visible (sellerBranding policy, enforced in the WHERE so hidden identity is never selected)
// AND who has ≥1 published/active/closed auction. Private/individual/branding-off/unknown sellers →
// 404 (fail closed): an anonymous "profile" has no customer value and must not imply a private seller
// has a public profile page.
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
         AND ${brandingVisibleSql('sp.seller_type', 'sp.show_branding_to_buyers')}
         AND EXISTS (
               SELECT 1 FROM auctions ea
                WHERE ea.seller_id = sp.id
                  AND ea.state IN ('published', 'active', 'closed') AND ea.is_archived IS NOT TRUE
             )
       GROUP BY sp.id
    `, [sellerId]);

    // No row → not a public professional seller → 404 (private/individual/branding-off/unknown all fail here).
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
// ── GET /api/public/discovery/items ──────────────────────────────────────────
// "Featured Items Available Now" — ranked + diversified eligible ACTIVE auction lots for
// visual discovery. Railway is the sole source of truth. Public, read-only, card-sized fields
// only (no bid history / full images / terms / private seller / reserve / location precision).
//
// Public params (V1 — validated + used; nothing else is honored):
//   page       1..6         (this placement is capped at 6 pages of 12 = 72 items)
//   limit      1..12        (defaults to 12)
//   placement  allowlisted  (defaults to 'standalone'). V1 ROLE: analytics segmentation, cache
//              partitioning, and a future extension point ONLY. It does NOT currently influence
//              eligibility, ranking, diversity, or presentation — every placement returns the SAME
//              ranked inventory (intentional in V1 for predictable, testable behavior). Later versions
//              MAY make it placement-aware (homepage diversity, category emphasis, city relevance,
//              personalization) without changing this contract. No speculative per-placement ranking in V1.
//   sort       'featured'   (only supported value in V1)
router.get('/discovery/items', normalLimiter, async (req, res, next) => {
  try {
    const result = await discoveryService.getFeaturedItems({
      page: req.query.page,
      limit: req.query.limit,
      placement: req.query.placement,
      sort: req.query.sort,
    });
    // Short public cache + conditional-request support (ranked list is cached ~3 min server-side).
    const etag = 'W/"disc-' + Buffer.from(JSON.stringify([
      result.context.placement, result.context.sort, result.pagination.page,
      result.pagination.limit, result.pagination.total, result.context.generatedAt,
    ])).toString('base64') + '"';
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.set('ETag', etag);
    res.set('Cache-Control', PUBLIC_CACHE);
    return res.json(result);
  } catch (err) { next(err); }
});

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
             ${B_NAME} AS seller_display_name,
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
             ${B_NAME}    AS seller_display_name
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
             ${B_NAME}    AS seller_display_name
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
             ${B_NAME}    AS seller_display_name
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
// Exported for regression tests (pure query-contract helpers).
module.exports.resolveFeedType = resolveFeedType;
module.exports.resolveFeedGeo = resolveFeedGeo;
