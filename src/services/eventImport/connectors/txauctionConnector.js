'use strict';

/**
 * txauctionConnector — Gaston & Sheehan Auctioneers (www.txauction.com), the ORIGINAL HOST/auctioneer
 * for U.S. Treasury (TEOAF) and U.S. Marshals forfeited GENERAL PROPERTY auctions and many local/
 * municipal (police department / impound) auctions. Original-host, image-capable government auctions.
 *
 * ACCESS BASIS (documented 2026-08-25):
 *   • robots.txt (HTTP 200) User-agent:* allows all EXCEPT /admin/, /api/, /asset/ — auction + lot
 *     pages live under /auctions/ (ALLOWED) — and it PUBLISHES public sitemaps FOR crawlers
 *     (Sitemap: /sitemap/auctions), i.e. affirmative permission for automated access to those paths.
 *   • Pages are server-rendered with an embedded window.__APOLLO_STATE__ JSON graph (reliable parse,
 *     not fragile DOM) and public event images on a CloudFront CDN (no auth). We NEVER touch /api/,
 *     /admin/, or /asset/, never bypass anything, and honor a crawl delay + a small per-run cap.
 *
 * Flow (gentle): auctions sitemap-index → (cap) per-auction sitemaps → auction page → parse Apollo
 * state → canonical payload. Images are left to the image-enrichment pass, which fetches the auction
 * page's og:image (the CloudFront photo) and re-hosts it to Cloudinary with provenance.
 */

const { fetchText } = require('../http');
const { IDENTITY_FIELD_MAP } = require('../normalize/identityFieldMap');

const SITEMAP_INDEX = 'https://www.txauction.com/sitemap/auctions';
const DEFAULT_TZ = 'America/Chicago';           // Gaston & Sheehan is TX-based; auctions carry ISO UTC times anyway
const DEFAULT_CAP = 15;                          // gentle per-run cap (respect rate limits)
const CRAWL_DELAY_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLoc = (xml) => { const locs = (xml.match(/<loc>([^<]+)<\/loc>/gi) || []).map((s) => s.replace(/<\/?loc>/gi, '')); return locs; };

// Extract + parse window.__APOLLO_STATE__ from an auction page's HTML. Returns the Auction node or null.
function parseAuctionState(html) {
  const m = html && html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (!m) return null;
  let state; try { state = JSON.parse(m[1]); } catch (_) { return null; }
  const key = Object.keys(state).find((k) => state[k] && state[k].__typename === 'Auction');
  return key ? state[key] : null;
}

// Map a parsed Auction node → canonical payload (or null if not a usable upcoming auction).
function auctionToPayload(a, tz) {
  if (!a || !a.title) return null;
  const start = a.start_time || null;
  const end = a.end_time || null;
  if (!end) return null;                                  // need a reliable end for expiration
  const loc = a.auction_location || {};
  const org = (loc.line_1 && String(loc.line_1).trim()) || 'Gaston & Sheehan Auctioneers';
  return {
    payload: {
      title: String(a.title).trim(),
      description: a.description_plain ? String(a.description_plain).trim() : null,
      sale_type: 'auction',
      event_format: 'online',                             // online-bid government auctions
      start_at: start,
      end_at: end,
      timezone: tz || DEFAULT_TZ,
      city: loc.city || null,
      state: loc.state_name || loc.state || null,
      organizer_name: org,                                // host/consignor for attribution (host_company gate)
      external_url: a.public_url || null,                 // ORIGINAL host auction page (never a directory)
      bidding_url: a.public_url || null,
    },
    // Image is enriched from the page's og:image (CloudFront) and re-hosted to Cloudinary w/ provenance.
    images: [],
  };
}

module.exports = {
  key: 'txauction',
  capabilities: { incremental: false, deletions: false, images: true },
  fieldMap: IDENTITY_FIELD_MAP,

  parseAuctionState, auctionToPayload,   // exported for unit tests against captured fixtures

  async *fetch({ config, limit, signal } = {}) {
    config = config || {};
    const tz = config.timezone || DEFAULT_TZ;
    const cap = Math.min(limit != null ? limit : (config.cap || DEFAULT_CAP), config.cap || DEFAULT_CAP);
    const fetchOpts = { timeoutMs: 30000, maxBytes: 8 * 1024 * 1024, signal };

    // 1. Auctions sitemap-index → per-auction sitemap URLs (each ends in /sitemap/auction/{id}).
    let indexXml; try { indexXml = await fetchText(SITEMAP_INDEX, fetchOpts); } catch (_) { return; }
    const auctionSitemaps = firstLoc(indexXml).filter((u) => /\/sitemap\/auction\/\d+/.test(u));

    const seen = new Set(); let n = 0;
    for (const sm of auctionSitemaps) {
      if (n >= cap) return;
      await sleep(CRAWL_DELAY_MS);
      let smXml; try { smXml = await fetchText(sm, fetchOpts); } catch (_) { continue; }
      // The per-auction sitemap's first URL is the auction page (/auctions/{id}-{slug}); lots follow.
      const pageUrl = firstLoc(smXml).find((u) => /\/auctions\/\d+-/.test(u));
      if (!pageUrl || seen.has(pageUrl)) continue;
      seen.add(pageUrl);

      await sleep(CRAWL_DELAY_MS);
      let html; try { html = await fetchText(pageUrl, fetchOpts); } catch (_) { continue; }
      const auction = parseAuctionState(html);
      const mapped = auctionToPayload(auction, tz);
      if (!mapped) continue;
      // Skip already-ended auctions (defense-in-depth; publicationGate also blocks expired).
      if (mapped.payload.end_at && new Date(mapped.payload.end_at).getTime() < Date.now()) continue;

      const id = auction.auction_id != null ? String(auction.auction_id) : pageUrl;
      yield { sourceEventId: id, sourceUrl: mapped.payload.external_url, sourceUpdatedAt: null, payload: mapped.payload, images: mapped.images };
      n++;
    }
  },

  describe() {
    return { name: 'Gaston & Sheehan Auctioneers (Treasury / US Marshals / local government auctions)',
      docs: 'www.txauction.com — original-host government auctions; robots-permitted /auctions/ + public sitemaps; Apollo-state JSON + CloudFront images.' };
  },
};
