'use strict';

/**
 * homeDiscoveryService — crawlable links from the home page to public inventory (SEO, owner 2026-11-11).
 *
 * The home page is a map drawn in the browser, so its raw HTML had no links to auctions, estate sales or items. This
 * builds a short, plain list of links (live and upcoming auctions, upcoming estate sales and events, newest items for
 * sale) that the server places inside the home page's existing no-JavaScript block. Visitors with JavaScript see the
 * map exactly as before.
 *
 * Visibility comes ONLY from the shared rules: auctions activeNativeAuctionSql, events activeEventSql (both in
 * src/lib/marketplaceVisibility.js), items the sitemap's own list (productPageService.sitemapEntries). Demo, hidden,
 * draft, private and taken-down records can never appear. Cached for 10 minutes; any error yields no list (the page
 * still serves).
 */

const db = require('../db');
const { activeNativeAuctionSql, activeEventSql } = require('../lib/marketplaceVisibility');

const PER_GROUP = 8;
const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, html: '' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function groups(runner = db) {
  const out = { auctions: [], events: [], items: [] };
  try {
    out.auctions = (await runner.query(
      `SELECT a.id, a.title FROM auctions a WHERE ${activeNativeAuctionSql('a')} AND a.title IS NOT NULL
        ORDER BY a.end_time ASC NULLS LAST LIMIT ${PER_GROUP}`)).rows
      .map((r) => ({ href: `/auction-view.html?auctionId=${encodeURIComponent(r.id)}`, text: r.title }));
  } catch (e) { out.auctions = []; }
  try {
    out.events = (await runner.query(
      `SELECT e.slug, e.title FROM events e WHERE ${activeEventSql('e')} AND e.slug IS NOT NULL AND e.title IS NOT NULL
        ORDER BY e.start_at ASC NULLS LAST LIMIT ${PER_GROUP}`)).rows
      .map((r) => ({ href: `/event.html?slug=${encodeURIComponent(r.slug)}`, text: r.title }));
  } catch (e) { out.events = []; }
  try {
    const shop = await require('./productPageService').sitemapEntries(runner);
    out.items = (shop.items || []).filter((i) => i.title).slice(0, PER_GROUP).map((i) => ({ href: i.path, text: i.title }));
  } catch (e) { out.items = []; }
  return out;
}

function render(g) {
  const list = (heading, more, rows) => (rows.length
    ? `<h3>${esc(heading)}</h3><ul>${rows.map((r) => `<li><a href="${esc(r.href)}">${esc(r.text)}</a></li>`).join('')}</ul>`
      + `<p><a href="${esc(more.href)}">${esc(more.text)}</a></p>`
    : '');
  return list('Live and upcoming auctions', { href: '/search.html?mode=auctions&status=active', text: 'All current auctions' }, g.auctions)
    + list('Estate sales and events', { href: '/events.html', text: 'All estate sales and events' }, g.events)
    + list('Items for sale', { href: '/shop', text: 'Shop all items' }, g.items);
}

/** The cached link list (HTML string, possibly empty). Never throws. */
async function linksHtml(runner = db, now = Date.now()) {
  if (cache.html !== null && now - cache.at < TTL_MS && cache.at) return cache.html;
  let html = '';
  try { html = render(await groups(runner)); } catch (e) { html = ''; }
  cache = { at: now, html };
  return html;
}

module.exports = { linksHtml, groups, render, _reset: () => { cache = { at: 0, html: '' }; } };
