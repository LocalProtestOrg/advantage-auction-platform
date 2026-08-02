'use strict';

/**
 * analyticsTag — single-point GA4 (gtag.js) injection for every HTML page this
 * app serves. Modelled on src/middleware/shareMeta.js: head-only and FAIL-OPEN.
 *
 * WHY TWO MOUNTS
 * --------------
 * HTML leaves this app by two different routes and they need different handling:
 *
 *   1. Server-rendered responses — shareMeta (/auction-view.html, /lot.html,
 *      /event.html) and the /items SSR page. These call res.send() with an HTML
 *      string and never reach express.static.
 *   2. Plain static files — the other ~47 pages under public/, streamed by
 *      express.static, which never calls res.send().
 *
 * So `patch` is mounted BEFORE shareMeta (it wraps res.send and injects into
 * whatever HTML any later handler sends), and `serve` is mounted immediately
 * BEFORE express.static (it injects into the file for anything that got that far
 * untagged). One file, one behaviour, two entry points.
 *
 * Mounting `patch` before shareMeta is what keeps per-entity OG/Twitter/JSON-LD
 * meta intact: shareMeta still builds and sends the response exactly as it does
 * today, and the tag is added to its output on the way out. shareMeta itself is
 * not modified.
 *
 * GUARANTEES
 * ----------
 *   • FAIL-OPEN — every path is wrapped in try/catch. On ANY error the original
 *     response is sent, or next() is called, untagged. Never throws, never 500s.
 *   • IDEMPOTENT — if the document already contains the measurement ID, nothing
 *     is injected. Double injection is structurally impossible.
 *   • KILL SWITCH — ANALYTICS_TAG_ENABLED must be exactly 'true'. Anything else
 *     is a no-op, effective on the next request, with no redeploy.
 *   • HEAD-ONLY — one block inserted immediately after <head>. The rest of the
 *     document is passed through byte for byte.
 *
 * CONFIG (environment only — never hard-code an ID):
 *   ANALYTICS_TAG_ENABLED = 'true' | anything else
 *   GA4_MEASUREMENT_ID    = e.g. 'G-XXXXXXXXXX'   (malformed => treated as absent)
 *
 * EXCLUSIONS — see docs/analytics/AAC_ANALYTICS.md §9.6:
 *   /widgets/*    iframed into Brilliant Directories pages. Tagging them would
 *                 double-count every BD pageview and create self-referrals.
 *   /admin/*      admin surfaces stay out of marketing analytics.
 *   /org/*        organiser admin surfaces.
 *   /prototype/*  non-production.
 *   /demo.html    non-production.
 *
 * These mirror public/robots.txt. Two deliberate exceptions: /login.html and
 * /become-seller.html are Disallow'd for SEO but are essential funnel steps, so
 * they ARE tagged.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const EXCLUDED_PREFIXES = ['/widgets/', '/admin/', '/org/', '/prototype/'];
const EXCLUDED_EXACT = ['/demo.html'];

function isEnabled() {
  return String(process.env.ANALYTICS_TAG_ENABLED || '').toLowerCase() === 'true';
}

function measurementId() {
  const raw = String(process.env.GA4_MEASUREMENT_ID || '').trim();
  return /^G-[A-Z0-9]{6,}$/i.test(raw) ? raw : null;
}

function isExcluded(pathname) {
  if (EXCLUDED_EXACT.indexOf(pathname) !== -1) return true;
  for (let i = 0; i < EXCLUDED_PREFIXES.length; i++) {
    if (pathname.indexOf(EXCLUDED_PREFIXES[i]) === 0) return true;
  }
  return false;
}

// Map a request path to the .html file express.static would serve, or null.
function htmlFileFor(pathname) {
  if (pathname === '/') return 'index.html';
  if (/\.html$/i.test(pathname)) return pathname.replace(/^\/+/, '');
  return null;
}

// Reject anything that tries to escape public/.
function safeResolve(rel) {
  const full = path.join(PUBLIC_DIR, rel);
  const root = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  return full.indexOf(root) === 0 ? full : null;
}

function tagBlock(id) {
  return '\n<!-- Google tag (gtag.js) — injected by src/middleware/analyticsTag.js -->\n'
    + '<script async src="https://www.googletagmanager.com/gtag/js?id=' + id + '"></script>\n'
    + '<script>\n'
    + '  window.dataLayer = window.dataLayer || [];\n'
    + '  function gtag(){dataLayer.push(arguments);}\n'
    + '  gtag(\'js\', new Date());\n'
    + '  gtag(\'config\', \'' + id + '\');\n'
    + '</script>\n';
}

/**
 * inject(html, id) — returns the tagged document, or null when it should be left
 * alone (already tagged, no <head>, not a string).
 */
function inject(html, id) {
  if (typeof html !== 'string' || !html) return null;
  if (html.indexOf(id) !== -1) return null;               // idempotency guard
  const headOpen = html.search(/<head[^>]*>/i);
  if (headOpen === -1) return null;
  const at = html.indexOf('>', headOpen) + 1;
  if (at <= 0) return null;
  return html.slice(0, at) + tagBlock(id) + html.slice(at);
}

// Template cache — read once per file, mirroring shareMeta's approach. A read
// failure caches null so a missing file is never retried on every request.
const CACHE = new Map();

function readTemplate(fullPath) {
  if (CACHE.has(fullPath)) return CACHE.get(fullPath);
  let html = null;
  try { html = fs.readFileSync(fullPath, 'utf8'); } catch (e) { html = null; }
  CACHE.set(fullPath, html);
  return html;
}

// Shared preconditions for both mounts.
function activeIdFor(req) {
  if (!isEnabled()) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const id = measurementId();
  if (!id) return null;
  if (isExcluded(req.path || '/')) return null;
  return id;
}

/**
 * patch — mount BEFORE shareMeta. Wraps res.send so any HTML sent by a later
 * handler (shareMeta, /items) is tagged on the way out. Never responds itself.
 */
function patch(req, res, next) {
  try {
    const id = activeIdFor(req);
    if (!id) return next();

    const originalSend = res.send.bind(res);
    res.send = function (body) {
      try {
        const ct = String(res.get('Content-Type') || '');
        const looksHtml = typeof body === 'string'
          && (ct.indexOf('html') !== -1 || /^\s*<(?:!doctype|html)/i.test(body));
        if (looksHtml) {
          const out = inject(body, id);
          if (out) return originalSend(out);
        }
      } catch (e) { /* fall through to the original body */ }
      return originalSend(body);
    };
  } catch (e) { /* fail open */ }
  return next();
}

/**
 * serve — mount immediately BEFORE express.static. Injects into the static file
 * for any HTML page that reached this point untagged. Falls through on anything
 * it cannot handle, so express.static still serves the file.
 */
function serve(req, res, next) {
  try {
    const id = activeIdFor(req);
    if (!id) return next();

    const rel = htmlFileFor(req.path || '/');
    if (!rel) return next();

    const full = safeResolve(rel);
    if (!full) return next();

    const html = readTemplate(full);
    if (!html) return next();

    const out = inject(html, id);
    if (!out) return next();

    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(out);
  } catch (e) {
    return next();
  }
}

module.exports = { patch, serve };
module.exports._internal = { isExcluded, htmlFileFor, measurementId, isEnabled, inject, tagBlock, CACHE };
