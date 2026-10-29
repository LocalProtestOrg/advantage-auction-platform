'use strict';

/**
 * Website discovery network safety: robots.txt (RFC 9309), SSRF-safe honest fetching, request pacing,
 * and the response block classifier. Pure; every network call is injected.
 */

const robots = require('../src/services/eventImport/robots');
const netGuard = require('../src/services/eventImport/netGuard');
const block = require('../src/services/eventImport/blockClassifier');
const { DEFAULT_UA } = require('../src/services/eventImport/http');

// ── robots.txt ──────────────────────────────────────────────────────────────────────────────

describe('robots.txt parsing and evaluation', () => {
  const TXT = '﻿# comment\n'
    + 'User-agent: *\nDisallow: /private/\nAllow: /private/public\nCrawl-delay: 2\n\n'
    + 'USER-AGENT: AdvantageBid\nuser-agent: OtherBot\nDisallow: /nobots   # trailing comment\nCrawl-delay: 5\n\n'
    + 'User-agent: AdvantageBidBot\nDisallow: /*.pdf$\nDisallow: /tmp*\nAllow: /tmp/ok\nDisallow:\n\n'
    + 'Sitemap: https://x.example/sitemap.xml\n';
  const p = robots.parseRobots(TXT);

  test('groups, multi-agent lines, BOM, comments, sitemaps', () => {
    expect(p.groups).toHaveLength(3);
    expect(p.groups[1].agents).toEqual(['advantagebid', 'otherbot']);
    expect(p.groups[1].rules).toEqual([{ allow: false, path: '/nobots' }]);
    expect(p.sitemaps).toEqual(['https://x.example/sitemap.xml']);
  });
  test('the most specific agent group wins (longest product-token match)', () => {
    expect(robots.isAllowed(p, 'AdvantageBidBot', '/nobots')).toBe(true);          // its own group has no /nobots rule
    expect(robots.isAllowed(p, 'AdvantageBid', '/nobots')).toBe(false);
    expect(robots.isAllowed(p, 'SomeCrawler', '/private/x')).toBe(false);          // falls back to *
    expect(robots.isAllowed(p, 'SomeCrawler', '/private/public/page')).toBe(true); // longer Allow wins
  });
  test('wildcards and end anchors', () => {
    expect(robots.isAllowed(p, 'AdvantageBidBot', '/files/a.pdf')).toBe(false);
    expect(robots.isAllowed(p, 'AdvantageBidBot', '/files/a.pdf?x=1')).toBe(true);  // $ anchors the end
    expect(robots.isAllowed(p, 'AdvantageBidBot', '/tmpfile')).toBe(false);
    expect(robots.isAllowed(p, 'AdvantageBidBot', '/tmp/ok/1')).toBe(true);
  });
  test('Allow wins a tie of equal length; empty Disallow allows all; robots.txt itself always allowed', () => {
    const t = robots.parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\n');
    expect(robots.isAllowed(t, 'AdvantageBidBot', '/a')).toBe(true);
    expect(robots.isAllowed(robots.parseRobots('User-agent: *\nDisallow:\n'), 'AdvantageBidBot', '/anything')).toBe(true);
    expect(robots.isAllowed(robots.parseRobots('User-agent: *\nDisallow: /\n'), 'AdvantageBidBot', '/robots.txt')).toBe(true);
    expect(robots.isAllowed(robots.parseRobots('User-agent: *\nDisallow: /\n'), 'AdvantageBidBot', '/')).toBe(false);
  });
  test('no matching group at all allows everything', () => {
    expect(robots.isAllowed(robots.parseRobots('User-agent: Googlebot\nDisallow: /\n'), 'AdvantageBidBot', '/x')).toBe(true);
  });
  test('crawl delay comes from the selected group', () => {
    expect(robots.crawlDelaySeconds(p, 'SomeCrawler')).toBe(2);
    expect(robots.crawlDelaySeconds(p, 'AdvantageBid')).toBe(5);
    expect(robots.crawlDelaySeconds(p, 'AdvantageBidBot')).toBeNull();
  });

  const fetchWith = (status, text = '') => async () => ({ status, headers: {}, text });
  test.each([
    [200, { allowAll: false, disallowAll: false, refused: false, transient: false }],
    [404, { allowAll: true, disallowAll: false }],
    [410, { allowAll: true }],
    [401, { disallowAll: true, refused: true, transient: false }],
    [403, { disallowAll: true, refused: true, transient: false }],
    [429, { disallowAll: true, transient: true }],
    [503, { disallowAll: true, transient: true }],
    ['network', { disallowAll: true, transient: true }],
    [400, { allowAll: true }],
  ])('fetch policy for status %s', async (status, expected) => {
    const r = await robots.fetchRobots('https://x.example/some/page', { fetchFn: fetchWith(status, 'User-agent: *\nDisallow: /a\n') });
    expect(r).toMatchObject(expected);
    expect(r.evidence).toEqual({ url: 'https://x.example/robots.txt', status });
  });
  test('a thrown fetch is a transient disallow, and policyAllows follows the policy', async () => {
    const r = await robots.fetchRobots('https://x.example', { fetchFn: async () => { throw new Error('boom'); } });
    expect(r).toMatchObject({ status: 'network', disallowAll: true, transient: true });
    expect(robots.policyAllows(r, 'AdvantageBidBot', '/')).toBe(false);
    const ok = await robots.fetchRobots('https://x.example', { fetchFn: fetchWith(200, 'User-agent: *\nDisallow: /a\nSitemap: https://x.example/s.xml\n') });
    expect(robots.policyAllows(ok, 'AdvantageBidBot', '/a/b')).toBe(false);
    expect(robots.policyAllows(ok, 'AdvantageBidBot', '/b')).toBe(true);
    expect(ok.sitemaps).toEqual(['https://x.example/s.xml']);
  });
});

