'use strict';

/**
 * shareMeta middleware — server-side per-entity share-meta injection.
 *
 * Runs BEFORE express.static on EVERY request, so it is the highest-risk item in
 * this codebase. It is engineered to be fast, head-only, and FAIL-OPEN:
 *
 *   • FAST bail: only GET requests to /auction-view.html or /lot.html are ever
 *     considered; everything else falls straight through to next().
 *   • Head-only: it splits the cached HTML at the FIRST </head> and only ever
 *     rewrites the <head>. Everything from </head> onward (the entire body, all
 *     scripts, layout) is passed through byte-for-byte untouched.
 *   • FAIL-OPEN: the whole body is wrapped in try/catch. On ANY error — bad
 *     template, DB hiccup, unexpected shape — it calls next() so the static file
 *     still serves. It never throws, never 500s.
 *
 * INJECTION METHOD: strip-and-inject.
 *   Phase 1 already added STATIC fallback title/description/canonical/OG/Twitter
 *   tags. When we find an entity we (a) strip exactly those Phase-1 tags from the
 *   <head> by attribute name (not by value, so it is robust to copy drift) and
 *   (b) inject one fresh entity-specific block just before </head>. Non-targeted
 *   head tags (charset, viewport, og:type, og:site_name, og:image:width/height,
 *   twitter:card, fonts, styles) are left in place. When NO entity is found we do
 *   nothing and Phase 1's static fallback serves unchanged.
 */

const fs = require('fs');
const path = require('path');
const { publicBaseUrl } = require('../lib/publicUrls');
const shareMetaService = require('../services/shareMetaService');

// Which pages we handle, how to read the id, and which service reader to use.
const PAGES = {
  '/auction-view.html': { kind: 'auction', idParams: ['auctionId', 'id'] },
  '/lot.html':          { kind: 'lot',     idParams: ['lotId', 'id'] },
};

