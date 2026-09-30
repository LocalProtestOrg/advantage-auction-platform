'use strict';

/**
 * analytics.js is loaded twice on the tracked landing pages (2026-09-30 investigation): once by the page's own
 * deferred <script> and once by behavior-tracker.js, which runs first (deferred earlier) and loads it on demand.
 * This is HARMLESS for measurement, and these tests keep it that way:
 *   - analytics.js is an idempotent singleton: a second execution returns the existing AAPAnalytics and sends nothing;
 *   - analytics.js records nothing on load; the ONLY page_view caller is behavior-tracker.js, on exactly one of two
 *     mutually exclusive paths, so one page load = one page_view, one touch, one click-id capture;
 *   - ad-measurement.js (Meta pixel) is also idempotent, so a second copy cannot double-fire PageView;
 *   - no page includes behavior-tracker.js more than once (the tracker itself has no guard).
 * Production check (read-only, 30 days, 555 page views): 0 same-session same-URL repeats within 2 seconds.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', 'public');
const ANALYTICS = fs.readFileSync(path.join(PUB, 'widgets', 'shared', 'analytics.js'), 'utf8');
const TRACKER = fs.readFileSync(path.join(PUB, 'widgets', 'shared', 'behavior-tracker.js'), 'utf8');
const AD = fs.readFileSync(path.join(PUB, 'widgets', 'shared', 'ad-measurement.js'), 'utf8');

function sandbox(search = '?fbclid=IwAR_x&utm_source=facebook&utm_medium=paid') {
  const posts = []; const appended = []; const store = {};
  const sb = {
    location: { search, href: 'https://bid.advantage.bid/become-seller.html' + search, pathname: '/become-seller.html', hostname: 'bid.advantage.bid', protocol: 'https:', host: 'bid.advantage.bid' },
    URLSearchParams, JSON, Math, Date, String, parseInt, Array, Promise,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    sessionStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); } },
    fetch: (url, opts) => { posts.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null }); return Promise.resolve({ ok: false, json: () => Promise.resolve(null) }); },
    innerWidth: 1280, setInterval: () => 0, clearInterval: () => {},
    document: { readyState: 'interactive', referrer: 'https://l.facebook.com/', documentElement: { clientWidth: 1280 },
      querySelector: () => null, getElementById: () => null, addEventListener: () => {},
      createElement: () => ({}), getElementsByTagName: () => [{ parentNode: { insertBefore: () => {} } }],
      head: { appendChild: (el) => appended.push(el) } },
  };
  sb.window = sb;
  vm.createContext(sb);
  const run = (src) => vm.runInContext(src, sb);
  const pageViews = () => posts.filter((p) => /\/api\/analytics\/events$/.test(p.url) && p.body && p.body.event_type === 'page_view');
  return { sb, run, posts, appended, pageViews };
}

describe('analytics.js loaded twice does not double-count', () => {
  test('landing-page order: tracker first, then the page\'s analytics.js, then the tracker\'s copy → exactly one of each', () => {
    const { run, posts, appended, pageViews, sb } = sandbox();
    run(TRACKER);                                   // deferred earlier: AAPAnalytics absent → injects analytics.js
    const injected = appended.find((el) => /analytics\.js$/.test(el.src || ''));
    expect(injected).toBeTruthy();
    run(ANALYTICS);                                 // the page's own deferred analytics.js
    const first = sb.AAPAnalytics;
    run(ANALYTICS);                                 // the tracker's injected copy executes...
    expect(sb.AAPAnalytics).toBe(first);            // ...and returns the existing singleton
    injected.onload();                              // ...then its onload fires the page view
    expect(pageViews()).toHaveLength(1);
    expect(posts.filter((p) => /\/api\/analytics\/touch$/.test(p.url))).toHaveLength(1);
    expect(posts.filter((p) => /\/api\/analytics\/click-id$/.test(p.url))).toHaveLength(1);
  });

  test('injected copy arriving before the page\'s copy is equally single', () => {
    const { run, appended, pageViews } = sandbox();
    run(TRACKER);
    run(ANALYTICS); appended.find((el) => /analytics\.js$/.test(el.src || '')).onload();
    run(ANALYTICS);                                 // page's deferred copy runs later: no-op
    expect(pageViews()).toHaveLength(1);
  });

  test('a second analytics.js execution sends nothing and keeps the same visitor and session ids', () => {
    const { run, posts, sb } = sandbox();
    run(ANALYTICS);
    const v = sb.AAPAnalytics._getVisitorId(); const s = sb.AAPAnalytics._getSessionId();
    run(ANALYTICS);
    expect(posts).toHaveLength(0);                  // loading analytics.js never records anything by itself
    expect(sb.AAPAnalytics._getVisitorId()).toBe(v);
    expect(sb.AAPAnalytics._getSessionId()).toBe(s);
  });

  test('analytics already present: the tracker does not load another copy and fires once', () => {
    const { run, appended, pageViews } = sandbox();
    run(ANALYTICS);
    run(TRACKER);
    expect(appended.filter((el) => /analytics\.js$/.test(el.src || ''))).toHaveLength(0);
    expect(pageViews()).toHaveLength(1);
  });

  test('ad-measurement.js (Meta pixel loader) is idempotent: a second copy defines nothing new', () => {
    const { run, sb } = sandbox();
    run(AD);
    const first = sb.AdvMeasurement;
    run(AD);
    expect(sb.AdvMeasurement).toBe(first);
  });

  test('the only page_view caller is behavior-tracker.js', () => {
    const hits = [];
    const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p); else if (/\.(html|js)$/.test(f.name) && !/widgets[\\/]shared[\\/]analytics\.js$/.test(p)) {
        if (/AAPAnalytics\.page\(|track\(\s*['"]page_view['"]/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(PUB, p));
      } } };
    walk(PUB);
    expect(hits).toEqual([path.join('widgets', 'shared', 'behavior-tracker.js')]);
  });

  test('no page includes behavior-tracker.js more than once', () => {
    const many = fs.readdirSync(PUB).filter((f) => f.endsWith('.html'))
      .filter((f) => (fs.readFileSync(path.join(PUB, f), 'utf8').match(/behavior-tracker\.js/g) || []).length > 1);
    expect(many).toEqual([]);
  });
});