// ── addresses and URLs ──────────────────────────────────────────────────────────────────────

describe('public addresses', () => {
  test.each([
    ['8.8.8.8', true], ['93.184.216.34', true], ['127.0.0.1', false], ['10.1.2.3', false], ['172.16.0.1', false],
    ['172.31.255.255', false], ['172.32.0.1', true], ['192.168.1.1', false], ['169.254.169.254', false], ['100.64.0.1', false],
    ['0.0.0.0', false], ['224.0.0.1', false], ['255.255.255.255', false], ['198.18.0.1', false],
    ['::1', false], ['::', false], ['fc00::1', false], ['fd12:3456::1', false], ['fe80::1', false], ['ff02::1', false],
    ['::ffff:127.0.0.1', false], ['::ffff:10.0.0.1', false], ['::ffff:8.8.8.8', true], ['2606:4700:4700::1111', true],
    ['not-an-ip', false],
  ])('%s → %s', (ip, expected) => { expect(netGuard.isPublicAddress(ip)).toBe(expected); });
});

describe('checkUrl', () => {
  const lookup = (map) => async (host) => (map[host] || []).map((address) => ({ address }));
  test('accepts a public https host', async () => {
    const r = await netGuard.checkUrl('https://partner.example/events', { lookup: lookup({ 'partner.example': ['93.184.216.34'] }) });
    expect(r).toMatchObject({ ok: true, host: 'partner.example', addresses: ['93.184.216.34'] });
  });
  test.each([
    ['ftp://x.example/', 'protocol_not_allowed'], ['file:///etc/passwd', 'protocol_not_allowed'],
    ['https://user:pw@x.example/', 'credentials_in_url'], ['https://x.example:8080/', 'port_not_allowed'],
    ['http://localhost/', 'private_address'], ['http://127.0.0.1/', 'private_address'], ['http://[::1]/', 'private_address'],
    ['http://169.254.169.254/latest/meta-data/', 'private_address'], ['not a url', 'invalid_url'],
  ])('refuses %s (%s)', async (url, reason) => {
    expect(await netGuard.checkUrl(url, { lookup: lookup({}) })).toMatchObject({ ok: false, reason });
  });
  test('DNS rebinding: one private answer among public ones is refused', async () => {
    const r = await netGuard.checkUrl('https://rebind.example/', { lookup: lookup({ 'rebind.example': ['93.184.216.34', '10.0.0.5'] }) });
    expect(r).toMatchObject({ ok: false, reason: 'private_address' });
  });
  test('a DNS failure is refused', async () => {
    expect(await netGuard.checkUrl('https://nx.example/', { lookup: async () => { throw new Error('ENOTFOUND'); } })).toMatchObject({ ok: false, reason: 'dns_failed' });
  });
});

// ── safeFetch ───────────────────────────────────────────────────────────────────────────────

