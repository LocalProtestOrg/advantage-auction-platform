'use strict';

/**
 * Regression: the iframe auto-resize must CONVERGE, not creep. Models the child↔parent resize loop
 * over many cycles and proves the fixed measurement (true content height, viewport-independent)
 * stabilizes, while the old measurement (max(viewport, content) + buffer) grows without bound.
 * Also guards the actual widget source so the bug can't silently return.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const feed = read('public', 'widgets', 'marketplace-feed.js');
const fi = read('public', 'widgets', 'featured-items.js');
const embed = read('public', 'widgets', 'marketplace-embed.js');

const MIN = 400, MAX = 20000, GUARD = 3, ITER_CAP = 30;

// Simulate the child↔parent loop. measure(content, viewport) → reported height. Parent assigns the
// clamped reported height as the new viewport. Child re-posts only if the change clears the guard.
function simulate(content, initialViewport, measure) {
  let viewport = initialViewport, lastPosted = 0, posts = 0, i = 0;
  for (; i < ITER_CAP; i++) {
    const reported = measure(content, viewport);
    if (Math.abs(reported - lastPosted) < GUARD) break; // guard suppresses → converged
    lastPosted = reported; posts++;
    viewport = Math.max(MIN, Math.min(MAX, reported));   // parent assigns
  }
  return { viewport, posts, converged: i < ITER_CAP };
}
// FIXED: measures the TRUE content wrapper — independent of the assigned viewport.
const FIXED = (content) => Math.ceil(content) + 2;
// BUGGY (pre-fix): documentElement.scrollHeight inflates to the viewport + a growth buffer.
const BUGGY = (content, viewport) => Math.ceil(Math.max(content, viewport)) + 4;

describe('resize convergence (the fix)', () => {
  test('short content (< initial min-height) converges and does NOT creep', () => {
    const r = simulate(300, 800, FIXED);
    expect(r.converged).toBe(true);
    expect(r.posts).toBeLessThanOrEqual(2);
    expect(r.viewport).toBe(MIN);           // clamped to the floor; stable, no growth
  });
  test('tall content converges to content height (+buffer), stable', () => {
    const r = simulate(1500, 800, FIXED);
    expect(r.converged).toBe(true);
    expect(r.posts).toBeLessThanOrEqual(2);
    expect(r.viewport).toBe(1502);
  });
  test('empty-state height (true content 260) settles at the MIN floor with no scrollbar/creep', () => {
    const r = simulate(260, 800, FIXED);
    expect(r.converged).toBe(true);
    expect(r.viewport).toBe(MIN);
    expect(r.viewport).toBeGreaterThanOrEqual(FIXED(260)); // floor >= content → no clipping
  });
  test('running many consecutive cycles never increases height indefinitely', () => {
    // Re-entering the loop repeatedly (as ResizeObserver would) stays put once converged.
    let viewport = simulate(600, 800, FIXED).viewport;
    for (let k = 0; k < 10; k++) viewport = simulate(600, viewport, FIXED).viewport;
    expect(viewport).toBe(602); // content 600 + 2, unchanged across 10 re-runs
  });
});

describe('the OLD measurement is proven to diverge (guards against reverting)', () => {
  test('buggy formula never converges — viewport grows past the cap', () => {
    const r = simulate(300, 800, BUGGY);
    expect(r.converged).toBe(false);        // still posting at the iteration cap
    expect(r.viewport).toBeGreaterThan(800 + ITER_CAP); // crept well beyond the start
  });
});

describe('source guards — widgets measure true content, parent adds no spacing to height', () => {
  test('marketplace-feed.js measureHeight uses the mount, not documentElement, no +4', () => {
    const m = feed.slice(feed.indexOf('function measureHeight'), feed.indexOf('function measureHeight') + 1300);
    expect(m).toContain("getElementById('advantage-marketplace-feed')");
    expect(m).toContain('getBoundingClientRect().height');
    expect(m).not.toContain('documentElement');
    expect(m).not.toMatch(/\)\) \+ 4/);
  });
  test('featured-items.js measureHeight uses the mount, not documentElement, no +4', () => {
    const m = fi.slice(fi.indexOf('function measureHeight'), fi.indexOf('function measureHeight') + 1300);
    expect(m).toContain("getElementById('advantage-featured-items')");
    expect(m).toContain('getBoundingClientRect().height');
    expect(m).not.toContain('documentElement');
    expect(m).not.toMatch(/\)\) \+ 4/);
  });
  test('both widgets keep the insignificant-change guard', () => {
    expect(feed).toMatch(/Math\.abs\(h - lastPostedHeight\) < 3/);
    expect(fi).toMatch(/Math\.abs\(h - lastPostedHeight\) < 3/);
  });
  test('parent assigns child height as-is (never height + SPACING)', () => {
    expect(embed).toContain('f.style.height = action.height');
    expect(embed).not.toMatch(/style\.height = .*\+ SPACING/);
    expect(embed).not.toMatch(/action\.height \+ SPACING/);
  });
});
