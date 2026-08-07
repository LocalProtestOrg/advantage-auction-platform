'use strict';

/**
 * Launch fix H-5 — remove the broken /all-auctions.html CTA + branded HTML 404 (JSON for API).
 * Behavioral tests of the 404 handler (mock req/res) + source assertions for the CTA fix + mount order.
 */

const fs = require('fs');
const path = require('path');
const { notFoundHtml, notFoundHandler } = require('../../src/middleware/notFound');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

// Minimal chainable Express res double.
function mockRes() {
  const r = { statusCode: 0, body: null, headers: {}, jsonCalled: false, sendCalled: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; r.jsonCalled = true; return r; };
  r.set = (k, v) => { if (typeof k === 'object') Object.assign(r.headers, k); else r.headers[k] = v; return r; };
  r.send = (s) => { r.body = s; r.sendCalled = true; return r; };
  return r;
}
// req.accepts('html') truthy iff the client accepts html.
const req = (p, acceptsHtml) => ({ path: p, accepts: (t) => (t === 'html' && acceptsHtml ? 'html' : false) });

describe('H-5 (A) — the broken /all-auctions.html CTA is replaced with an approved route', () => {
  test('server.js no longer emits a Railway /all-auctions.html link', () => {
    expect(serverSrc).not.toMatch(/\/all-auctions\.html/);
  });
  test('the /items CTAs point at the approved active-auctions discovery route', () => {
    const matches = serverSrc.match(/\/search\.html\?mode=auctions&amp;status=active/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);   // empty-state + error-fallback CTAs
  });
});

describe('H-5 (B) — branded HTML 404 for browser requests, JSON for API', () => {
  test('browser page request → 404 + branded HTML with usable navigation (design system, noindex)', () => {
    const res = mockRes();
    notFoundHandler(req('/does-not-exist', true), res);
    expect(res.statusCode).toBe(404);
    expect(res.sendCalled).toBe(true);
    expect(res.jsonCalled).toBe(false);
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    // branded + design system + usable nav back to home and search
    expect(res.body).toMatch(/class="ob-body"/);
    expect(res.body).toMatch(/widgets\/shared\/onboarding\.css/);
    expect(res.body).toMatch(/class="ob-cta"[^>]*href="\/"/);
    expect(res.body).toMatch(/href="\/search\.html"/);
    expect(res.body).toMatch(/robots"[^>]*noindex/);
    expect(res.body).toMatch(/Advantage\.Bid/);
  });

  test('unknown /api/... route → 404 + JSON (contract unchanged)', () => {
    const res = mockRes();
    notFoundHandler(req('/api/does-not-exist', true), res);   // even with Accept: text/html, /api stays JSON
    expect(res.statusCode).toBe(404);
    expect(res.jsonCalled).toBe(true);
    expect(res.sendCalled).toBe(false);
    expect(res.body).toEqual({ error: 'Route not found' });
  });

  test('non-HTML client (e.g. fetch Accept: application/json) → 404 + JSON', () => {
    const res = mockRes();
    notFoundHandler(req('/whatever', false), res);
    expect(res.statusCode).toBe(404);
    expect(res.jsonCalled).toBe(true);
    expect(res.body).toEqual({ error: 'Route not found' });
  });

  test('notFoundHtml is self-contained + links only to existing destinations', () => {
    const html = notFoundHtml();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/href="\/"/);
    expect(html).toMatch(/href="\/search\.html"/);
    expect(html).not.toMatch(/all-auctions/);
  });
});

describe('H-5 (C) — existing valid public routes remain unaffected', () => {
  test('the 404 handler is mounted LAST (after static + routes), so it only fires on unmatched paths', () => {
    const staticIdx = serverSrc.indexOf('express.static');
    const notFoundIdx = serverSrc.indexOf("require('./src/middleware/notFound').notFoundHandler");
    expect(staticIdx).toBeGreaterThan(-1);
    expect(notFoundIdx).toBeGreaterThan(staticIdx);   // catch-all comes after static file serving
  });
});
