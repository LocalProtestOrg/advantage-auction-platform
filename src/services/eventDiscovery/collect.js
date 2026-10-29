'use strict';

/**
 * collect — the ONE way discovery and collection read a company's website. Shared by the dry-run probe and by
 * every scheduled channel read, so a page is always fetched the same honest way:
 *   • only after robots.txt has been read and allows the path (robots.js);
 *   • only public addresses, redirects kept on the same site (netGuard.safeFetch);
 *   • always the honest AdvantageBidBot identity; never a browser identity, never a solved challenge;
 *   • paced per host (crawl-delay honored), with a hard request budget;
 *   • every refusal classified from the response itself (blockClassifier) and recorded as evidence.
 *
 * Readers turn what was fetched into items shaped like feedConnector items
 * ({ sourceEventId, url, saleHints, payload, images?, evidence? }). Nothing here writes to the database.
 */

const netGuard = require('../eventImport/netGuard');
const robots = require('../eventImport/robots');
const classifier = require('../eventImport/blockClassifier');
const feed = require('../eventImport/connectors/feedConnector');
const microdata = require('../eventImport/readers/microdata');
const sitemap = require('../eventImport/readers/sitemap');
const eventLinks = require('../eventImport/readers/eventLinks');
const htmlEvent = require('../eventImport/readers/htmlEvent');
const registry = require('./platformRegistry');

const DEFAULTS = Object.freeze({ maxRequests: 40, minIntervalMs: 3000, maxPages: 12, timeoutMs: 25000 });

function originOf(u) { try { const x = new URL(String(u)); return x.protocol + '//' + x.host; } catch (_) { return null; } }
function pathOf(u) { try { const x = new URL(String(u)); return x.pathname + x.search; } catch (_) { return '/'; } }

/** A canonical, cross-channel identity for an event: its own page URL when it has one. Pure. */
function canonicalUrl(u) {
  try {
    const x = new URL(String(u));
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) x.searchParams.delete(k);
    x.hostname = x.hostname.toLowerCase();
    let s = x.toString();
    if (x.pathname !== '/' && s.endsWith('/') && !x.search) s = s.slice(0, -1);
    return s;
  } catch (_) { return null; }
}
/** An http(s) URL or null — nothing else (javascript:, data:, …) ever leaves a reader. Pure. */
function safeUrl(u) {
  if (!u) return null;
  try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) && String(u).length <= 1000 ? x.toString() : null; } catch (_) { return null; }
}
/** Clean one reader item in place: http(s)-only links and images, bounded text. */
function sanitizeItem(it) {
  it.url = safeUrl(it.url);
  const p = it.payload || {};
  p.images = (p.images || []).map((im) => ({ url: safeUrl(im && im.url), position: im && im.position })).filter((im) => im.url && /^https:/.test(im.url)).slice(0, 20);
  for (const k of ['organizer_website_url', 'registration_url', 'bidding_url', 'external_url']) if (p[k]) p[k] = safeUrl(p[k]);
  if (p.title) p.title = String(p.title).slice(0, 300);
  if (p.description) p.description = String(p.description).slice(0, 8000);
  it.payload = p;
  return it;
}

function stableId(item, fallbackPrefix) {
  const c = item.url ? canonicalUrl(item.url) : null;
  return c ? 'url:' + c : (fallbackPrefix || 'id') + ':' + String(item.sourceEventId || '');
}

/**
 * A budgeted, robots-aware, paced fetcher for ONE site. `deps` lets tests inject fetchImpl / lookup / sleep / now.
 *   get(url) → { allowed, resp, cls }   (allowed=false when robots disallows or the budget is spent; no request made)
 */
