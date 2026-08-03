'use strict';

/**
 * externalUrlPolicy — classifies an external URL and decides whether it is an ACCEPTABLE public
 * outbound destination for an Advantage.Bid event page.
 *
 * Product policy: the public event page may link ONLY to a destination controlled by the company
 * actually conducting the event. It must NEVER send a public visitor to the site where Advantage.Bid
 * *discovered* the event (EstateSales.NET etc.), a competing marketplace/auction site, a general event
 * directory/aggregator, a search-engine result, a link shortener whose target can't be verified, or a
 * social profile (unless the owner later approves social as a primary destination).
 *
 * The discovery/source URL is retained INTERNALLY (event_sources.source_url, events.attribution_*) for
 * provenance/dedupe/audit — this module only governs what may be shown to the public.
 *
 * Matching is by REGISTRABLE-DOMAIN SUFFIX (host === d OR host ends with '.'+d), so subdomains
 * (www.estatesales.net, m.ebay.com) are covered. Lists are data, easy to extend.
 */

// Where Advantage.Bid discovers events — never a public destination.
const DISCOVERY_SOURCES = [
  'estatesales.net', 'estatesales.org', 'estatesale.com', 'estatesales.com',
  'estatesale.net', 'estatesalefinder.com', 'estatesale-finder.com',
];

// Competing auction / estate-sale marketplaces and general classifieds.
const COMPETITOR_MARKETPLACES = [
  'bidsquare.com', 'liveauctioneers.com', 'invaluable.com', 'hibid.com', 'proxibid.com',
  'auctionzip.com', 'auctionninja.com', 'ctbids.com', 'maxsold.com', 'everythingbutthehouse.com',
  'ebth.com', 'gsaauctions.gov', 'govdeals.com', 'publicsurplus.com', 'shopgoodwill.com',
  'ebay.com', 'ebay.co.uk', 'craigslist.org', 'offerup.com', 'mercari.com', 'nextdoor.com',
  'auctions.yahoo.com', 'liquidation.com', 'k-bid.com', 'bidfta.com', 'bidwrangler.com',
];

// General event directories / aggregators.
const AGGREGATOR_DIRECTORIES = [
  'eventbrite.com', 'meetup.com', 'allevents.in', 'eventful.com', 'yelp.com', 'tagsellit.com',
  'garagesalefinder.com', 'yardsalesearch.com', 'gsalr.com',
];

// Search engines (a results URL is never a real destination).
const SEARCH_ENGINES = [
  'google.com', 'google.co.uk', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'search.yahoo.com',
  'baidu.com', 'yandex.com', 'ask.com',
];

// Link shorteners / redirectors whose final target can't be verified here.
const URL_SHORTENERS = [
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'buff.ly', 'is.gd', 'rebrand.ly', 'cutt.ly',
  'rb.gy', 'shorturl.at', 'lnkd.in', 'tiny.cc', 'bit.do', 'soo.gd',
];

// Social profiles — not a PRIMARY destination unless the owner approves later.
const SOCIAL_MEDIA = [
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'youtu.be', 'pinterest.com', 'linkedin.com', 'snapchat.com', 'threads.net',
];

const REJECT = [
  { list: DISCOVERY_SOURCES, reason: 'discovery_source' },
  { list: COMPETITOR_MARKETPLACES, reason: 'competitor_marketplace' },
  { list: AGGREGATOR_DIRECTORIES, reason: 'aggregator_directory' },
  { list: SEARCH_ENGINES, reason: 'search_engine' },
  { list: URL_SHORTENERS, reason: 'url_shortener' },
  { list: SOCIAL_MEDIA, reason: 'social_media' },
];

function normalizeHost(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;   // no mailto:, tel:, ftp:, javascript:
  let host = (u.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || host.indexOf('.') === -1) return null;                    // no bare/host-less
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;                 // raw IPv4 → never a company site
  if (host === 'localhost') return null;
  return host;
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

/**
 * classifyExternalUrl(url) → { ok, reason, host }
 *   ok:false with a specific reason for any rejected class; ok:true, reason:'ok' for a plausible
 *   company-controlled destination. Never throws.
 */
function classifyExternalUrl(url) {
  const host = normalizeHost(url);
  if (!host) return { ok: false, reason: 'malformed', host: null };
  for (const group of REJECT) {
    for (const d of group.list) {
      if (hostMatches(host, d)) return { ok: false, reason: group.reason, host };
    }
  }
  return { ok: true, reason: 'ok', host };
}

function isRejected(url) { return !classifyExternalUrl(url).ok; }

/**
 * pickHostDestination(event) → { url, host } | null
 *   Chooses the best ACCEPTABLE company-controlled public destination from the event's candidate URLs,
 *   in the policy's preferred order (a specific company event/registration page, then the company site),
 *   skipping anything that classifies as a discovery source, competitor, aggregator, search, shortener,
 *   or social. `external_url` (the discovery-source listing) is intentionally NOT a candidate. Returns
 *   null when no verified company-controlled destination can be confirmed (→ the page shows no link).
 */
function pickHostDestination(event) {
  const e = event || {};
  // Order: a specific company-controlled event/registration/bidding page, then the company website.
  // external_url is the DISCOVERY source and is never offered publicly.
  const candidates = [e.registration_url, e.bidding_url, e.organizer_website_url];
  for (const c of candidates) {
    if (!c) continue;
    const r = classifyExternalUrl(c);
    if (r.ok) return { url: c, host: r.host };
  }
  return null;
}

module.exports = {
  classifyExternalUrl,
  isRejected,
  pickHostDestination,
  // exported for tests / audits
  _lists: { DISCOVERY_SOURCES, COMPETITOR_MARKETPLACES, AGGREGATOR_DIRECTORIES, SEARCH_ENGINES, URL_SHORTENERS, SOCIAL_MEDIA },
};