function res(status, { headers = {}, body = '' } = {}) {
  return { status, headers: new Map(Object.entries(headers)), text: async () => body };
}
const publicLookup = async () => [{ address: '93.184.216.34' }];
const privateFor = (bad) => async (host) => [{ address: host === bad ? '10.0.0.1' : '93.184.216.34' }];

describe('safeFetch', () => {
  test('always sends the honest identity, manual redirects, no credentials', async () => {
    const calls = [];
    const r = await netGuard.safeFetch('https://x.example/', { lookup: publicLookup,
      fetchImpl: async (url, init) => { calls.push({ url, init }); return res(200, { headers: { 'content-type': 'text/html' }, body: 'hi' }); } });
    expect(r).toMatchObject({ ok: true, status: 200, text: 'hi', url: 'https://x.example/', contentType: 'text/html', redirects: [] });
    expect(calls[0].init.headers['User-Agent']).toBe(DEFAULT_UA);
    expect(calls[0].init.redirect).toBe('manual');
    expect(calls[0].init.credentials).toBe('omit');
  });
  test('a caller-supplied User-Agent is refused outright', async () => {
    await expect(netGuard.safeFetch('https://x.example/', { headers: { 'user-AGENT': 'Mozilla/5.0' }, fetchImpl: async () => res(200) })).rejects.toThrow(/identity/);
  });
  test('follows a same-site redirect chain, checking every hop', async () => {
    const seen = [];
    const lookupSpy = async (host) => { seen.push(host); return [{ address: '93.184.216.34' }]; };
    const map = { 'http://x.example/a': res(301, { headers: { location: 'https://www.x.example/b' } }),
      'https://www.x.example/b': res(302, { headers: { location: '/c' } }), 'https://www.x.example/c': res(200, { body: 'done' }) };
    const r = await netGuard.safeFetch('http://x.example/a', { lookup: lookupSpy, fetchImpl: async (u) => map[u] });
    expect(r).toMatchObject({ ok: true, text: 'done', url: 'https://www.x.example/c' });
    expect(r.redirects.map((x) => x.to)).toEqual(['https://www.x.example/b', 'https://www.x.example/c']);
    expect(seen).toEqual(['x.example', 'www.x.example', 'www.x.example']);
  });
  test('an off-site redirect is refused unless the host is explicitly allowed', async () => {
    const f = async (u) => (u.includes('x.example') ? res(302, { headers: { location: 'https://cal.other.example/feed.ics' } }) : res(200, { body: 'ics' }));
    expect(await netGuard.safeFetch('https://x.example/cal', { lookup: publicLookup, fetchImpl: f })).toMatchObject({ ok: false, reason: 'offsite_redirect' });
    expect(await netGuard.safeFetch('https://x.example/cal', { lookup: publicLookup, fetchImpl: f, allowedHosts: ['cal.other.example'] })).toMatchObject({ ok: true, text: 'ics' });
    expect(await netGuard.safeFetch('https://x.example/cal', { lookup: publicLookup, fetchImpl: f, sameSite: false })).toMatchObject({ ok: true });
  });
  test('a redirect to a private address is refused', async () => {
    const f = async (u) => (u.startsWith('https://x.example') ? res(302, { headers: { location: 'https://internal.x.example/' } }) : res(200));
    expect(await netGuard.safeFetch('https://x.example/', { lookup: privateFor('internal.x.example'), fetchImpl: f })).toMatchObject({ ok: false, status: 'blocked', reason: 'private_address' });
  });
  test('too many redirects', async () => {
    let n = 0;
    const r = await netGuard.safeFetch('https://x.example/0', { lookup: publicLookup, maxRedirects: 2,
      fetchImpl: async () => res(302, { headers: { location: '/' + (++n) } }) });
    expect(r).toMatchObject({ ok: false, reason: 'too_many_redirects' });
  });
  test('a body over the cap is refused (streamed)', async () => {
    const big = { status: 200, headers: new Map(), body: { getReader: () => { let i = 0; return {
      read: async () => (i++ < 10 ? { done: false, value: new Uint8Array(1024) } : { done: true }), cancel: async () => {} }; } } };
    expect(await netGuard.safeFetch('https://x.example/', { lookup: publicLookup, maxBytes: 4096, fetchImpl: async () => big })).toMatchObject({ ok: false, reason: 'too_large' });
  });
  test('a timeout is a network failure, not a throw', async () => {
    const hang = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await netGuard.safeFetch('https://x.example/', { lookup: publicLookup, timeoutMs: 20, fetchImpl: hang })).toMatchObject({ ok: false, status: 'network', reason: 'timeout' });
  });
  test('HTTP errors never throw', async () => {
    expect(await netGuard.safeFetch('https://x.example/', { lookup: publicLookup, fetchImpl: async () => res(403, { headers: { server: 'CloudFront' }, body: 'denied' }) }))
      .toMatchObject({ ok: false, status: 403, text: 'denied', headers: { server: 'CloudFront' }, reason: 'http_status' });
  });
  test('a refused URL is never fetched', async () => {
    const spy = jest.fn();
    expect(await netGuard.safeFetch('http://127.0.0.1/admin', { fetchImpl: spy })).toMatchObject({ ok: false, status: 'blocked' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('host pacer', () => {
  test('spaces requests to the same host; other hosts are independent', async () => {
    let t = 0; const slept = [];
    const pacer = netGuard.createHostPacer({ minIntervalMs: 3000, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    await pacer.wait('x.example');
    t += 1000; await pacer.wait('www.x.example');
    await pacer.wait('y.example');
    expect(slept).toEqual([2000]);
  });
});

// ── block classifier ────────────────────────────────────────────────────────────────────────

describe('block classifier', () => {
  const c = (o) => block.classifyResponse(o);
  test('CloudFront 403 is a host firewall refusal, with the edge recorded as evidence', () => {
    const r = c({ status: 403, headers: { Server: 'CloudFront', 'X-Amz-Cf-Id': 'abc' }, text: '<title>Access Denied</title>', url: 'https://x.example/robots.txt' });
    expect(r).toMatchObject({ class: 'host_firewall_refusal', transient: false });
    expect(r.evidence.header).toMatch(/server: CloudFront/);
    expect(r.evidence.header).toMatch(/x-amz-cf-id: abc/);
  });
  test('AWS WAF 202 challenge with an empty body', () => {
    expect(c({ status: 202, headers: { 'x-amzn-waf-action': 'challenge', server: 'CloudFront' }, text: '' })).toMatchObject({ class: 'bot_challenge', transient: false });
  });
  test('an Incapsula 200 page is a challenge, not content', () => {
    expect(c({ status: 200, headers: {}, text: '<html><script src="/_Incapsula_Resource?SWJIYLWA=x"></script></html>' }).class).toBe('bot_challenge');
  });
  test('a Cloudflare 403 "Just a moment..." page is a challenge', () => {
    expect(c({ status: 403, headers: { 'cf-ray': '1' }, text: '<title>Just a moment...</title>' }).class).toBe('bot_challenge');
    expect(c({ status: 403, headers: { 'cf-mitigated': 'challenge' }, text: '' }).class).toBe('bot_challenge');
  });
  test.each([
    [{ status: 429 }, 'rate_limited', true],
    [{ status: 503 }, 'unreachable', true],
    [{ status: 'network' }, 'unreachable', true],
    [{ status: 404 }, 'not_found', false],
    [{ status: 410 }, 'not_found', false],
    [{ status: 401 }, 'host_firewall_refusal', false],
    [{ status: 451 }, 'host_firewall_refusal', false],
    [{ status: 200, text: '<html>events</html>' }, 'ok', false],
    [{ status: 418 }, 'other', false],
  ])('%j → %s', (input, cls, transient) => { expect(c(input)).toMatchObject({ class: cls, transient }); });
  test('landing on a login page the request did not ask for is login_required', () => {
    expect(c({ status: 200, url: 'https://x.example/wp-login.php?redirect_to=x', requestedUrl: 'https://x.example/events/' }).class).toBe('login_required');
    expect(c({ status: 200, url: 'https://x.example/account/login', requestedUrl: 'https://x.example/calendar' }).class).toBe('login_required');
    expect(c({ status: 200, url: 'https://x.example/events/', requestedUrl: 'https://x.example/events/' }).class).toBe('ok');
  });
  test('seller wording is vendor-neutral; admin wording is technical', () => {
    for (const cls of block.CLASSES) {
      expect(block.describe(cls, 'seller')).not.toMatch(/CloudFront|Cloudflare|Incapsula|AWS|Akamai|WAF|HTTP/);
      expect(typeof block.describe(cls, 'admin')).toBe('string');
    }
    expect(block.describe('host_firewall_refusal')).toBe('Your website\'s host does not allow automated reading.');
  });
});