function makeFetcher(site, deps = {}) {
  const opts = Object.assign({}, DEFAULTS, deps.limits || {});
  const pacer = deps.pacer || netGuard.createHostPacer({ minIntervalMs: opts.minIntervalMs, now: deps.now, sleep: deps.sleep });
  const origin = originOf(site);
  const robotsCache = new Map();
  let requests = 0;
  const fetchOnce = (url, extra) => netGuard.safeFetch(url, Object.assign({ fetchImpl: deps.fetchImpl, lookup: deps.lookup, timeoutMs: opts.timeoutMs,
    allowedHosts: deps.allowedHosts || [] }, extra || {}));

  async function policyFor(o) {
    if (robotsCache.has(o)) return robotsCache.get(o);
    if (requests >= opts.maxRequests) return { status: 'budget', disallowAll: true, transient: true, evidence: { url: o + '/robots.txt', status: 'budget' }, parsed: { groups: [], sitemaps: [] }, sitemaps: [] };
    requests++;
    await pacer.wait(new URL(o).host);
    const raw = await fetchOnce(new URL('/robots.txt', o).toString(), { maxBytes: 512 * 1024 });
    const cls = classifier.classifyResponse({ status: raw.status, headers: raw.headers, text: raw.text, url: raw.url, requestedUrl: o + '/robots.txt' });
    const policy = await robots.fetchRobots(o, { fetchFn: async () => raw });
    policy.cls = cls;
    // Our own network guard refused the address (private / loopback / non-public): never "allow all".
    if (raw.status === 'blocked') {
      policy.allowAll = false; policy.disallowAll = true; policy.refused = true;
      policy.cls = { class: 'unsafe_address', transient: false, reason: raw.reason, evidence: { status: 'blocked', url: o + '/robots.txt', reason: raw.reason } };
    }
    // A challenge or refusal on robots.txt itself is the host refusing us: nothing else is requested.
    if (cls.class === 'bot_challenge' || cls.class === 'host_firewall_refusal') { policy.disallowAll = true; policy.refused = true; }
    const delay = robots.crawlDelaySeconds(policy.parsed, robots.AGENT_TOKEN);
    if (delay && delay * 1000 > opts.minIntervalMs) policy.crawlDelayMs = Math.min(delay * 1000, 30000);
    robotsCache.set(o, policy);
    return policy;
  }

  async function get(url, extra) {
    const o = originOf(url);
    if (!o) return { allowed: false, reason: 'invalid_url' };
    // Only the company's own site (and hosts recorded on its authorization). A hostile page cannot point the
    // importer at a third party.
    const host = new URL(o).hostname;
    if (!netGuard.sameSiteHost(new URL(origin).hostname, host) && !netGuard.sameSiteHost(host, new URL(origin).hostname)
        && !(deps.allowedHosts || []).some((h) => netGuard.sameSiteHost(h, host))) {
      return { allowed: false, reason: 'offsite' };
    }
    const policy = await policyFor(o);
    if (!robots.policyAllows(policy, robots.AGENT_TOKEN, pathOf(url))) {
      return { allowed: false, reason: policy.refused ? 'refused' : policy.transient ? 'robots_unavailable' : 'robots_disallow', robots: policy };
    }
    if (requests >= opts.maxRequests) return { allowed: false, reason: 'budget_spent' };
    requests++;
    await pacer.wait(new URL(o).host, policy.crawlDelayMs);
    const resp = await fetchOnce(url, extra);
    const cls = classifier.classifyResponse({ status: resp.status, headers: resp.headers, text: resp.text, url: resp.url, requestedUrl: url });
    return { allowed: true, resp, cls };
  }

  return { get, robots: (o) => policyFor(o || origin), get requests() { return requests; }, origin };
}

const isOk = (r) => r && r.allowed && r.cls && r.cls.class === 'ok' && typeof r.resp.text === 'string';

function blockFrom(r, url) {
  if (!r) return null;
  if (!r.allowed) {
    const p = r.robots;
    if (p && p.refused) return { url, class: (p.cls && p.cls.class) || 'host_firewall_refusal', evidence: (p.cls && p.cls.evidence) || p.evidence, transient: false, at: 'robots.txt' };
    if (p && p.transient) return { url, class: 'unreachable', evidence: p.evidence, transient: true, at: 'robots.txt' };
    if (r.reason === 'robots_disallow') return { url, class: 'robots_disallow', evidence: { url }, transient: false };
    return null;
  }
  if (r.cls.class === 'ok') return null;
  return { url, class: r.cls.class, evidence: r.cls.evidence, transient: !!r.cls.transient };
}

// ── readers over fetched text ────────────────────────────────────────────────────────────────

function itemsFromFeedText(text, contentType, url, kind, tz) {
  const type = kind === 'ical' || kind === 'rss' ? kind : feed._parsers.detectType(text, contentType, url);
  const gen = type === 'ical' ? feed._parsers.parseIcal(text, tz) : type === 'rss' ? feed._parsers.parseRss(text) : feed._parsers.parseJsonLd(text);
  return { type, items: [...gen].filter((x) => x && x.payload && x.payload.title), valid: feed._parsers.looksLikeFeed(type, text) };
}

/** Schema.org events on one HTML page: JSON-LD first, then microdata/RDFa. Pure. */
function itemsFromPage(html, url, timezone) {
  const ld = [...feed._parsers.parseJsonLd(html)].filter((x) => x && x.payload && x.payload.title);
  const md = microdata.parseMicrodataEvents(html, url, { timezone: timezone || undefined }) || [];
  return { jsonld: ld, microdata: [...md].filter((x) => x && x.payload && x.payload.title) };
}

