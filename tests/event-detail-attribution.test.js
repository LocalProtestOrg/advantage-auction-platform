'use strict';

/**
 * Event-detail host attribution + discovery-source suppression + publication gate.
 *
 * Policy: the public event page must show the VERIFIED HOST COMPANY (never the owner/importer org, never
 * the discovery source), must never link the public visitor to the discovery source or a competitor, and
 * an externally-discovered event must not publish without an identified host + a company-controlled URL.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const policy = require('../src/lib/externalUrlPolicy');
const { evaluatePublication } = require('../src/services/eventImport/publicationGate');

describe('externalUrlPolicy — reject discovery/competitor/aggregator/search/shortener/social', () => {
  const reject = {
    'https://www.estatesales.net/FL/Melbourne/32904/5016474': 'discovery_source',
    'https://estatesales.org/x': 'discovery_source',
    'https://www.bidsquare.com/auctions/123': 'competitor_marketplace',
    'https://www.liveauctioneers.com/x': 'competitor_marketplace',
    'https://www.ebay.com/itm/1': 'competitor_marketplace',
    'https://www.eventbrite.com/e/1': 'aggregator_directory',
    'https://www.google.com/search?q=estate': 'search_engine',
    'https://bit.ly/abc': 'url_shortener',
    'https://facebook.com/somepage': 'social_media',
    'not-a-url': 'malformed',
    'mailto:x@y.com': 'malformed',
    'javascript:alert(1)': 'malformed',
    'http://127.0.0.1/x': 'malformed',
  };
  for (const [url, reason] of Object.entries(reject)) {
    test(`rejects ${url} → ${reason}`, () => {
      const r = policy.classifyExternalUrl(url);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
    });
  }
  test('accepts a plausible company-controlled domain', () => {
    for (const u of ['http://www.buyorbidonit.com', 'https://smithestatesales.com/sale/42', 'https://acme-auctions.net']) {
      expect(policy.classifyExternalUrl(u).ok).toBe(true);
    }
  });
  test('subdomains of rejected domains are still rejected', () => {
    expect(policy.classifyExternalUrl('https://m.ebay.com/x').ok).toBe(false);
    expect(policy.classifyExternalUrl('https://www.estatesales.net/x').reason).toBe('discovery_source');
  });
});

describe('pickHostDestination — company-controlled only; never the discovery source', () => {
  test('skips the discovery source (external_url) and picks the host website', () => {
    const dest = policy.pickHostDestination({
      external_url: 'https://www.estatesales.net/SC/x/5011233',   // discovery — must be ignored
      organizer_website_url: 'http://www.buyorbidonit.com',
    });
    expect(dest).not.toBeNull();
    expect(dest.url).toBe('http://www.buyorbidonit.com');
  });
  test('returns null when only the discovery source is available', () => {
    expect(policy.pickHostDestination({ external_url: 'https://www.estatesales.net/x' })).toBeNull();
    expect(policy.pickHostDestination({ organizer_website_url: 'https://www.estatesales.net/co/1' })).toBeNull();
  });
  test('prefers a specific registration/bidding page over the plain company site', () => {
    const dest = policy.pickHostDestination({
      registration_url: 'https://smithsales.com/events/spring',
      organizer_website_url: 'https://smithsales.com',
    });
    expect(dest.url).toBe('https://smithsales.com/events/spring');
  });
});

describe('publicationGate.evaluatePublication', () => {
  const base = {
    source: 'imported', title: 'Nice Estate Sale', start_at: '2999-01-01T15:00:00Z', end_at: '2999-01-02T20:00:00Z',
    event_format: 'live', city: 'Houston', state: 'TX', organizer_name: 'Smith Estate Sales',
    organizer_website_url: 'https://smithestatesales.com', image_count: 5,
  };
  test('ready when host + company URL + dates + location + image are all present', () => {
    expect(evaluatePublication(base).ready).toBe(true);
  });
  test('host_url_missing is a WARNING, not a hard block (ratified 5D/5F outbound-link policy)', () => {
    // Only destination is the discovery source → no company-controlled outbound URL. The event still
    // PUBLISHES (stands on its own, no outbound button); host_url_missing is recorded as a warning.
    const r = evaluatePublication({ ...base, organizer_website_url: 'https://www.estatesales.net/x' });
    expect(r.ready).toBe(true);
    expect(r.reasons).not.toContain('host_url_missing');
    expect(r.warnings).toContain('host_url_missing');
  });
  test('held when the host company is unnamed', () => {
    const r = evaluatePublication({ ...base, organizer_name: '' });
    expect(r.reasons).toContain('host_company_missing');
  });
  test('held for missing title / images / expired / bad dates', () => {
    expect(evaluatePublication({ ...base, title: '' }).reasons).toContain('title_missing');
    expect(evaluatePublication({ ...base, image_count: 0 }).reasons).toContain('image_missing');
    expect(evaluatePublication({ ...base, end_at: '2000-01-01T00:00:00Z' }).reasons).toContain('expired_event');
  });
  test('online events need no physical location; org events need no imported host fields', () => {
    expect(evaluatePublication({ ...base, event_format: 'online', city: null, state: null }).ready).toBe(true);
    // a non-imported (org-authored) event isn't subject to the imported host/url requirement
    expect(evaluatePublication({ source: 'organization', title: 'T', start_at: '2999-01-01T00:00:00Z',
      end_at: '2999-01-02T00:00:00Z', city: 'Dallas', state: 'TX', image_count: 1 }).ready).toBe(true);
  });
});

describe('public event serializer no longer leaks the discovery source (publicEvents.js)', () => {
  const src = read('src', 'routes', 'publicEvents.js');
  test('serializer does NOT expose attribution_source / attribution_url / external_url / is_imported', () => {
    const s = src.slice(src.indexOf('function serialize'), src.indexOf('// GET /api/public/events?'));
    expect(s).not.toMatch(/attribution_source:/);
    expect(s).not.toMatch(/attribution_url:/);
    expect(s).not.toMatch(/is_imported:/);
    // external_url only appears (if at all) as internal input, never as a returned key:
    expect(s).not.toMatch(/\bexternal_url:\s*r\.external_url/);
    expect(s).not.toMatch(/organization:\s*r\.org_slug/); // owner/importer org object no longer returned
  });
  test('serializer surfaces event_type_label + host_company + classifier-approved host_external_url', () => {
    const s = src.slice(src.indexOf('function serialize'), src.indexOf('// GET /api/public/events?'));
    expect(s).toMatch(/event_type_label:/);
    expect(s).toMatch(/host_company:/);
    expect(s).toMatch(/host_external_url:/);
    expect(s).toMatch(/pickHostDestination\(/);
  });
  test('host profile only for a NON-imported, PROFESSIONAL host org (individual organizers stay private)', () => {
    const s = src.slice(src.indexOf('function serialize'), src.indexOf('// GET /api/public/events?'));
    expect(s).toMatch(/const imported = r\.source === 'imported'/);
    expect(s).toMatch(/publicOrg = !imported && isPublicOrganizer\(r\.org_type\)/); // professional-only gate
    expect(s).toMatch(/hostProfile = \(publicOrg && r\.org_slug\)/);
  });
});

describe('event.html no longer shows importer terminology or the discovery source', () => {
  const html = read('public', 'event.html');
  // Strip JS line/block comments, CSS block comments, and HTML comments so we check only shippable code
  // (comments legitimately mention "original listing"/em dashes when explaining the policy).
  const code = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  test('no "Imported Listing", "original listing", "sourced from", or attribution_source rendering', () => {
    expect(code).not.toMatch(/Imported Listing/);
    expect(code).not.toMatch(/original listing/i);
    expect(code).not.toMatch(/Listing sourced from/i);
    expect(code).not.toMatch(/attribution_source/);
    expect(code).not.toMatch(/attribution_url/);
    expect(code).not.toMatch(/e\.external_url/);
  });
  test('renders the event-type badge, a gated host CTA, the lightbox, and a footer', () => {
    expect(html).toMatch(/class="typebadge"/);
    expect(html).toMatch(/host_external_url/);
    expect(html).toMatch(/id="lb"/);              // lightbox dialog
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/footer class="site"/);
  });
  test('external links keep nofollow noopener noreferrer + new tab; no em dash in copy', () => {
    expect(html).toMatch(/rel="nofollow noopener noreferrer"/);
    expect(html).toMatch(/target="_blank"/);
    // customer-facing copy (comments stripped) must not contain an em dash
    expect(code.slice(code.indexOf('<body>')).includes('—')).toBe(false);
  });
});

describe('shareMeta JSON-LD organizer is the real host, never the owner org, never a private individual', () => {
  const s = read('src', 'services', 'shareMetaService.js');
  test('organizer = organizer_name for imported; org_name ONLY for a professional organizer (else null)', () => {
    expect(s).toMatch(/r\.source === 'imported' \? r\.organizer_name : \(isPublicOrganizer\(r\.org_type\) \? r\.org_name : null\)/);
  });
});

describe('refresh populator cannot bypass the publication gate', () => {
  const refresh = read('scripts', 'refresh-estatesales-national.js');
  test('runs the SHARED evaluatePublication before publishing (reuses publicationGate.js)', () => {
    expect(refresh).toMatch(/require\('\.\.\/src\/services\/eventImport\/publicationGate'\)/);
    expect(refresh).toMatch(/evaluatePublication\(d\)/);
  });
  test('no unguarded bulk-publish UPDATE and no skipGate in the routine', () => {
    // the old bypass was a single UPDATE ... WHERE source='imported' AND status='draft' AND (end_at ...)
    expect(refresh).not.toMatch(/UPDATE events SET status='published'[\s\S]{0,120}WHERE source='imported' AND status='draft' AND \(end_at/);
    expect(refresh).not.toMatch(/skipGate:\s*true/); // never passes skipGate to bypass the gate
    // per-event publish is id-scoped
    expect(refresh).toMatch(/WHERE id=\$1 AND source='imported' AND status='draft'/);
  });
  test('held events are counted with reasons (auditable log)', () => {
    expect(refresh).toMatch(/held\+\+/);
    expect(refresh).toMatch(/heldReasons/);
  });
});

describe('additional gate/classifier cases from the remediation spec', () => {
  test('verified event-SPECIFIC company URL is preferred over the homepage', () => {
    const dest = policy.pickHostDestination({
      registration_url: 'https://acme-estates.com/sales/2026-spring',
      organizer_website_url: 'https://acme-estates.com',
    });
    expect(dest.url).toBe('https://acme-estates.com/sales/2026-spring');
  });
  test('verified company HOMEPAGE is used as the fallback when no event page exists', () => {
    const dest = policy.pickHostDestination({ organizer_website_url: 'https://acme-estates.com' });
    expect(dest.url).toBe('https://acme-estates.com');
  });
  test('a competitor auction platform (K-BID) as the only destination → held', () => {
    expect(policy.classifyExternalUrl('https://www.k-bid.com/auction/list?affiliate=481577').ok).toBe(false);
    expect(policy.pickHostDestination({ bidding_url: 'https://www.k-bid.com/auction/list?affiliate=1' })).toBeNull();
  });
  test('native (organization) events are unaffected by the imported host/url gate', () => {
    const r = evaluatePublication({ source: 'organization', title: 'Community Auction',
      start_at: '2999-01-01T00:00:00Z', end_at: '2999-01-02T00:00:00Z', city: 'Austin', state: 'TX', image_count: 1 });
    expect(r.ready).toBe(true);
  });
});
