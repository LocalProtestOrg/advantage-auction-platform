'use strict';

/**
 * Security regressions for provider-neutral event discovery (independent review, 2026-10-29). Each test pins one
 * finding so it cannot come back:
 *   ReDoS on hostile markup · robots wildcard blow-up · javascript: links · off-site fetches · DNS-rebinding guard ·
 *   IPv6 ranges · unverified domain claims · shared hosts and listing platforms · push bound to an active channel ·
 *   per-key rate limiting · cross-company duplicate matching.
 */

const fs = require('fs');
const path = require('path');
const scan = require('../src/services/eventImport/readers/scan');
const eventLinks = require('../src/services/eventImport/readers/eventLinks');
const microdata = require('../src/services/eventImport/readers/microdata');
const htmlEvent = require('../src/services/eventImport/readers/htmlEvent');
const sitemap = require('../src/services/eventImport/readers/sitemap');
const robots = require('../src/services/eventImport/robots');
const feed = require('../src/services/eventImport/connectors/feedConnector');
const netGuard = require('../src/services/eventImport/netGuard');
const collect = require('../src/services/eventDiscovery/collect');
const discovery = require('../src/services/eventDiscovery/discoveryService');
const dedupe = require('../src/services/eventImport/dedupe');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const timed = (fn) => { const t = Date.now(); fn(); return Date.now() - t; };

describe('hostile markup cannot stall the server (linear scanning, capped input)', () => {
  const big = (unit) => unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length));
  test.each([
    ['unclosed anchors', () => eventLinks.findEventLinks(big('<a href="/x">'), 'https://s.example.com/')],
    ['unclosed comments', () => eventLinks.findEventLinks(big('<!-- '), 'https://s.example.com/')],
    ['unclosed scripts', () => microdata.parseMicrodataEvents(big('<script>'), 'https://s.example.com/')],
    ['unclosed time elements', () => htmlEvent.extractEventFromHtml(big('<time datetime="2026-01-01">'), 'https://s.example.com/e')],
    ['unclosed headings', () => htmlEvent.extractEventFromHtml(big('<h1>'), 'https://s.example.com/e')],
    ['unclosed sitemap blocks', () => sitemap.parseSitemap(big('<url><loc>'))],
    ['unclosed RSS items', () => [...feed._parsers.parseRss('<rss>' + big('<item><title>'))]],
    ['unclosed JSON-LD scripts', () => [...feed._parsers.parseJsonLd(big('<script type="application/ld+json">'))]],
  // Linear cost is ~1 s for the 1 MB cap when run alone; the quadratic regressions took minutes (153 s). The limit
  // leaves room for a fully loaded parallel test run, where a 3 s limit flaked.
  ])('%s', (_, fn) => { expect(timed(fn)).toBeLessThan(15000); });

  test('input is capped before parsing', () => {
    expect(scan.capped('x'.repeat(scan.MAX_PARSE_BYTES + 10)).length).toBe(scan.MAX_PARSE_BYTES);
  });
  test('the scanner still finds well-formed elements', () => {
    expect(scan.elements('<a href="/1">one</a><a href="/2">two</a>', 'a').map((e) => e.inner)).toEqual(['one', 'two']);
    expect(scan.stripBlocks('a<!-- x -->b<script>c</script>d', ['script'])).toBe('abd');
  });
});

describe('robots wildcards are matched in linear time and correctly', () => {
  test('a hostile rule does not explode', () => {
    const rule = '/' + '*a'.repeat(200) + 'b';
    expect(timed(() => robots.ruleMatches(rule, '/' + 'a'.repeat(2000)))).toBeLessThan(500);
  });
  test('semantics', () => {
    expect(robots.ruleMatches('/private', '/private/x')).toBe(true);
    expect(robots.ruleMatches('/*.pdf$', '/files/a.pdf')).toBe(true);
    expect(robots.ruleMatches('/*.pdf$', '/files/a.pdf?x')).toBe(false);
    expect(robots.ruleMatches('/a*b', '/a-x-b-y')).toBe(true);
    expect(robots.ruleMatches('/a*b$', '/a-x-b-y')).toBe(false);
    expect(robots.ruleMatches('/', '/anything')).toBe(true);
  });
});

describe('only http(s) links ever leave a reader', () => {
  test('javascript:, data: and over-long URLs are dropped', () => {
    const it = collect.sanitizeItem({ url: 'javascript:alert(1)', payload: { title: 'x', images: [{ url: 'data:image/png;base64,AA' }, { url: 'https://s.example.com/i.jpg' }],
      registration_url: 'javascript:x()' } });
    expect(it.url).toBeNull();
    expect(it.payload.images).toEqual([{ url: 'https://s.example.com/i.jpg', position: undefined }]);
    expect(it.payload.registration_url).toBeNull();
    expect(collect.safeUrl('https://s.example.com/' + 'a'.repeat(1200))).toBeNull();
  });
  test('the admin preview renders a link only for http(s)', () => {
    expect(read('public/admin/event-discovery.html')).toMatch(/e\.url && \/\^https\?:\\\/\\\/\/i\.test\(e\.url\)/);
  });
});

describe('the importer never leaves the company site', () => {
  test('an off-site URL is refused without any request', async () => {
    const calls = [];
    const f = collect.makeFetcher('https://www.partner.example.com', { fetchImpl: async (u) => { calls.push(u); return { status: 200, headers: {}, text: async () => '' }; },
      lookup: async () => [{ address: '93.184.216.34' }], limits: { minIntervalMs: 0 }, sleep: async () => {} });
    expect(await f.get('https://victim.example.org/admin')).toMatchObject({ allowed: false, reason: 'offsite' });
    expect(calls).toEqual([]);
  });
});

