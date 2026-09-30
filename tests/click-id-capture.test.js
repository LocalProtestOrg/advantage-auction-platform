'use strict';

/**
 * Click-id capture (mission 4d, 2026-09-30). Production showed 203 fbclid landings recorded as attribution
 * touches but 0 rows in marketing_click_ids: on the paid landing pages behavior-tracker.js is deferred BEFORE
 * analytics.js, so it posted /api/analytics/click-id with visitor_id null and the server (clickIdService.capture)
 * dropped it. The tracker now sends click ids only once the visitor id exists, alongside the touch.
 * Capture stays first-party and consent-recorded; provider export remains separately consent-gated.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'widgets', 'shared', 'behavior-tracker.js'), 'utf8');

function runTracker({ search = '?fbclid=IwAR_test_123&utm_source=facebook', analyticsPresent = false } = {}) {
  const posts = [];
  const appended = [];
  const analytics = { page: jest.fn(), _getVisitorId: () => 'v-123', _getSessionId: () => 's-1' };
  const sandbox = {
    location: { search, href: 'https://bid.advantage.bid/assisted-service.html' + search, pathname: '/assisted-service.html',
      hostname: 'bid.advantage.bid', protocol: 'https:', host: 'bid.advantage.bid' },
    URLSearchParams,
    sessionStorage: { getItem: () => null, setItem: () => {} },
    fetch: jest.fn((url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({}); }),
    document: {
      readyState: 'interactive', referrer: '',
      querySelector: () => null, getElementById: () => null,
      addEventListener: () => {},
      createElement: () => ({}),
      head: { appendChild: (el) => appended.push(el) },
    },
  };
  sandbox.window = sandbox;
  if (analyticsPresent) sandbox.AAPAnalytics = analytics;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  // Simulate analytics.js finishing loading (the tracker's own on-demand load).
  const loadAnalytics = () => {
    sandbox.AAPAnalytics = analytics;
    const s = appended.find((el) => el && /analytics\.js$/.test(el.src || ''));
    if (s && s.onload) s.onload();
  };
  return { posts, loadAnalytics, sandbox };
}

describe('click-id capture timing', () => {
  test('landing-page order (tracker before analytics.js): nothing is sent without a visitor id', () => {
    const { posts } = runTracker({ analyticsPresent: false });
    expect(posts.filter((p) => /click-id/.test(p.url))).toHaveLength(0);
  });

  test('once analytics loads, the fbclid is posted WITH the visitor id (the server can store it)', () => {
    const { posts, loadAnalytics } = runTracker({ analyticsPresent: false });
    loadAnalytics();
    const click = posts.filter((p) => /\/api\/analytics\/click-id$/.test(p.url));
    expect(click).toHaveLength(1);
    expect(click[0].body).toMatchObject({ visitor_id: 'v-123', fbclid: 'IwAR_test_123', source: 'bid.advantage.bid' });
    // the touch is still sent, and carries the same visitor
    expect(posts.some((p) => /\/api\/analytics\/touch$/.test(p.url) && p.body.visitor_id === 'v-123')).toBe(true);
  });

  test('analytics already on the page: click id posted immediately with the visitor id', () => {
    const { posts } = runTracker({ analyticsPresent: true });
    const click = posts.filter((p) => /click-id/.test(p.url));
    expect(click).toHaveLength(1);
    expect(click[0].body.visitor_id).toBe('v-123');
  });

  test('no click id in the URL: no click-id request', () => {
    const { posts, loadAnalytics } = runTracker({ search: '?utm_source=newsletter', analyticsPresent: false });
    loadAnalytics();
    expect(posts.filter((p) => /click-id/.test(p.url))).toHaveLength(0);
  });

  test('the click-id value is only ever sent to our own endpoint', () => {
    const { posts, loadAnalytics } = runTracker({ analyticsPresent: false });
    loadAnalytics();
    posts.filter((p) => JSON.stringify(p.body).includes('IwAR_test_123'))
      .forEach((p) => expect(p.url).toMatch(/^\/api\/analytics\//));
  });
});

describe('server capture requires the visitor id (why the early call was lost)', () => {
  test('clickIdService.capture without a scope id stores nothing', async () => {
    const clickIds = require('../src/services/clickIdService');
    const runner = { query: jest.fn() };
    expect(await clickIds.capture({ scopeId: null, params: { fbclid: 'x' } }, runner)).toEqual([]);
    expect(runner.query).not.toHaveBeenCalled();
    expect(await clickIds.capture({ scopeId: 'v-1', params: { fbclid: 'x' } }, runner)).toEqual(['fbclid']);
  });
});
