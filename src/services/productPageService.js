'use strict';

/**
 * productPageService — server-rendered, crawlable Professional Storefront item pages and their sitemap entries
 * (permanent roadmap §4.1 and §4.3; product data rules in src/lib/productData.js).
 *
 *   GET /shop/item/:id/:slug   the ONE canonical URL per item (the id is authoritative; the slug follows the title)
 *   GET /shop/item/:id         → 301 to the canonical URL
 *   GET /item.html?id=:id      → 301 to the canonical URL (old links keep working)
 *
 * Visibility is the same as the public item API (marketplaceItemService.getPublicItem): Professional Sellers only,
 * statuses active / pending_purchase / sold; draft, removed, taken-down and non-Professional items are 404 + noindex.
 * Demo items render but are noindex and never listed in the sitemap. Every public field comes from the allow-list
 * (publicItem): no seller ids, addresses, buyer or order data. Prices are the item price only (no buyer's premium).
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const productData = require('../lib/productData');
const { publicItem } = require('./marketplaceItemService');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');

const PUBLIC_STATUSES = ['active', 'pending_purchase', 'sold'];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const money = (c) => '$' + (Math.max(0, parseInt(c, 10) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let _tpl = null;
function template() {
  if (_tpl == null) { try { _tpl = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'item.html'), 'utf8'); } catch (e) { _tpl = ''; } }
  return _tpl;
}

// The public item plus what the page needs internally (seller id for "more from this seller", demo flag).
async function loadItem(id, runner = db) {
  if (!productData.UUID_RE.test(String(id || ''))) return null;
  const row = (await runner.query(
    `SELECT mi.*, sp.storefront_slug, sp.seller_type, sp.show_branding_to_buyers, sp.is_demo AS seller_is_demo,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name,
            (SELECT array_agg(v.kind) FROM seller_policy_versions v WHERE v.seller_id = mi.seller_id AND v.status = 'published') AS published_policy_kinds
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.id = $1 AND mi.status = ANY($2::text[]) AND mi.moderation_status = 'none' AND sp.seller_type = ANY($3::text[])`,
    [id, PUBLIC_STATUSES, PROFESSIONAL_SELLER_TYPES])).rows[0];
  if (!row) return null;
  return { item: publicItem(row), sellerId: row.seller_id, demo: !!(row.is_demo || row.seller_is_demo) };
}

async function moreFromSeller(sellerId, excludeId, limit = 6, runner = db) {
  const { rows } = await runner.query(
    `SELECT mi.id, mi.title, mi.price_cents, mi.thumbnail_url, mi.images, mi.image_alt
       FROM marketplace_items mi WHERE mi.seller_id = $1 AND mi.status = 'active' AND mi.id <> $2
      ORDER BY mi.updated_at DESC LIMIT $3`, [sellerId, excludeId, limit]);
  return rows;
}

function headHtml(item, base, { noindex }) {
  const url = productData.canonicalUrl(base, item);
  const title = `${item.title}${item.seller_name ? ' | ' + item.seller_name : ''} | Advantage.Bid`;
  const desc = productData.metaDescription(item);
  const img = productData.imagesOf(item)[0];
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    noindex ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index,follow">',
    '<meta property="og:type" content="product">',
    `<meta property="og:title" content="${esc(item.title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    img ? `<meta property="og:image" content="${esc(img)}">` : '',
    `<meta property="product:price:amount" content="${esc(productData.priceString(item.price_cents))}">`,
    '<meta property="product:price:currency" content="USD">',
    '<meta name="twitter:card" content="summary_large_image">',
  ].filter(Boolean).join('\n  ');
}

const AVAIL_TEXT = { active: 'Available', pending_purchase: 'Sale in progress', sold: 'Sold' };

// The page content crawlers (and visitors before scripts run) see. The browser script re-renders the same item.
function bodyHtml(item) {
  const imgs = productData.imagesOf(item);
  const alts = productData.altTexts(item);
  const seller = item.seller_name ? (item.storefront_slug ? `<a href="/pro/${esc(item.storefront_slug)}">${esc(item.seller_name)}</a>` : esc(item.seller_name)) : '';
  const place = [item.city, item.state].filter(Boolean).join(', ');
  const sh = item.shipping || { summary: 'Local pickup available' };
  const pills = [item.condition ? esc(item.condition) : '', item.era_or_period ? esc(item.era_or_period) : '', sh.shipping ? 'Shipping available' : 'Local pickup',
    sh.oversized ? 'Oversized item' : '', sh.fragile ? 'Fragile' : '']
    .filter(Boolean).map((t) => `<span class="pill">${t}</span>`).join('');
  const facts = [['Brand', item.brand], ['Maker', item.manufacturer], ['Material', item.material], ['Model or part number', item.mpn]]
    .filter(([, v]) => v).map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join('');
  return `<nav class="crumb" aria-label="Breadcrumb"><a href="/">Advantage.Bid</a> › ${seller ? seller + ' › ' : ''}<span>${esc(item.title)}</span></nav>
<div class="grid"><div class="gallery">${imgs.map((u, i) => `<img src="${esc(u)}" alt="${esc(alts[i])}"${i === 0 ? ' id="main"' : ' width="72" height="72" loading="lazy"'}>`).join('')}</div>
<div><h1>${esc(item.title)}</h1>${seller ? `<div class="meta">Sold by ${seller}</div>` : ''}
<div class="price">${money(item.price_cents)}</div>
<div class="meta">${esc(AVAIL_TEXT[item.status] || '')}</div>
<div style="margin:8px 0">${pills}</div>${place ? `<div class="meta">${esc(place)}</div>` : ''}
<div class="meta" id="ship-summary"><b>Shipping &amp; pickup:</b> ${esc(sh.summary)}${sh.notes ? ' — ' + esc(sh.notes) : ''}</div>
${item.description ? `<div class="desc">${esc(item.description)}</div>` : ''}${facts ? `<ul class="meta">${facts}</ul>` : ''}${policyLinks(item)}</div></div>`;
}

// Links to THIS item's seller's own published policies (only when the seller is shown and has published them).
function policyLinks(item) {
  const p = item.policies || {};
  if (!item.storefront_slug || (!p.store_terms && !p.shipping_pickup)) return '';
  const a = [];
  if (p.store_terms) a.push(`<a href="/pro/${esc(item.storefront_slug)}/terms">Store Terms &amp; Conditions</a>`);
  if (p.shipping_pickup) a.push(`<a href="/pro/${esc(item.storefront_slug)}/shipping-pickup">Shipping &amp; Pickup Policy</a>`);
  return `<p class="meta" id="seller-policies">${esc(item.seller_name || 'Seller')}: ${a.join(' · ')}</p>`;
}

function moreHtml(item, more) {
  if (!more.length || !item.seller_name) return '';
  const cards = more.map((m) => {
    const img = productData.imagesOf(m)[0];
    return `<a class="more-card" href="${esc(productData.canonicalPath(m))}">${img ? `<img src="${esc(img)}" alt="${esc(productData.altTexts(m)[0])}" loading="lazy">` : ''}<span>${esc(m.title)}</span><b>${money(m.price_cents)}</b></a>`;
  }).join('');
  const all = item.storefront_slug ? ` <a href="/pro/${esc(item.storefront_slug)}">See all items</a>` : '';
  return `<section class="wrap more" aria-label="More from this seller"><h2>More from ${esc(item.seller_name)}</h2><div class="more-grid">${cards}</div><p class="meta">${all}</p></section>`;
}

/**
 * Render the canonical item page. Returns { status, redirect?, html? }.
 *   redirect  — 301 target when the URL is not the canonical one
 *   status 404 — not public (the shell is served with noindex; the browser shows "not available")
 */