describe('SSRF', () => {
  test('the default transport pins the connection to the approved public address', async () => {
    expect(read('src/services/eventImport/netGuard.js')).toMatch(/fetchImpl \? await fetchImpl\(current, init\) : await pinnedFetch\(current, init, chk\.addresses, maxBytes\)/);
    await expect(netGuard.pinnedFetch('https://x.example.com/', { headers: {} }, ['10.0.0.1'])).rejects.toThrow(/no approved address/);
    await expect(netGuard.pinnedFetch('https://x.example.com/', { headers: {} }, [])).rejects.toThrow(/no approved address/);
  });
  test.each(['::ffff:0:a00:1', '2002:a00:1::1', '2001:0:a00:1::1', '64:ff9b:1::a00:1', '100::1'])('%s is not public', (ip) => {
    expect(netGuard.isPublicAddress(ip)).toBe(false);
  });
  test('a public IPv6 address is still allowed', () => { expect(netGuard.isPublicAddress('2606:4700:4700::1111')).toBe(true); });
});

describe('a company can only claim a website it demonstrably speaks for', () => {
  test('evidence: the organization website, or the requester email domain; otherwise admin review', () => {
    expect(discovery.domainEvidence('lmauctionco.com', { orgWebsite: 'https%3A%2F%2Flmauctionco.com%2F' })).toMatchObject({ verified: true, via: 'organization_website' });
    expect(discovery.domainEvidence('acme.example.com', { userEmail: 'mary@acme.example.com' })).toMatchObject({ verified: true, via: 'requester_email_domain' });
    expect(discovery.domainEvidence('competitor.example.com', { orgWebsite: 'https://acme.example.com', userEmail: 'mary@gmail.com' })).toMatchObject({ verified: false, via: 'needs_admin_review' });
  });
  test('shared hosting platforms and listing platforms cannot be claimed whole', async () => {
    await expect(discovery.authorizeMember({ query: async () => ({ rows: [] }) }, { organizationId: 'o', userId: 'u', role: 'owner', website: 'wixsite.com' }))
      .rejects.toMatchObject({ code: 'SHARED_HOST' });
    await expect(discovery.authorizeMember({ query: async () => ({ rows: [] }) }, { organizationId: 'o', userId: 'u', role: 'owner', website: 'https://www.estatesales.net/TX' }))
      .rejects.toMatchObject({ code: 'LISTING_PLATFORM' });
    expect(discovery.sharedHostOf('acme.wixsite.com')).toBe('wixsite.com');
  });
  test('an unverified claim waits (prospective) and only an administrator with evidence can confirm it', () => {
    const src = read('src/services/eventDiscovery/discoveryService.js');
    expect(src).toMatch(/const status = domainCheck\.verified \? 'authorized' : 'prospective';/);
    expect(src).toMatch(/Say how you confirmed the website belongs to the company/);
  });
});

describe('push is bound to an active channel and limited per key', () => {
  test('authentication requires the active push channel and a non-disabled source', () => {
    const src = read('src/services/eventDiscovery/intakeService.js');
    expect(src).toMatch(/kind = 'push_api' AND status = 'active' LIMIT 1`, \[auth\.id\]\)\)\.rows\[0\];\s+if \(!ch\) return null;/);
    expect(src).toMatch(/if \(src && src\.status === 'disabled'\) return null;/);
  });
  test('rate limits: per address before authentication, per key id after', () => {
    const r = read('src/routes/eventIntake.js');
    expect(r).toMatch(/keyGenerator: \(req\) => 'k:' \+ req\.intake\.key\.id/);
    expect(r).toMatch(/router\.use\(perIp, asyncRoute/);
    expect(r).not.toMatch(/keyOf\(req\)\.slice\(0, 11\)/);
  });
  test('the organizer is always the authorized company (a submission cannot name another host)', () => {
    for (const f of ['src/services/eventDiscovery/intakeService.js', 'src/services/eventImport/connectors/discoveryConnector.js']) {
      expect(read(f)).toMatch(/if \(attribution\.name\) payload\.organizer_name = attribution\.name;/);
    }
  });
});

describe('cross-company duplicate matching never overwrites another company', () => {
  test('a company source passes its own organization to the duplicate check', () => {
    expect(read('src/services/eventImport/index.js')).toMatch(/hostOrganizationId: src\.kind === 'partner' \? src\.owner_organization_id : null/);
  });
  test('a fingerprint match on another company event becomes a possible duplicate, not an update', async () => {
    const rec = { sourceEventId: 'x', canonical: { organizer_name: 'Smith Estates', address: '123 Main St', title: 'Smith Estate Sale', start_at: '2026-08-01T14:00:00Z', zip: '49221', city: 'Adrian', state: 'MI' } };
    const db = { query: async (sql) => (/FROM events/.test(sql)
      ? { rows: [{ id: 'V', organizer_name: 'Smith Estates', address: '123 Main St', title: 'Smith Estate Sale', start_at: '2026-08-01T14:00:00Z', zip: '49221', source: 'imported', host_organization_id: 'victim' }] }
      : { rows: [] }) };
    expect(await dedupe.dedupe(db, rec, { sourceId: 's', hostOrganizationId: 'attacker' })).toMatchObject({ outcome: 'create', possibleDuplicate: true });
  });
});
