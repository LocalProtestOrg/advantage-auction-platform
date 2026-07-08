'use strict';

/**
 * shareMetaService — read-only, defensive data reads used by the server-side
 * share-meta middleware (src/middleware/shareMeta.js) to build per-entity
 * Open Graph / Twitter / canonical / title tags for shared links.
 *
 * DESIGN CONSTRAINTS (Phase 2 — highest-risk item):
 *   • FAIL-OPEN: every function returns null on invalid input / not-found / any
 *     error. It NEVER throws. The caller treats null as "leave the Phase-1
 *     static fallback meta in place".
 *   • Visibility-gated: only publicly-visible entities (auction state IN
 *     published/active/closed AND not archived) are ever exposed — mirrors the
 *     public read at src/routes/public.js. We do a DIRECT db read here (no HTTP)
 *     so the middleware stays fast and in-process.
 *   • Head-only concern: returns plain data; no HTML is built here.
 */

const db = require('../db');
const { publicBaseUrl } = require('../lib/publicUrls');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validUuid(id) { return typeof id === 'string' && UUID_RE.test(id); }

// Collapse all whitespace to single spaces, trim, and truncate to `max`
// characters (adding an ellipsis when truncated). Returns '' for null/empty.
function clean(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (max && t.length > max) return t.slice(0, max - 1).trimEnd() + '…';
  return t;
}

function base() {
  return publicBaseUrl().replace(/\/+$/, '');
}

/**
 * getAuctionMeta(id) — visibility-gated single-auction read.
 * Reuses the SELECT shape from src/routes/public.js:272 (subset of columns).
 * @returns {Promise<object|null>}
 */
async function getAuctionMeta(id) {
  if (!validUuid(id)) return null;
  try {
    const { rows } = await db.query(
      `SELECT a.title,
              a.subtitle,
              a.description,
              a.start_time,
              a.end_time,
              a.cover_image_url,
              a.banner_image_url,
              sp.display_name AS seller_display_name
         FROM auctions a
         LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
        WHERE a.id = $1
          AND a.state IN ('published', 'active', 'closed')
          AND a.is_archived IS NOT TRUE
        LIMIT 1`,
      [id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    const description = clean(r.subtitle || r.description, 160)
      || 'Bid on estate & liquidation lots on Advantage.Bid.';
    return {
      title:       clean(r.title, 200) || 'Auction',
      description,
      image:       r.cover_image_url || r.banner_image_url || null,
      url:         `${base()}/auction-view.html?auctionId=${encodeURIComponent(id)}`,
      type:        'website',
      startDate:   r.start_time || null,
      endDate:     r.end_time || null,
      siteName:    'Advantage.Bid',
      organizer:   r.seller_display_name || null,
    };
  } catch (e) {
    return null;
  }
}

/**
 * getLotMeta(id) — visibility-gated single-lot read (no public HTTP endpoint
 * exists for lots, so this is a direct DB read). Gated through the lot's parent
 * auction so a lot is only exposed when its auction is publicly visible.
 * @returns {Promise<object|null>}
 */
async function getLotMeta(id) {
  if (!validUuid(id)) return null;
  try {
    const { rows } = await db.query(
      `SELECT l.title,
              l.description,
              l.thumbnail_url,
              l.lot_number,
              l.auction_id,
              l.current_bid_cents,
              l.starting_bid_cents,
              a.title AS auction_title,
              (SELECT image_url
                 FROM lot_images
                WHERE lot_id = l.id
                ORDER BY sort_order ASC
                LIMIT 1) AS first_image_url
         FROM lots l
         JOIN auctions a ON a.id = l.auction_id
        WHERE l.id = $1
          AND a.state IN ('published', 'active', 'closed')
          AND a.is_archived IS NOT TRUE
        LIMIT 1`,
      [id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    const lotTitle    = clean(r.title, 200) || (r.lot_number ? `Lot ${r.lot_number}` : 'Lot');
    const auctionName = clean(r.auction_title, 120) || 'Advantage.Bid';
    // Prefer the lot's own description (richer preview); fall back to a composed
    // "<lot title> — <auction title> on Advantage.Bid" line when there is none.
    const description = clean(r.description, 160)
      || `${lotTitle} — ${auctionName} on Advantage.Bid`;
    // Reliable price for JSON-LD offers: prefer a live current bid, else the
    // starting bid. Only a positive integer cent value is exposed; anything
    // null/zero/non-numeric yields null so the caller OMITS offers entirely.
    const rawPrice = (typeof r.current_bid_cents === 'number' && r.current_bid_cents > 0)
      ? r.current_bid_cents
      : (typeof r.starting_bid_cents === 'number' && r.starting_bid_cents > 0 ? r.starting_bid_cents : null);
    const priceCents = Number.isFinite(rawPrice) && rawPrice > 0 ? Math.round(rawPrice) : null;
    return {
      title:        lotTitle,
      description,
      image:        r.first_image_url || r.thumbnail_url || null,
      url:          `${base()}/lot.html?lotId=${encodeURIComponent(id)}`,
      auctionTitle: auctionName,
      auctionId:    r.auction_id || null,
      priceCents,
      siteName:     'Advantage.Bid',
    };
  } catch (e) {
    return null;
  }
}

/**
 * getSitemapEntries() — visibility-gated URL inventory for the dynamic
 * /sitemap.xml route. Returns public auctions and their lots (lots only for
 * auctions that are themselves publicly visible), each with a lastmod date.
 *
 * FAIL-SAFE: never throws — returns { auctions: [], lots: [] } on any error so
 * the sitemap route can still emit the static marketing pages.
 *
 * Caps: most recent 2000 auctions, most recent 3000 lots (≈5000 URLs + static).
 *
 * @returns {Promise<{ auctions: Array<{id,lastmod}>, lots: Array<{id,lastmod}> }>}
 */
async function getSitemapEntries() {
  const VISIBLE = `a.state IN ('published', 'active', 'closed') AND a.is_archived IS NOT TRUE`;
  const out = { auctions: [], lots: [] };
  try {
    const a = await db.query(
      `SELECT a.id,
              COALESCE(a.updated_at, a.created_at) AS lastmod
         FROM auctions a
        WHERE ${VISIBLE}
        ORDER BY COALESCE(a.updated_at, a.created_at) DESC
        LIMIT 2000`
    );
    out.auctions = (a.rows || []).map(r => ({ id: r.id, lastmod: r.lastmod || null }));
  } catch (e) {
    // Leave auctions empty; still attempt lots below independently.
  }
  try {
    const l = await db.query(
      `SELECT l.id,
              COALESCE(l.updated_at, l.created_at) AS lastmod
         FROM lots l
         JOIN auctions a ON a.id = l.auction_id
        WHERE ${VISIBLE}
        ORDER BY COALESCE(l.updated_at, l.created_at) DESC
        LIMIT 3000`
    );
    out.lots = (l.rows || []).map(r => ({ id: r.id, lastmod: r.lastmod || null }));
  } catch (e) {
    // Leave lots empty.
  }
  return out;
}

module.exports = { getAuctionMeta, getLotMeta, getSitemapEntries, validUuid, clean };