// A non-public item: the shell with noindex (the browser shows "not available").
function notFoundPage() {
  const tpl = template();
  return { status: 404, html: tpl ? tpl.replace('<!-- SSR-META -->', '<meta name="robots" content="noindex">') : 'Not found' };
}

async function render(id, slug, base, runner = db) {
  const tpl = template();
  const notFound = notFoundPage;
  const found = await loadItem(id, runner);
  if (!found) return notFound();
  const { item, sellerId, demo } = found;
  const canonicalPath = productData.canonicalPath(item);
  if (slug !== productData.slugify(item.title)) return { status: 301, redirect: canonicalPath };
  if (!tpl) return { status: 200, html: null };
  const more = await moreFromSeller(sellerId, item.id, 6, runner);
  // Function replacements: seller text is inserted literally ("$'" or "$&" in a title never acts as a pattern).
  const head = headHtml(item, base, { noindex: demo });
  const json = ld(productData.productJsonLd(item, base)) + ld(productData.breadcrumbJsonLd(item, base));
  const body = bodyHtml(item); const moreBlock = moreHtml(item, more);
  const html = tpl
    .replace(/<title>[\s\S]*?<\/title>/i, () => '')
    .replace('<!-- SSR-META -->', () => head)
    .replace('<!-- SSR-JSONLD -->', () => json)
    .replace(/<!-- SSR-BODY:START -->[\s\S]*?<!-- SSR-BODY:END -->/, () => body)
    .replace('<!-- SSR-MORE -->', () => moreBlock);
  return { status: 200, html };
}

