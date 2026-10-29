'use strict';

const scan = require('./scan');

/**
 * eventLinks — same-site links on a page that point at an event listing or a single event. Pure.
 *
 *   findEventLinks(html, baseUrl, { limit }) → [{ url, text, score, kind: 'listing'|'event' }]
 */

const { scorePath, EXCLUDE } = require('./sitemap');

function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch (_) { return ''; } })
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, '&');
}
const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

const LISTING_TEXT = /\b(upcoming|current|all)\s+(auctions?|sales|events|estate sales)\b|^(auctions?|estate sales?|events|calendar|sales|upcoming)$|\bauction calendar\b|\bview (all )?(auctions?|sales|events)\b/i;
const EVENT_TEXT = /\b(auction|estate sale|tag sale|online sale|catalog|preview|bid now|view catalog|sale details)\b/i;
const LISTING_PATH = /\/(auctions?|events?|calendar|estate-sales?|sales|upcoming(-auctions)?)\/?$/i;

function findEventLinks(html, baseUrl, { limit = 40 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch (_) { return []; }
  // Linear scanning (readers/scan): a hostile page cannot make this quadratic.
  const src = scan.stripBlocks(html, ['script', 'style', 'noscript']);
  const best = new Map();
  for (const el of scan.elements(src, 'a')) {
    const m = [null, el.attrs, el.inner];
    const hm = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const href = hm ? decode(hm[1] != null ? hm[1] : hm[2] != null ? hm[2] : hm[3]).trim() : '';
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|sms|data):/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch (_) { continue; }
    if (!/^https?:$/.test(u.protocol) || bareHost(u.hostname) !== bareHost(base.hostname)) continue;
    u.hash = '';
    if (EXCLUDE.test(u.pathname)) continue;
    const text = decode(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200);
    let score = scorePath(u.pathname);
    let kind = 'event';
    if (LISTING_PATH.test(u.pathname) || LISTING_TEXT.test(text)) { kind = 'listing'; score += 3; }
    else if (EVENT_TEXT.test(text)) score += 2;
    if (score <= 0) continue;
    const url = u.toString();
    if (url === base.toString().replace(/#.*$/, '')) continue;            // the page itself
    const prev = best.get(url);
    if (!prev || prev.score < score) best.set(url, { url, text, score, kind });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, Math.max(0, limit));
}

module.exports = { findEventLinks };