// Read + cache the base HTML for each page ONCE at module load. If a read fails,
// we store null and the middleware fails open for that page (never touches it).
const TEMPLATES = {};
for (const p of Object.keys(PAGES)) {
  try {
    TEMPLATES[p] = fs.readFileSync(
      path.join(__dirname, '..', '..', 'public', p.replace(/^\//, '')),
      'utf8'
    );
  } catch (e) {
    TEMPLATES[p] = null;
  }
}

// HTML-escape every dynamic value injected into an attribute or text node, to
// prevent broken markup / attribute-breakout injection.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Resolve an entity image to an absolute https URL, falling back to the default
// social card. Absolute (http/https) images pass through unchanged.
function absoluteImage(img) {
  const b = publicBaseUrl().replace(/\/+$/, '');
  if (img && /^https?:\/\//i.test(img)) return img;
  if (img && img.charAt(0) === '/') return b + img;
  return b + '/img/social-card.png';
}

// Strip ONLY the Phase-1 static tags we intend to replace, matched by attribute
// name so it is robust to content changes. Operates on the <head> slice only.
function stripPhase1Tags(head) {
  return head
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name=["']description["'][^>]*>/i, '')
    .replace(/<link\s+rel=["']canonical["'][^>]*>/i, '')
    .replace(/<meta\s+property=["']og:title["'][^>]*>/i, '')
    .replace(/<meta\s+property=["']og:description["'][^>]*>/i, '')
    .replace(/<meta\s+property=["']og:url["'][^>]*>/i, '')
    .replace(/<meta\s+property=["']og:image["'][^>]*>/i, '')
    .replace(/<meta\s+name=["']twitter:title["'][^>]*>/i, '')
    .replace(/<meta\s+name=["']twitter:description["'][^>]*>/i, '')
    .replace(/<meta\s+name=["']twitter:image["'][^>]*>/i, '');
}

// Build the fresh entity-specific head block. `title` already includes the
// " | Advantage.Bid" suffix; all values are pre-escaped by the caller.
function buildBlock(title, description, url, image) {
  return [
    '<!-- share-meta: server-injected, entity-specific (Phase 2) -->',
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${image}" />`,
  ].join('\n  ');
}

// ── JSON-LD (Phase 3) ────────────────────────────────────────────────────────
// Build a plain JS object per entity, then JSON.stringify + escape. We NEVER
// hand-concatenate JSON. `<` is replaced with its unicode escape so a value
// containing "</script>" cannot break out of the <script> element.
function jsonLdScript(obj) {
  const json = JSON.stringify(obj).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

// Only keep own-enumerable properties whose value is not null/undefined/''.
function omitEmpty(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

// ISO string for a date-ish value, or null when absent/invalid.
function isoOrNull(v) {
  if (!v) return null;
  try {
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch (e) { return null; }
}

// Build the schema.org Event object for an auction. `url`/`image` are absolute.
function buildAuctionEvent(meta, url, image) {
  return omitEmpty({
    '@type': 'Event',
    name: meta.title || null,
    description: meta.description || null,
    url,
    image,
    startDate: isoOrNull(meta.startDate),
    endDate: isoOrNull(meta.endDate),
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    organizer: { '@type': 'Organization', name: meta.organizer || 'Advantage.Bid' },
    location: { '@type': 'VirtualLocation', url },
  });
}

// Build the schema.org Product object for a lot. Emits `offers` ONLY when a
// positive cent price is present (meta.priceCents). `url`/`image` are absolute.
function buildLotProduct(meta, url, image) {
  const product = omitEmpty({
    '@type': 'Product',
    name: meta.title || null,
    description: meta.description || null,
    image,
    url,
  });
  if (typeof meta.priceCents === 'number' && meta.priceCents > 0) {
    product.offers = {
      '@type': 'Offer',
      priceCurrency: 'USD',
      price: (meta.priceCents / 100).toFixed(2),
      availability: 'https://schema.org/InStock',
      url,
    };
  }
  return product;
}

// Build a BreadcrumbList. `items` is an ordered [{ name, url }] list; positions
// are assigned 1..N. Absolute urls expected.
function buildBreadcrumb(items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

// Assemble the full @graph JSON-LD script for the given entity kind + meta.
// Fail-open is handled by the caller; this may throw and be caught there.
function buildJsonLd(kind, meta, url, image) {
  const b = publicBaseUrl().replace(/\/+$/, '');
  const graph = [];
  const crumbs = [{ name: 'Home', url: b + '/' }];
  if (kind === 'auction') {
    graph.push(buildAuctionEvent(meta, url, image));
    crumbs.push({ name: meta.title || 'Auction', url });
  } else {
    graph.push(buildLotProduct(meta, url, image));
    if (meta.auctionId) {
      crumbs.push({
        name: meta.auctionTitle || 'Auction',
        url: `${b}/auction-view.html?auctionId=${encodeURIComponent(meta.auctionId)}`,
      });
    }
    crumbs.push({ name: meta.title || 'Lot', url });
  }
  graph.push(buildBreadcrumb(crumbs));
  return jsonLdScript({ '@context': 'https://schema.org', '@graph': graph });
}

module.exports = async function shareMeta(req, res, next) {
  try {
    // FAST bail — only GET on the two entity pages.
    if (req.method !== 'GET') return next();
    const page = PAGES[req.path];
    if (!page) return next();

    const template = TEMPLATES[req.path];
    if (!template) return next();

    // Extract the entity id from the query string.
    let id = null;
    for (const key of page.idParams) {
      const v = req.query && req.query[key];
      if (v) { id = String(v); break; }
    }
    if (!id) return next();

    // Load meta (visibility-gated, fail-open). null → Phase-1 static serves.
    const meta = page.kind === 'auction'
      ? await shareMetaService.getAuctionMeta(id)
      : await shareMetaService.getLotMeta(id);
    if (!meta) return next();

    // Split at the FIRST </head>; never touch anything from </head> onward.
    const idx = template.indexOf('</head>');
    if (idx === -1) return next();
    const head = template.slice(0, idx);
    const rest = template.slice(idx); // '</head>' + body, passed through verbatim

    const title       = escapeHtml(meta.title) + ' | Advantage.Bid';
    const description = escapeHtml(meta.description);
    const url         = escapeHtml(meta.url);
    const image       = escapeHtml(absoluteImage(meta.image));

    const cleanedHead = stripPhase1Tags(head);

    // Phase 3 — entity JSON-LD. Built from RAW (unescaped) absolute values;
    // JSON.stringify handles escaping and jsonLdScript neutralizes </script>.
    // Fully fail-open: if building throws we skip only the JSON-LD.
    let jsonLd = '';
    try {
      jsonLd = '\n  ' + buildJsonLd(page.kind, meta, meta.url, absoluteImage(meta.image));
    } catch (e) {
      jsonLd = '';
    }

    const block = '  ' + buildBlock(title, description, url, image) + jsonLd + '\n';
    const html = cleanedHead + block + rest;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(html);
  } catch (e) {
    // FAIL-OPEN: any error → let the static file serve.
    return next();
  }
};

// Exported for unit tests only (not used by the request path).
module.exports.escapeHtml = escapeHtml;
module.exports.absoluteImage = absoluteImage;
module.exports.stripPhase1Tags = stripPhase1Tags;
module.exports.buildBlock = buildBlock;
module.exports.buildJsonLd = buildJsonLd;
module.exports.buildAuctionEvent = buildAuctionEvent;
module.exports.buildLotProduct = buildLotProduct;
module.exports.buildBreadcrumb = buildBreadcrumb;
module.exports.jsonLdScript = jsonLdScript;
