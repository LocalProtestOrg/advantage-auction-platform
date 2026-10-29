'use strict';

/**
 * sitemap — XML sitemaps (urlset and sitemapindex) and the selection of likely event pages from them.
 * Pure: string in, data out; no network.
 *
 *   parseSitemap(xml)                          → { urls: [{ loc, lastmod }], sitemaps: [loc] }
 *   eventUrlCandidates(urls, { host, limit })  → [{ loc, lastmod, score }]  same-host, likely event pages
 */

function decode(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#0*39;/g, "'").replace(/&amp;/g, '&')
    .trim();
}
// Linear scanning (readers/scan). Namespace prefixes (<sm:url>) are dropped first so plain names match.
const scan = require('./scan');
const unprefix = (xml) => scan.capped(xml).replace(/<(\/?)[A-Za-z][\w-]*:/g, '<$1');
const tagValue = (block, name) => { const el = scan.elements(block, name, { limit: 1 })[0]; return el ? decode(el.inner) : null; };
const blocks = (xml, name) => scan.elements(unprefix(xml), name, { limit: 50000 }).map((el) => el.inner);

function parseSitemap(xml) {
  const urls = [];
  const sitemaps = [];
  for (const b of blocks(xml, 'sitemap')) { const loc = tagValue(b, 'loc'); if (loc) sitemaps.push(loc); }
  for (const b of blocks(xml, 'url')) {
    const loc = tagValue(b, 'loc');
    if (loc) urls.push({ loc, lastmod: tagValue(b, 'lastmod') || null });
  }
  return { urls, sitemaps };
}

const EVENT_WORDS = [
  [/auction/, 3], [/catalog/, 3], [/estate[-_]?sale/, 4], [/estate/, 2], [/\bsales?\b|[-_/]sales?[-_/]|[-_/]sales?$/, 2],
  [/event/, 2], [/calendar/, 2], [/upcoming/, 2], [/preview/, 1], [/bidding|online-bidding/, 1],
  [/(19|20)\d{2}/, 1],                                                   // a dated slug
];
const EXCLUDE = /\/(tag|tags|category|categories|author|page|feed|wp-content|wp-json|wp-admin|attachment|cart|checkout|account|login|search)(\/|$)|\.(jpe?g|png|gif|webp|svg|pdf|zip|docx?|xlsx?|mp4|mov)(\?|$)/i;

const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

/** Score a URL path for "this is an event page". 0 = not a candidate. "lot" alone never qualifies. Pure. */
function scorePath(pathname) {
  const p = decodeURIComponent(String(pathname || '')).toLowerCase();
  if (!p || p === '/' || EXCLUDE.test(p)) return 0;
  let s = 0;
  for (const [re, w] of EVENT_WORDS) if (re.test(p)) s += w;
  if (s === 1 && /(19|20)\d{2}/.test(p)) return 0;                      // a year alone is not an event signal
  return s;
}

function eventUrlCandidates(urls, { host = null, limit = 50 } = {}) {
  const want = bareHost(host);
  const out = [];
  const seen = new Set();
  for (const u of urls || []) {
    let parsed;
    try { parsed = new URL(u.loc); } catch (_) { continue; }
    if (!/^https?:$/.test(parsed.protocol)) continue;
    if (want && bareHost(parsed.hostname) !== want) continue;
    parsed.hash = '';
    const loc = parsed.toString();
    if (seen.has(loc)) continue;
    const score = scorePath(parsed.pathname);
    if (score <= 0) continue;
    seen.add(loc);
    out.push({ loc, lastmod: u.lastmod || null, score });
  }
  out.sort((a, b) => {
    const ta = a.lastmod ? Date.parse(a.lastmod) || 0 : 0;
    const tb = b.lastmod ? Date.parse(b.lastmod) || 0 : 0;
    return tb - ta || b.score - a.score || a.loc.localeCompare(b.loc);
  });
  return out.slice(0, Math.max(0, limit));
}

module.exports = { parseSitemap, eventUrlCandidates, scorePath, EXCLUDE };
