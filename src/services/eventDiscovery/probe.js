'use strict';

/**
 * probe — automatic, DRY-RUN discovery of how an authorized company's public events can be collected.
 * It never writes events. It reads the company's own site through collect.makeFetcher (robots first, honest
 * identity, public addresses, same-site redirects, paced, budgeted) and returns ranked candidate channels with a
 * preview of the events each one shows, plus every refusal it met (classified from the response).
 *
 *   discover({ website, eventsPageUrl, timezone, now, deps }) → {
 *     outcome: 'channels_found' | 'blocked' | 'nothing_found' | 'error',
 *     platform, robots, blocks[], candidates[{ kind, url, sale_type_hint, score, access_basis, access_evidence,
 *       config, profile?, preview[], upcoming }], requests, third_party? }
 *
 * Order (stops reading more once enough is found or the budget is spent):
 *   robots.txt → home page / events page → declared feeds (<link rel=alternate>) → structured data on those pages
 *   → platform well-known endpoints (registry data) → linked event pages and sitemaps (structured) → generic HTML
 *   extraction on single-event pages (proposes a profile; never auto-published, see Phase 4 rules).
 */

const collect = require('./collect');
const registry = require('./platformRegistry');
const feed = require('../eventImport/connectors/feedConnector');
const htmlEvent = require('../eventImport/readers/htmlEvent');
const eventLinks = require('../eventImport/readers/eventLinks');

const PREVIEW_MAX = 10;

function previewOf(items) {
  return items.slice(0, PREVIEW_MAX).map((it) => ({ title: it.payload.title, start_at: it.payload.start_at || it.payload.end_date || null,
    end_at: it.payload.end_at || null, url: it.url || null, city: it.payload.city || null, state: it.payload.state || null,
    sale_type: feed._parsers.classifySaleType(it.payload.title, it.saleHints) || null }));
}

function saleTypeHintOf(items, url) {
  const t = { auction: 0, estate_sale: 0 };
  for (const it of items) { const s = feed._parsers.classifySaleType(it.payload.title, it.saleHints); if (s) t[s]++; }
  if (t.auction && !t.estate_sale) return 'auction';
  if (t.estate_sale && !t.auction) return 'estate_sale';
  const p = String(url || '').toLowerCase();
  if (/estate[-_]?sale/.test(p) && !/auction/.test(p)) return 'estate_sale';
  if (/(auction|catalog)/.test(p) && !/estate[-_]?sale/.test(p)) return 'auction';
  return null;
}

/** Candidate score: upcoming dated events with their own links, from a well-formed source. Pure. */
function scoreOf(items, upcomingItems, { structured = true } = {}) {
  if (!items.length) return 0;
  const dated = items.filter(collect.hasEventDate).length / items.length;
  const linked = items.filter((i) => i.url).length / items.length;
  return Math.round((Math.min(upcomingItems.length, 10) * 6 + dated * 20 + linked * 10 + (structured ? 10 : 0)) * 10) / 10;
}

