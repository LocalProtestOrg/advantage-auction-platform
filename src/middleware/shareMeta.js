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
    const block = '  ' + buildBlock(title, description, url, image) + '\n';
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
