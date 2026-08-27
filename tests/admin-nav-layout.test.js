'use strict';

/**
 * Admin header / content layout regression (Owner Acceptance: Sales & Marketing overlap).
 *
 * Root cause: the shared admin header is `position: sticky` (in normal flow) so page CONTENT is offset
 * automatically — but the Sales prospect DRAWER was `position: fixed; top: 0`, so its top sat under the
 * header. Fix: admin-nav.js publishes the measured header height as `--admin-nav-h` (robust to multi-line
 * wrapping), and fixed/absolute overlays offset by it. These source-level checks guard the fix.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const NAV = read('public/widgets/shared/admin-nav.js');
const SALES = read('public/admin/sales.html');

describe('shared admin header stays in normal document flow', () => {
  test('header is position: sticky (so content receives an automatic top offset, never hidden at rest)', () => {
    expect(NAV).toMatch(/#admin-nav\{position:sticky;top:0/);
  });
  test('admin-nav.js still parses cleanly', () => {
    expect(() => new vm.Script(NAV)).not.toThrow();
  });
});

describe('measured header height is published for out-of-flow overlays', () => {
  test('publishes --admin-nav-h from the ACTUAL rendered height (not a hardcoded guess)', () => {
    expect(NAV).toMatch(/setProperty\('--admin-nav-h'/);
    expect(NAV).toMatch(/getBoundingClientRect\(\)\.height/);
  });
  test('keeps it in sync on wrap/resize (ResizeObserver + resize) and after links populate', () => {
    expect(NAV).toMatch(/ResizeObserver/);
    expect(NAV).toMatch(/addEventListener\('resize'/);
    // renderLinks (which changes the height when links appear) republishes the measurement
    expect(NAV).toMatch(/setNavHeightVar\(header\); \/\/ links\/badge just changed the height/);
  });
});

describe('Sales prospect drawer respects the admin header', () => {
  test('drawer starts BELOW the header (top) and fits the remaining height, offset by the measured var', () => {
    expect(SALES).toMatch(/#drawer\{position:fixed;top:var\(--admin-nav-h,0px\)/);
    expect(SALES).toMatch(/height:calc\(100% - var\(--admin-nav-h,0px\)\)/);
    expect(SALES).toMatch(/overflow-y:auto/); // scrolls internally so Save/Contacted/Notes stay reachable
  });
  test('sales.html script still parses cleanly (layout-only change did not break the page JS)', () => {
    const blocks = [...SALES.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    blocks.forEach((b) => expect(() => new vm.Script(b)).not.toThrow());
  });
  test('CRM functionality markers are untouched (presentation-only fix)', () => {
    expect(SALES).toMatch(/\/api\/admin\/sales\/prospects/);      // list/CRUD intact
    expect(SALES).toMatch(/markContacted/);                        // contacted workflow intact
    expect(SALES).toMatch(/id="quickbar"/);                        // quick filters intact
    expect(SALES).toMatch(/<meta name="robots" content="noindex, nofollow"/); // still not indexed
  });
});