async function discover({ website, eventsPageUrl = null, timezone = null, now = new Date(), deps = {}, _wwwTried = false } = {}) {
  const origin = collect.originOf(website);
  if (!origin) return { outcome: 'error', error: 'invalid website', candidates: [], blocks: [], requests: 0 };
  const third = registry.thirdPartyFor(origin);
  if (third) {
    return { outcome: 'blocked', third_party: third.key, platform: third.key, candidates: [], requests: 0,
      blocks: [{ url: origin, class: 'terms_prohibit', transient: false, evidence: { platform: third.name, terms: third.terms } }] };
  }
  const fetcher = collect.makeFetcher(origin, deps);
  const blocks = []; const candidates = []; const tz = timezone || 'America/New_York';
  const policy = await fetcher.robots(origin);
  const robotsInfo = { status: policy.status, refused: !!policy.refused, transient: !!policy.transient, sitemaps: policy.sitemaps || [] };
  const done = (outcome, extra) => Object.assign({ outcome, robots: robotsInfo, blocks, candidates: candidates.sort((a, b) => b.score - a.score), requests: fetcher.requests }, extra || {});

  if (policy.refused || policy.transient) {
    const b = collect.blockFrom({ allowed: false, robots: policy }, origin + '/robots.txt');
    if (b) blocks.push(b);
    return done(policy.transient ? 'error' : 'blocked', { error: policy.transient ? 'robots.txt temporarily unavailable' : undefined });
  }

  // 1. Entry pages: the home page and the seller's optional events page (same site only).
  const entryUrls = [origin + '/'];
  if (eventsPageUrl && collect.originOf(eventsPageUrl) && registry.hostOf(eventsPageUrl) === registry.hostOf(origin)) entryUrls.unshift(eventsPageUrl);
  const pages = [];
  for (const u of entryUrls) {
    const r = await fetcher.get(u);
    if (collect.isOk(r)) pages.push({ url: r.resp.url || u, html: r.resp.text, headers: r.resp.headers });
    else { const b = collect.blockFrom(r, u); if (b) blocks.push(b); }
  }
  if (!pages.length) {
    // The bare domain answered nothing: many companies serve only on www. (same site). Try it once.
    const host = new URL(origin).hostname;
    if (!_wwwTried && !/^www\./i.test(host) && blocks.every((b) => b.class === 'not_found' || b.class === 'unreachable')) {
      const left = Math.max(0, ((deps.limits && deps.limits.maxRequests) || collect.DEFAULTS.maxRequests) - fetcher.requests);
      const alt = await discover({ website: origin.replace('://', '://www.'), eventsPageUrl, timezone, now, _wwwTried: true,
        deps: Object.assign({}, deps, { limits: Object.assign({}, deps.limits || {}, { maxRequests: left }) }) });
      if (alt.outcome !== 'nothing_found' || alt.candidates.length) return Object.assign(alt, { requests: alt.requests + fetcher.requests, website_used: origin.replace('://', '://www.') });
    }
    return done(blocks.some((b) => !b.transient && b.class !== 'not_found') ? 'blocked' : 'nothing_found');
  }

  const platforms = registry.detect({ html: pages.map((p) => p.html).join('\n'), url: origin });
  const platform = platforms.length ? platforms[0].key : null;
  const access = (url, how) => ({ basis: 'robots_and_terms_permit', robots_status: policy.status, checked_at: (now instanceof Date ? now : new Date(now)).toISOString(), url, how });
  const add = (kind, url, items, extra) => {
    if (!collect.safeUrl(url)) return;                      // over-long or non-http(s) channel URLs are never stored
    items = items.map(collect.sanitizeItem);
    const up = collect.upcoming(items, now);
    candidates.push(Object.assign({ kind, url, sale_type_hint: saleTypeHintOf(items, url), score: scoreOf(items, up, { structured: kind !== 'html_profile' }),
      access_basis: 'robots_and_terms_permit', access_evidence: access(url, kind), config: {}, preview: previewOf(up.length ? up : items), upcoming: up.length,
      timezone: timezone || null }, extra || {}));
  };

  // 2. Declared feeds and structured data on the entry pages.
  const feedLinks = [];
  for (const p of pages) {
    for (const f of feed._parsers.discoverFeeds(p.html, p.url)) if (f.type !== 'jsonld' && !feedLinks.find((x) => x.url === f.url)) feedLinks.push(f);
    const s = collect.itemsFromPage(p.html, p.url, timezone);
    if (s.jsonld.length) add('jsonld', p.url, s.jsonld);
    if (s.microdata.length) add('microdata', p.url, s.microdata);
  }
  for (const f of feedLinks.slice(0, 4)) {
    const r = await fetcher.get(f.url);
    if (!collect.isOk(r)) { const b = collect.blockFrom(r, f.url); if (b) blocks.push(b); continue; }
    const out = collect.itemsFromFeedText(r.resp.text, r.resp.contentType, f.url, f.type, tz);
    const dated = out.items.filter(collect.hasEventDate);
    if (dated.length) add(out.type === 'ical' ? 'ical' : 'rss', f.url, dated);
  }

  // 3. Platform well-known endpoints (registry data; only on the company's own origin).
  const sitemapUrls = [...new Set([...(policy.sitemaps || []).filter((u) => registry.hostOf(u) === registry.hostOf(origin)), origin + '/sitemap.xml'])];
  for (const pf of platforms) {
    for (const ep of registry.wellKnownEndpoints(pf, origin)) {
      if (ep.kind === 'sitemap') { if (!sitemapUrls.includes(ep.url)) sitemapUrls.push(ep.url); continue; }
      if (candidates.find((c) => c.kind === ep.kind && c.url === ep.url)) continue;
      const r = await fetcher.get(ep.url);
      if (!collect.isOk(r)) { const b = collect.blockFrom(r, ep.url); if (b && b.class !== 'not_found') blocks.push(b); continue; }
      if (ep.kind === 'platform_endpoint') {
        const out = collect.itemsFromTribe(r.resp.text);
        if (out.valid && out.items.length) add('platform_endpoint', ep.url, out.items, { config: { reader: ep.reader } });
      } else {
        const out = collect.itemsFromFeedText(r.resp.text, r.resp.contentType, ep.url, ep.kind, tz);
        const dated = out.items.filter(collect.hasEventDate);
        if (dated.length) add(ep.kind, ep.url, dated);
      }
    }
  }

  // 4. Linked event pages (structured data on each event's own page), from navigation and sitemaps.
  const listingUrls = [];
  for (const p of pages) {
    listingUrls.push(p.url);
    for (const l of (eventLinks.findEventLinks(p.html, p.url, { limit: 6 }) || []).filter((x) => /(auction|estate|sale|event|calendar|catalog|upcoming)/i.test(x.url))) {
      if (!listingUrls.includes(l.url) && listingUrls.length < 4) listingUrls.push(l.url);
    }
  }
  const structuredFound = candidates.some((c) => c.upcoming > 0);
  if (!structuredFound) {
    const lp = await collect.readLinkedPages(fetcher, { listingUrls, sitemapUrls, origin, maxPages: 8, mode: 'structured' });
    lp.blocks.filter((b) => b.class !== 'not_found').forEach((b) => blocks.push(b));
    if (lp.items.length) add('linked_pages', listingUrls[0], lp.items, { config: { listing_urls: listingUrls, sitemap_urls: sitemapUrls, max_pages: 25 } });

    // 5. Generic HTML extraction (Phase 4): propose a profile from single-event pages. Never auto-published.
    if (!lp.items.length && lp.pages.length) {
      const hx = await collect.readLinkedPages(fetcher, { listingUrls, sitemapUrls, origin, maxPages: 6, mode: 'html', timezone });
      const okx = hx.extractions.filter((e) => e.ok);
      if (okx.length >= 2) {
        const profile = htmlEvent.buildProfile(okx.map((e) => ({ ok: true, evidence: e.evidence, confidence: e.confidence })));
        add('html_profile', listingUrls[0], hx.items, { profile, config: { listing_urls: listingUrls, sitemap_urls: sitemapUrls, max_pages: 25,
          proposed_from: okx.map((e) => e.url) }, extractions: hx.extractions.slice(0, 6) });
      }
    }
  }

  const usable = candidates.filter((c) => c.preview.length);
  return done(usable.length ? 'channels_found' : (blocks.some((b) => !b.transient && b.class !== 'not_found') ? 'blocked' : 'nothing_found'),
    { platform, platforms: platforms.map((p) => p.key), candidates: usable });
}

module.exports = { discover, scoreOf, saleTypeHintOf, previewOf, PREVIEW_MAX, linksFor: eventLinks.findEventLinks };
