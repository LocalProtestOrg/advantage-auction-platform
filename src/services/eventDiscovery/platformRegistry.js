'use strict';

/**
 * platformRegistry — the reviewed list of website and listing platforms the discovery probe recognises
 * (provider-neutral discovery, 2026-10-29). DATA, not per-company code: an entry says how to recognise a
 * platform, which well-known event endpoints it publishes, and — for third-party listing platforms — what
 * its published terms say about automated collection and which alternative to offer instead.
 *
 * Changing an entry is a reviewed code change (the terms citations must be checked by a person).
 *
 *   detect(signals)            → the matching entries for a probed site ({ html, headers, url })
 *   thirdPartyFor(url)         → the registry entry when a URL is on a third-party listing platform
 *   wellKnownEndpoints(entry, origin) → candidate URLs to try (only on the company's own site)
 */

const PLATFORMS = Object.freeze([
  // ── Website builders / CMSs the COMPANY runs (its own site; its authorization covers collection) ──
  { key: 'wordpress', name: 'WordPress', kind: 'site_builder',
    detect: { html: [/<meta[^>]+name=["']generator["'][^>]+WordPress/i, /\/wp-content\//i, /\/wp-includes\//i] },
    endpoints: [
      { path: '/?ical=1', kind: 'ical', note: 'The Events Calendar iCal export' },
      { path: '/events/?ical=1', kind: 'ical', note: 'The Events Calendar iCal export (events archive)' },
      { path: '/wp-json/tribe/events/v1/events?per_page=50', kind: 'platform_endpoint', reader: 'tribe_events', note: 'The Events Calendar REST API' },
      { path: '/feed/', kind: 'rss', note: 'WordPress post feed (items need event dates)' },
      { path: '/wp-sitemap.xml', kind: 'sitemap', note: 'WordPress core sitemap' },
    ] },
  { key: 'squarespace', name: 'Squarespace', kind: 'site_builder',
    detect: { html: [/static1\.squarespace\.com/i, /<!-- This is Squarespace\. -->/i] },
    endpoints: [{ path: '/sitemap.xml', kind: 'sitemap' }] },
  { key: 'wix', name: 'Wix', kind: 'site_builder',
    detect: { html: [/static\.wixstatic\.com/i, /<meta[^>]+name=["']generator["'][^>]+Wix/i] },
    endpoints: [{ path: '/sitemap.xml', kind: 'sitemap' }] },
  { key: 'shopify', name: 'Shopify', kind: 'site_builder',
    detect: { html: [/cdn\.shopify\.com/i] }, endpoints: [{ path: '/sitemap.xml', kind: 'sitemap' }] },

  // ── Auction website platforms that HOST a company's own site (the host controls access) ──
  { key: 'invaluable', name: 'Invaluable (auction house websites)', kind: 'auction_host',
    detect: { html: [/image\.invaluable\.com\/housePhotos/i, /connectwp/i, /invaluable\.com\/auction-catalog/i],
      urls: [/\binvaluable\.com\b/i] },
    hostNote: 'Invaluable operates the edge for the auction-house sites it hosts; automated access needs its allowance.',
    alternative: 'push' },

  // ── Third-party listing platforms (NOT the company's own site; their terms govern collection) ──
  { key: 'estatesales_net', name: 'EstateSales.NET', kind: 'listing_platform', urls: [/(^|\.)estatesales\.(net|org)$/i],
    terms: { url: 'https://www.estatesales.net/terms-of-service', clause: '§16.6 and §5.1: no automated collection (including browsers) without express written permission' },
    prohibits_automation: true, alternative: 'push' },
  { key: 'hibid', name: 'HiBid', kind: 'listing_platform', urls: [/(^|\.)hibid\.com$/i],
    terms: { url: 'https://hibid.com/home/termsofuse', clause: '§9: no scraping, robots, spiders or data mining of auction information' },
    prohibits_automation: true, alternative: 'push' },
  { key: 'estatesale_com', name: 'EstateSale.com', kind: 'listing_platform', urls: [/(^|\.)estatesale\.com$/i],
    terms: { url: 'https://www.estatesale.com', clause: 'serves a bot challenge to automated clients' },
    prohibits_automation: true, alternative: 'push' },
  { key: 'liveauctioneers', name: 'LiveAuctioneers', kind: 'listing_platform', urls: [/(^|\.)liveauctioneers\.com$/i],
    terms: { url: 'https://www.liveauctioneers.com/termsandconditions/', clause: 'partnership-only access; scraping prohibited' },
    prohibits_automation: true, alternative: 'push' },
  { key: 'invaluable_marketplace', name: 'Invaluable marketplace', kind: 'listing_platform', urls: [/(^|\.)invaluable\.com$/i, /(^|\.)auctionzip\.com$/i],
    terms: { url: 'https://www.invaluable.com/inv/apiinfo/', clause: 'no read API (Catalog Upload API is inbound only); browser challenge on pages' },
    prohibits_automation: true, alternative: 'push' },
]);

function hostOf(u) { try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return null; } }

/** Registry entries that match a probed site. Pure. */
function detect({ html = '', url = '' } = {}) {
  const out = [];
  for (const p of PLATFORMS) {
    const d = p.detect || {};
    const byHtml = (d.html || []).some((re) => re.test(html));
    const byUrl = (d.urls || []).some((re) => re.test(url));
    if (byHtml || byUrl) out.push(p);
  }
  return out;
}

/** The third-party listing platform a URL belongs to, or null. Pure. */
function thirdPartyFor(url) {
  const h = hostOf(url);
  if (!h) return null;
  return PLATFORMS.find((p) => p.kind === 'listing_platform' && (p.urls || []).some((re) => re.test(h))) || null;
}

/** Well-known event endpoints for a recognised platform on the company's own origin. Pure. */
function wellKnownEndpoints(entry, origin) {
  return ((entry && entry.endpoints) || []).map((e) => Object.assign({}, e, { url: new URL(e.path, origin).toString() }));
}

module.exports = { PLATFORMS, detect, thirdPartyFor, wellKnownEndpoints, hostOf };
