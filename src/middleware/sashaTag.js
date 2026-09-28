'use strict';

/**
 * sashaTag — adds the Sasha help-button loader to bid.advantage.bid HTML pages (before </body>).
 *
 * One async script tag; the loader itself shows nothing unless chat is switched on for this site, and never on the
 * live bidding experience. It adds no metadata, structured data or visible markup to the HTML (no SEO effect).
 *
 * Two mounts, mirroring analyticsTag: `patch` wraps res.send (pages rendered by later handlers, including the
 * analytics tag's own response); `serve` injects into plain static pages just before express.static.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const TAG = '\n<script src="/widgets/sasha-loader.js" async></script>\n';
const MARKER = 'sasha-loader.js';

// No help button: embeds/widgets, admin/staff tools, token pages, the live bidding experience and card payment.
const EXCLUDED_PREFIXES = ['/widgets/', '/embed/', '/admin/', '/org/', '/prototype/', '/claim/'];
const EXCLUDED_EXACT = ['/demo.html', '/claim-listing.html', '/lot.html', '/auction-view.html', '/payment.html'];

function isExcluded(p) {
  if (EXCLUDED_EXACT.includes(p)) return true;
  return EXCLUDED_PREFIXES.some((x) => p.indexOf(x) === 0);
}
function htmlFileFor(p) {
  if (p === '/') return 'index.html';
  if (/\.html$/i.test(p)) return p.replace(/^\/+/, '');
  return null;
}
function inject(html) {
  if (typeof html !== 'string' || !html || html.indexOf(MARKER) !== -1) return null;
  const at = html.search(/<\/body>/i);
  if (at === -1) return null;
  return html.slice(0, at) + TAG + html.slice(at);
}
const active = (req) => (req.method === 'GET' || req.method === 'HEAD') && !isExcluded(req.path || '/');

function patch(req, res, next) {
  try {
    if (!active(req)) return next();
    const original = res.send.bind(res);
    res.send = function (body) {
      try {
        const ct = String(res.get('Content-Type') || '');
        if (typeof body === 'string' && (ct.includes('html') || /^\s*<(?:!doctype|html)/i.test(body))) {
          const out = inject(body);
          if (out) return original(out);
        }
      } catch (_e) { /* fall through */ }
      return original(body);
    };
  } catch (_e) { /* fail open */ }
  return next();
}

const CACHE = new Map();
function serve(req, res, next) {
  try {
    if (!active(req)) return next();
    const rel = htmlFileFor(req.path || '/');
    if (!rel) return next();
    const full = path.join(PUBLIC_DIR, rel);
    const root = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
    if (full.indexOf(root) !== 0) return next();
    let html = CACHE.get(full);
    if (html === undefined) { try { html = fs.readFileSync(full, 'utf8'); } catch (_e) { html = null; } CACHE.set(full, html); }
    const out = inject(html);
    if (!out) return next();
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(out);
  } catch (_e) { return next(); }
}

module.exports = { patch, serve, _internal: { isExcluded, inject, EXCLUDED_EXACT } };