// Canonical path for an id (for the legacy /item.html?id= redirect). Null when the item is not public.
async function canonicalPathFor(id, runner = db) {
  const found = await loadItem(id, runner);
  return found ? productData.canonicalPath(found.item) : null;
}

/**
 * Sitemap entries: items that are live for sale (active, or held in a checkout) from Professional Sellers, not demo,
 * not taken down; and published, non-demo Professional storefronts. Sold items stay reachable (marked sold) but are
 * not listed. FAIL-SAFE: returns empty lists on error.
 */
async function sitemapEntries(runner = db) {
  const out = { items: [], storefronts: [], policies: [] };
  try {
    out.items = (await runner.query(
      `SELECT mi.id, mi.title, COALESCE(mi.updated_at, mi.created_at) AS lastmod
         FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
        WHERE mi.status IN ('active','pending_purchase') AND mi.moderation_status = 'none'
          AND mi.is_demo = false AND COALESCE(sp.is_demo, false) = false AND sp.seller_type = ANY($1::text[])
        ORDER BY COALESCE(mi.updated_at, mi.created_at) DESC LIMIT 5000`, [PROFESSIONAL_SELLER_TYPES])).rows
      .map((r) => ({ path: productData.canonicalPath(r), lastmod: r.lastmod }));
  } catch (e) { /* leave empty */ }
  try {
    out.storefronts = (await runner.query(
      `SELECT storefront_slug FROM seller_profiles
        WHERE storefront_published = true AND storefront_slug IS NOT NULL AND COALESCE(is_demo, false) = false AND seller_type = ANY($1::text[])
        ORDER BY storefront_slug LIMIT 2000`, [PROFESSIONAL_SELLER_TYPES])).rows
      .map((r) => ({ path: '/pro/' + r.storefront_slug, lastmod: null }));
  } catch (e) { /* leave empty */ }
  try {
    out.policies = (await runner.query(
      `SELECT sp.storefront_slug, v.kind, v.published_at AS lastmod FROM seller_policy_versions v JOIN seller_profiles sp ON sp.id = v.seller_id
        WHERE v.status = 'published' AND sp.storefront_published = true AND sp.storefront_slug IS NOT NULL AND COALESCE(sp.is_demo, false) = false
          AND sp.seller_type = ANY($1::text[]) ORDER BY sp.storefront_slug, v.kind LIMIT 4000`, [PROFESSIONAL_SELLER_TYPES])).rows
      .map((r) => ({ path: `/pro/${r.storefront_slug}/${r.kind === 'store_terms' ? 'terms' : 'shipping-pickup'}`, lastmod: r.lastmod }));
  } catch (e) { out.policies = []; }
  return out;
}

module.exports = { render, notFoundPage, canonicalPathFor, sitemapEntries, loadItem, _resetTemplate: () => { _tpl = null; } };
