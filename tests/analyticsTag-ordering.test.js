'use strict';

// Mount-ordering invariants for the analyticsTag integration in server.js.
//
// The analyticsTag module itself is exhaustively unit-tested in analyticsTag.test.js
// (injection, exclusions, idempotency, fail-open, kill switch). What THIS file locks is
// the security-critical WIRING order in server.js, per docs/analytics/ANALYTICS_INTEGRATION_SPEC.md §3.
// The single most important invariant: analyticsTag.serve must be mounted AFTER htmlAuthGate,
// or it would read a private HTML file off disk and 200 it to an unauthenticated visitor,
// bypassing the auth gate for every private page. A source-analysis test (same pattern as
// www-bid-redirect.test.js) keeps this from silently regressing on any future server.js edit.

const fs = require('fs');
const src = fs.readFileSync('server.js', 'utf8');

// Index of the first occurrence of a marker, or -1. Kept tolerant of single/double quotes.
function idx(re) { const m = src.match(re); return m ? m.index : -1; }

const canonicalHost = idx(/require\((['"])\.\/src\/middleware\/canonicalHost\1\)/);
const cors          = idx(/Access-Control-Allow-Origin/);
const mountPatch    = idx(/require\((['"])\.\/src\/middleware\/analyticsTag\1\)\.patch/);
const shareMeta     = idx(/require\((['"])\.\/src\/middleware\/shareMeta\1\)/);
const htmlAuthGate  = idx(/require\((['"])\.\/src\/middleware\/htmlAuthGate\1\)/);
const mountServe    = idx(/require\((['"])\.\/src\/middleware\/analyticsTag\1\)\.serve/);
const staticMount   = idx(/express\.static\(/);
const firstApi      = idx(/app\.use\((['"])\/api\//);
const jsonParser    = idx(/express\.json\(/);

describe('analyticsTag mount ordering in server.js', () => {
  test('all anchors are present', () => {
    for (const [name, i] of Object.entries({
      canonicalHost, cors, mountPatch, shareMeta, htmlAuthGate, mountServe, staticMount, firstApi, jsonParser,
    })) {
      expect(name && i).toBeGreaterThan(-1);
    }
  });

  test('Mount A (patch) is after canonicalHost and CORS, and before shareMeta', () => {
    expect(mountPatch).toBeGreaterThan(canonicalHost);
    expect(mountPatch).toBeGreaterThan(cors);
    expect(mountPatch).toBeLessThan(shareMeta);
  });

  test('SECURITY: Mount B (serve) is mounted AFTER htmlAuthGate', () => {
    expect(mountServe).toBeGreaterThan(htmlAuthGate);
  });

  test('Mount B (serve) is immediately before express.static — nothing mounts between them', () => {
    expect(mountServe).toBeLessThan(staticMount);
    // Slice from the serve mount up to (not including) express.static. The only middleware
    // registration in that span must be the serve mount itself — no gate, route, or parser
    // may slip between the gate-protected serve and the file server.
    const between = src.slice(mountServe, staticMount);
    expect((between.match(/app\.use\(/g) || []).length).toBe(1);
    expect(between).not.toMatch(/app\.(get|post|put|delete|all)\(/);
  });

  test('both mounts run before the JSON body parser and every /api/* mount', () => {
    expect(mountPatch).toBeLessThan(jsonParser);
    expect(mountServe).toBeLessThan(jsonParser);
    expect(mountPatch).toBeLessThan(firstApi);
    expect(mountServe).toBeLessThan(firstApi);
  });

  test('/how-it-works is served via res.send so Mount A tags it (not res.sendFile, which streams past)', () => {
    const routeStart = src.indexOf("app.get('/how-it-works',");
    const routeEnd = src.indexOf("app.get('/how-it-works.html'");
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const route = src.slice(routeStart, routeEnd);
    expect(route).toMatch(/res\.type\('html'\)\.send\(/);     // primary path is res.send → patchable
    expect(route).toMatch(/catch[\s\S]*res\.sendFile/);       // sendFile kept only as fail-safe fallback
    expect(routeStart).toBeGreaterThan(mountPatch);           // route runs after Mount A → wrapper active
    // the 301 from the .html form to the canonical extensionless URL is preserved
    expect(src).toMatch(/app\.get\('\/how-it-works\.html',[\s\S]{0,80}redirect\(301, '\/how-it-works'\)/);
  });
});
