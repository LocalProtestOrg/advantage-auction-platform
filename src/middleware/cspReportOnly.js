'use strict';

/**
 * Content Security Policy — REPORT-ONLY (owner-approved 2026-10-15; enforcement only after legitimate functionality
 * has been tested and the reported violations reviewed).
 *
 * Sends Content-Security-Policy-Report-Only on every response. Browsers never block anything because of this header;
 * they only POST a report to /api/csp-report when something on a page would have been blocked. The enforced
 * frame-ancestors header set by widgetFraming.js is a different header and is unchanged.
 *
 * The policy describes what the site legitimately loads today (own origin, Stripe, Google fonts/analytics, Meta pixel,
 * map tiles, the unpkg/jsDelivr libraries, images from any https host because imported listings carry their own image
 * hosts). 'unsafe-inline' remains for scripts and styles because the pages use inline blocks; removing it (nonces) is
 * the step after the review.
 *
 * Reports are summarised in the log, at most once per (directive, blocked host, page) per hour, with no query strings,
 * so they cannot flood the log or carry personal data. Kill switch: CSP_REPORT_ONLY=off.
 */

const POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://www.googletagmanager.com https://www.google-analytics.com https://connect.facebook.net https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' wss: https://api.stripe.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://www.facebook.com https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com",
  "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://www.google.com https://www.youtube.com https://player.vimeo.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'report-uri /api/csp-report',
].join('; ');

function enabled() { return String(process.env.CSP_REPORT_ONLY || '').toLowerCase() !== 'off'; }

function cspReportOnly(req, res, next) {
  if (enabled()) res.setHeader('Content-Security-Policy-Report-Only', POLICY);
  next();
}

// ── Report receiver ────────────────────────────────────────────────────────────────────────────────────────────
const seen = new Map(); // key -> last logged ms
const WINDOW_MS = 60 * 60 * 1000;
const MAX_KEYS = 2000;
let counts = { received: 0, logged: 0, since: new Date().toISOString() };

function hostOf(u) {
  const s = String(u || '');
  if (!s || /^(inline|eval|data|blob|self|wasm-eval|trusted-types-sink)$/i.test(s)) return s || 'unknown';
  try { return new URL(s).host || s.split(':')[0]; } catch (_) { return s.slice(0, 40); }
}
function pathOf(u) { try { return new URL(String(u)).pathname.slice(0, 120); } catch (_) { return '-'; } }

/** Normalise the two report formats (report-uri: {"csp-report":{...}}; Reporting API: [{type,body}]). */
function normalise(body) {
  const list = Array.isArray(body) ? body.map((r) => r && r.body).filter(Boolean) : [body && (body['csp-report'] || body)].filter(Boolean);
  return list.map((r) => ({
    directive: String(r['effective-directive'] || r.effectiveDirective || r['violated-directive'] || r.violatedDirective || 'unknown').split(' ')[0].slice(0, 40),
    blocked: hostOf(r['blocked-uri'] || r.blockedURL || r.blockedUri),
    page: pathOf(r['document-uri'] || r.documentURL || r.documentUri),
  }));
}

function receiveReport(req, res) {
  try {
    for (const v of normalise(req.body)) {
      counts.received++;
      const key = v.directive + '|' + v.blocked + '|' + v.page;
      const last = seen.get(key);
      if (last && Date.now() - last < WINDOW_MS) continue;
      if (seen.size >= MAX_KEYS) seen.clear();
      seen.set(key, Date.now());
      counts.logged++;
      console.warn('[csp-report-only] would block', JSON.stringify(v));
    }
  } catch (_) { /* a malformed report is ignored */ }
  res.status(204).end();
}

// Body parser for reports (both browser formats; anything else is ignored rather than refused).
const reportParser = require('express').json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb', strict: false });

function _reset() { seen.clear(); counts = { received: 0, logged: 0, since: new Date().toISOString() }; }

module.exports = { cspReportOnly, receiveReport, reportParser, POLICY, normalise, stats: () => ({ ...counts, distinct: seen.size }), _reset };