/** The Events Calendar (WordPress) REST payload → items. Pure; only stated fields. */
function itemsFromTribe(text) {
  let j; try { j = JSON.parse(text); } catch (_) { return { items: [], valid: false }; }
  const events = Array.isArray(j && j.events) ? j.events : null;
  if (!events) return { items: [], valid: false };
  const iso = (d, tz) => (d ? (tz ? require('../../lib/timezoneUtils').localToUtcIso(String(d).replace(' ', 'T').slice(0, 16), tz) : null) : null);
  const items = events.map((e) => {
    const tz = e.timezone || null;
    const v = e.venue && !Array.isArray(e.venue) ? e.venue : {};
    return {
      sourceEventId: String(e.id || e.url || ''), url: e.url || null,
      saleHints: [].concat(e.categories || []).map((c) => c && c.name).filter(Boolean).join(' | ') || null,
      payload: { title: feed._parsers.stripHtml ? feed._parsers.stripHtml(e.title) : String(e.title || '').replace(/<[^>]*>/g, ''),
        description: String(e.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null,
        start_at: e.utc_start_date ? String(e.utc_start_date).replace(' ', 'T') + 'Z' : iso(e.start_date, tz),
        end_at: e.utc_end_date ? String(e.utc_end_date).replace(' ', 'T') + 'Z' : iso(e.end_date, tz),
        timezone: tz || undefined, venue_name: v.venue || null, address: v.address || null, city: v.city || null,
        state: v.stateprovince || v.state || null, zip: v.zip || null,
        images: e.image && e.image.url ? [{ url: e.image.url, position: 0 }] : [] },
    };
  }).filter((x) => x.payload.title);
  return { items, valid: true };
}

const hasEventDate = (it) => !!(it.payload && (it.payload.start_at || it.payload.end_date));
function upcoming(items, now) {
  const t = now instanceof Date ? now.getTime() : Number(now || Date.now());
  return items.filter((it) => {
    const end = Date.parse(it.payload.end_at || it.payload.end_date || it.payload.start_at || '');
    return Number.isFinite(end) && end >= t - 12 * 3600 * 1000;
  });
}

/**
 * Read the event pages a listing page / sitemap points to. mode 'structured' takes JSON-LD/microdata only;
 * mode 'html' uses the confirmed HTML profile (or proposes one when profile is null).
 * Returns { items, pages, blocks, extractions } — extractions carry per-page evidence for profiles and drift.
 */
async function readLinkedPages(fetcher, { listingUrls = [], sitemapUrls = [], origin, maxPages = DEFAULTS.maxPages, mode = 'structured', profile = null, timezone = null } = {}) {
  const blocks = [];
  const candidates = new Map();
  for (const lu of listingUrls) {
    const r = await fetcher.get(lu);
    if (!isOk(r)) { const b = blockFrom(r, lu); if (b) blocks.push(b); continue; }
    for (const l of eventLinks.findEventLinks(r.resp.text, r.resp.url || lu, { limit: maxPages * 2 }) || []) if (!candidates.has(l.url)) candidates.set(l.url, l.score || 0);
  }
  for (const su of sitemapUrls) {
    const r = await fetcher.get(su);
    if (!isOk(r)) { const b = blockFrom(r, su); if (b) blocks.push(b); continue; }
    const sm = sitemap.parseSitemap(r.resp.text);
    let urls = sm.urls || [];
    for (const child of (sm.sitemaps || []).slice(0, 3)) {
      const rc = await fetcher.get(child);
      if (isOk(rc)) urls = urls.concat(sitemap.parseSitemap(rc.resp.text).urls || []);
    }
    for (const u of sitemap.eventUrlCandidates(urls, { host: registry.hostOf(origin), limit: maxPages * 2 }) || []) {
      const url = typeof u === 'string' ? u : u.loc || u.url;
      if (url && !candidates.has(url)) candidates.set(url, u.score || 0);
    }
  }
  const pages = [...candidates.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, maxPages);
  const items = []; const extractions = [];
  for (const pu of pages) {
    const r = await fetcher.get(pu);
    if (!isOk(r)) { const b = blockFrom(r, pu); if (b) blocks.push(b); continue; }
    const html = r.resp.text;
    if (mode === 'structured') {
      const p = itemsFromPage(html, r.resp.url || pu, timezone);
      for (const it of p.jsonld.concat(p.microdata)) { if (!it.url) it.url = r.resp.url || pu; items.push(it); }
    } else {
      const x = htmlEvent.extractEventFromHtml(html, r.resp.url || pu, { timezone, profile });
      const drift = profile ? htmlEvent.checkDrift(profile, x) : { drift: false, reasons: [] };
      extractions.push({ url: pu, ok: x.ok, confidence: x.confidence, reasons: x.reasons, evidence: x.evidence, drift });
      if (x.ok && !drift.drift) items.push(x.item);
    }
  }
  return { items, pages, blocks, extractions };
}

/** The image a page itself declares (og:image, then its JSON-LD event image). Pure; same-site https only. */
function pageImage(html, pageUrl) {
  const m = /<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["']/i.exec(html);
  let url = m ? m[1] : null;
  if (!url) { const ld = itemsFromPage(html, pageUrl).jsonld.find((x) => x.payload.images && x.payload.images.length); url = ld ? ld.payload.images[0].url : null; }
  if (!url) return null;
  try { const u = new URL(url.replace(/&amp;/g, '&'), pageUrl); return u.protocol === 'https:' ? u.toString() : null; } catch (_) { return null; }
}

/**
 * Give image-less items the image their own event page declares (the company's own photo, linked, never
 * re-hosted here). Bounded: at most `max` page reads per channel read, robots and pacing as always.
 */
async function enrichImages(fetcher, items, { max = 10 } = {}) {
  let reads = 0;
  for (const it of items) {
    if (reads >= max) break;
    if ((it.payload.images && it.payload.images.length) || !it.url || originOf(it.url) !== fetcher.origin) continue;
    reads++;
    const r = await fetcher.get(it.url);
    if (!isOk(r)) continue;
    const img = pageImage(r.resp.text, r.resp.url || it.url);
    if (img) it.payload.images = [{ url: img, position: 0 }];
  }
  return items;
}

/** Read one ACTIVE channel at sync time. Returns { items, blocks, error, extractions, drift }. */
async function readChannel(fetcher, ch, { now } = {}) {
  const tz = ch.timezone || null;
  const cfg = ch.config || {};
  if (ch.kind === 'ical' || ch.kind === 'rss' || ch.kind === 'push_calendar') {
    const r = await fetcher.get(ch.url);
    if (!isOk(r)) return { items: [], blocks: [blockFrom(r, ch.url)].filter(Boolean) };
    const out = itemsFromFeedText(r.resp.text, r.resp.contentType, ch.url, ch.kind === 'push_calendar' ? 'ical' : ch.kind, tz || 'America/New_York');
    if (!out.valid && !out.items.length) return { items: [], blocks: [], error: 'format_changed' };
    return { items: out.items.filter(hasEventDate) };
  }
  if (ch.kind === 'jsonld' || ch.kind === 'microdata') {
    const r = await fetcher.get(ch.url);
    if (!isOk(r)) return { items: [], blocks: [blockFrom(r, ch.url)].filter(Boolean) };
    const p = itemsFromPage(r.resp.text, r.resp.url || ch.url, tz);
    const items = ch.kind === 'jsonld' ? p.jsonld : p.microdata;
    if (!items.length && !(cfg.allow_empty)) return { items: [], error: 'no_structured_events' };
    return { items: items.filter(hasEventDate) };
  }
  if (ch.kind === 'platform_endpoint') {
    const r = await fetcher.get(ch.url);
    if (!isOk(r)) return { items: [], blocks: [blockFrom(r, ch.url)].filter(Boolean) };
    const out = itemsFromTribe(r.resp.text);
    if (!out.valid) return { items: [], error: 'format_changed' };
    return { items: out.items.filter(hasEventDate) };
  }
  if (ch.kind === 'linked_pages' || ch.kind === 'html_profile') {
    const out = await readLinkedPages(fetcher, { listingUrls: cfg.listing_urls || (ch.url ? [ch.url] : []), sitemapUrls: cfg.sitemap_urls || [],
      origin: originOf(ch.url || cfg.origin), maxPages: cfg.max_pages || DEFAULTS.maxPages,
      mode: ch.kind === 'html_profile' ? 'html' : 'structured', profile: ch.profile, timezone: tz });
    const drifted = out.extractions.filter((e) => e.drift && e.drift.drift);
    return { items: out.items.filter(hasEventDate), blocks: out.blocks, extractions: out.extractions,
      drift: ch.kind === 'html_profile' && out.extractions.length > 0 && drifted.length * 2 >= out.extractions.length ? drifted.slice(0, 5) : null };
  }
  return { items: [], error: 'unsupported_kind' };
}

module.exports = { DEFAULTS, originOf, canonicalUrl, stableId, makeFetcher, isOk, blockFrom, itemsFromFeedText, itemsFromPage, itemsFromTribe,
  readLinkedPages, readChannel, upcoming, hasEventDate, pageImage, enrichImages, safeUrl, sanitizeItem };
