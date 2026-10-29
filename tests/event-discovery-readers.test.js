'use strict';

/**
 * Provider-neutral discovery readers (pure): schema.org microdata / RDFa, XML sitemaps, event links and
 * generic single-event HTML extraction. Accuracy over coverage: preview, pickup and post dates are never
 * event dates; competing dates, a missing year or an unknown time zone make a page not ok.
 * Fixtures use example.com partners: no real event is invented.
 */

const { parseMicrodataEvents } = require('../src/services/eventImport/readers/microdata');
const { parseSitemap, eventUrlCandidates } = require('../src/services/eventImport/readers/sitemap');
const { findEventLinks } = require('../src/services/eventImport/readers/eventLinks');
const { extractEventFromHtml, buildProfile, checkDrift } = require('../src/services/eventImport/readers/htmlEvent');

const CHI = 'America/Chicago';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────
const WP_ESTATE = `<!doctype html><html><head>
<title>West University On-Site Estate Sale | Example Partner Auctions</title>
<meta property="og:site_name" content="Example Partner Auctions">
<link rel="canonical" href="https://partner.example.com/west-university-on-site-estate-sale/">
</head><body>
<nav class="breadcrumbs"><a href="/">Home</a> &raquo; <a href="/estate-sales/">Estate Sales</a></nav>
<article><h1 class="entry-title">West University On-Site Estate Sale</h1>
<div class="entry-meta">Posted on <time class="entry-date published" datetime="2026-09-01T10:00:00-05:00">September 1, 2026</time></div>
<p><strong>Sale Dates:</strong> Friday &amp; Saturday, November 14&ndash;15, 2026, 9:00 AM &ndash; 3:00 PM</p>
<p>Preview: November 13, 2026 by appointment</p>
<p>Location: 456 Oak St, Houston, TX 77005</p>
<p>Pickup: November 16, 2026, 10 AM</p>
</article></body></html>`;

const CATALOG = `<html><head><meta property="og:title" content="Fall Fine Art &amp; Antiques Auction">
<meta property="og:image" content="/img/cover.jpg"></head><body>
<h1>Fall Fine Art &amp; Antiques Auction</h1>
<ul><li>Auction begins: November 7, 2026 10:00 AM CST</li>
<li>Lots begin closing: November 7, 2026 6:00 PM CST</li>
<li>Preview: November 5&ndash;6, 2026 10 AM &ndash; 4 PM</li>
<li>Pick up: November 9, 2026</li></ul>
<p>7777 Blankenship Dr, Houston, TX 77055</p></body></html>`;

const extract = (html, url, opts) => extractEventFromHtml(html, url || 'https://partner.example.com/page/', opts || {});

// ── 1. generic HTML extraction ──────────────────────────────────────────────────────────────
describe('generic single-event HTML extraction', () => {
  test('a WordPress estate-sale post: sale dates from the label, never the post, preview or pickup dates', () => {
    const r = extract(WP_ESTATE, 'https://partner.example.com/west-university-on-site-estate-sale/', { timezone: CHI });
    expect(r.ok).toBe(true);
    expect(r.item.payload).toMatchObject({
      title: 'West University On-Site Estate Sale',
      start_at: '2026-11-14T15:00:00.000Z',                      // 9:00 AM CST (UTC-6 in November)
      end_at: '2026-11-15T21:00:00.000Z',                        // 3:00 PM CST on the last day
      address: '456 Oak St', city: 'Houston', state: 'TX', zip: '77005', timezone: CHI,
    });
    expect(r.evidence).toMatchObject({ title_source: 'h1', date_source: 'labeled_text', date_label: 'sale dates', timezone_source: 'channel', location_source: 'postal_address' });
    const used = [r.item.payload.start_at, r.item.payload.end_at].join(' ');
    expect(used).not.toMatch(/2026-09-01|2026-11-13|2026-11-16/);
    expect(r.evidence.excluded_dates.map((x) => x.label.toLowerCase())).toEqual(expect.arrayContaining(['preview', 'pickup']));
    expect(r.item.sourceEventId).toBe('https://partner.example.com/west-university-on-site-estate-sale/');
    expect(r.item.saleHints).toMatch(/Estate Sales/);
    expect(r.confidence).toBeGreaterThan(0.6);
  });

  test('the same post without a channel time zone is held: a time with no zone is never guessed', () => {
    const r = extract(WP_ESTATE);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('timezone_unknown');
    expect(r.item.payload.start_at).toBeNull();
  });

  test('an auction catalog page: begins / lots-begin-closing with explicit CST', () => {
    const r = extract(CATALOG, 'https://partner.example.com/auction-catalog/fall_ABC');
    expect(r.ok).toBe(true);
    expect(r.item.payload).toMatchObject({
      title: 'Fall Fine Art & Antiques Auction', start_at: '2026-11-07T16:00:00.000Z', end_at: '2026-11-08T00:00:00.000Z',
      address: '7777 Blankenship Dr', city: 'Houston', state: 'TX', zip: '77055',
      images: [{ url: 'https://partner.example.com/img/cover.jpg', position: 0 }],
    });
    expect(r.evidence).toMatchObject({ title_source: 'og:title', date_label: 'auction begins', end_label: 'lots begin closing', timezone_source: 'abbreviation', timezone: CHI });
    expect(r.item.payload.start_at).not.toMatch(/2026-11-0[569]/);
  });

  test('the catalog page with the zone removed and no channel zone is not ok', () => {
    const r = extract(CATALOG.replace(/ CST/g, ''));
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('timezone_unknown');
  });

  test('a labeled <time datetime> is used exactly; an unlabeled one is used only when it is the only date', () => {
    const labeled = extract('<h1>Spring Estate Auction</h1><p>Bidding opens <time datetime="2026-12-01T15:00:00Z">Dec 1</time></p>');
    expect(labeled.ok).toBe(true);
    expect(labeled.item.payload.start_at).toBe('2026-12-01T15:00:00.000Z');
    expect(labeled.evidence.date_source).toBe('time_element');
    const free = extract('<h1>Holiday Tag Sale</h1><p>Join us <time datetime="2026-12-05">December 5</time></p>');
    expect(free.ok).toBe(true);
    expect(free.item.payload.start_at).toBe('2026-12-05');
    const postOnly = extract('<h1>News</h1><p>Posted <time class="entry-date published" datetime="2026-09-01">Sep 1</time></p>');
    expect(postOnly.ok).toBe(false);
    expect(postOnly.reasons).toContain('no_event_date');
  });

  test('two different labeled start dates in one section compete; in different sections they are separate events', () => {
    const competing = extract('<h1>Estate Sale</h1><p>Sale Date: November 7, 2026</p><p>Sale Date: November 21, 2026</p>');
    expect(competing.ok).toBe(false);
    expect(competing.reasons).toContain('competing_dates');
    const many = extract('<h1>Upcoming</h1><h2>Fall Auction</h2><p>Auction begins: November 7, 2026</p><h2>Winter Auction</h2><p>Auction begins: December 5, 2026</p>');
    expect(many.ok).toBe(false);
    expect(many.reasons).toContain('multiple_events');
  });

  test('more than one distinct page title is not ok', () => {
    const r = extract('<h1>Fall Auction</h1><h1>Winter Auction</h1><p>Auction begins: November 7, 2026</p>');
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('multiple_titles');
  });

  test('a missing year is not ok unless the page address states it', () => {
    const html = '<h1>Memorial Estate Sale</h1><p>Sale Dates: Fri &amp; Sat, Nov 14-15 9am-3pm</p>';
    const noYear = extract(html, 'https://partner.example.com/memorial-estate-sale/', { timezone: CHI });
    expect(noYear.ok).toBe(false);
    expect(noYear.reasons).toContain('year_missing');
    const fromUrl = extract(html, 'https://partner.example.com/memorial-estate-sale-november-14-2026/', { timezone: CHI });
    expect(fromUrl.ok).toBe(true);
    expect(fromUrl.item.payload.start_at).toBe('2026-11-14T15:00:00.000Z');
    expect(fromUrl.item.payload.end_at).toBe('2026-11-15T21:00:00.000Z');
    expect(fromUrl.evidence.date_label).toBe('sale dates');
  });

  test('a page whose only dates are preview / pickup / registration has no event date', () => {
    const r = extract('<h1>Estate Sale</h1><p>Preview: November 13, 2026</p><p>Pickup: November 16, 2026</p><p>Registration closes: November 12, 2026</p>', null, { timezone: CHI });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('no_event_date');
  });

  test('numeric and ordinal date formats', () => {
    const a = extract('<h1>Coin Auction</h1><p>Starts: 11/07/2026 10:00 AM CT</p>');
    expect(a.item.payload.start_at).toBe('2026-11-07T16:00:00.000Z');
    const b = extract('<h1>Toy Auction</h1><p>Date: Saturday, November 7th 2026 at 10 AM EST</p>');
    expect(b.item.payload.start_at).toBe('2026-11-07T15:00:00.000Z');
    const c = extract('<h1>Two-Day Sale</h1><dl><dt>Sale Dates</dt><dd>Nov 14 &amp; 15, 2026</dd></dl>');
    expect(c.ok).toBe(true);
    expect(c.item.payload).toMatchObject({ start_at: '2026-11-14', end_date: '2026-11-15' });
  });

  test('no location is guessed: without a full postal or structured address it stays empty', () => {
    const r = extract('<h1>Estate Sale in Houston</h1><p>Sale Date: November 7, 2026</p><p>Pickup at 1 Dock Rd, Galveston, TX 77550</p>');
    expect(r.ok).toBe(true);
    expect(r.item.payload).toMatchObject({ address: null, city: null, state: null, zip: null });
  });
});

// ── 2. confirmed profiles and drift ─────────────────────────────────────────────────────────
describe('confirmed extraction profiles', () => {
  const samples = [
    extract(WP_ESTATE, 'https://partner.example.com/a/', { timezone: CHI }),
    extract(WP_ESTATE.replace('456 Oak St', '12 Elm St').replace('November 14&ndash;15', 'December 5&ndash;6'), 'https://partner.example.com/b/', { timezone: CHI }),
  ];
  const profile = buildProfile(samples);
  test('a profile records what the administrator confirmed', () => {
    expect(profile).toEqual({ version: 1, title_source: 'h1', date_source: 'labeled_text', date_labels: ['sale dates'], end_labels: [],
      timezone: CHI, location_source: 'postal_address', confirmed_samples: 2 });
  });
  test('a matching page shows no drift', () => {
    const r = extract(WP_ESTATE, 'https://partner.example.com/c/', { timezone: CHI, profile });
    expect(r.drift).toEqual({ drift: false, reasons: [] });
  });
  test('a changed label, a lost address or a failed extraction is drift', () => {
    const changed = extract(WP_ESTATE.replace('Sale Dates:', 'Sale Starts:'), 'https://partner.example.com/d/', { timezone: CHI, profile });
    expect(changed.drift.drift).toBe(true);
    expect(changed.drift.reasons).toContain('date_label_changed');
    const noAddr = extract(WP_ESTATE.replace('<p>Location: 456 Oak St, Houston, TX 77005</p>', ''), 'https://partner.example.com/e/', { timezone: CHI, profile });
    expect(noAddr.drift.reasons).toContain('location_missing');
    const broken = checkDrift(profile, extract('<h1>Redesigned</h1><p>See our calendar</p>', null, { timezone: CHI }));
    expect(broken.drift).toBe(true);
    expect(broken.reasons[0]).toMatch(/^extraction_failed/);
  });
});

// ── 3. microdata / RDFa ─────────────────────────────────────────────────────────────────────
describe('schema.org microdata and RDFa', () => {
  const MICRO = `<div itemscope itemtype="https://schema.org/SaleEvent">
    <h2 itemprop="name">Holiday Estate Sale</h2>
    <meta itemprop="startDate" content="2026-12-12T09:00"><meta itemprop="endDate" content="2026-12-12T15:00">
    <a itemprop="url" href="/sales/holiday">Details</a>
    <div itemprop="location" itemscope itemtype="https://schema.org/Place"><span itemprop="name">The Barn</span>
      <div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress"><span itemprop="streetAddress">12 Elm St</span>,
        <span itemprop="addressLocality">Austin</span>, <span itemprop="addressRegion">TX</span> <span itemprop="postalCode">78701</span></div></div>
    <img itemprop="image" src="/img/h.jpg">
  </div><div itemscope itemtype="https://schema.org/Organization"><span itemprop="name">Example Partner</span></div>`;
  test('a microdata SaleEvent with place and address, converted in the channel zone', () => {
    const [ev, ...rest] = parseMicrodataEvents(MICRO, 'https://partner.example.com/', { timezone: CHI });
    expect(rest).toEqual([]);                                                  // the Organization is not an event
    expect(ev).toMatchObject({ sourceEventId: 'https://partner.example.com/sales/holiday', url: 'https://partner.example.com/sales/holiday',
      payload: { title: 'Holiday Estate Sale', start_at: '2026-12-12T15:00:00.000Z', end_at: '2026-12-12T21:00:00.000Z', venue_name: 'The Barn',
        address: '12 Elm St', city: 'Austin', state: 'TX', zip: '78701', images: [{ url: 'https://partner.example.com/img/h.jpg', position: 0 }] } });
    expect(ev.saleHints).toMatch(/SaleEvent/);
  });
  test('without a zone, a local date-time is kept as published and flagged, never re-zoned', () => {
    const [ev] = parseMicrodataEvents(MICRO, 'https://partner.example.com/');
    expect(ev.payload.start_at).toBe('2026-12-12T09:00');
    expect(ev.evidence.timezone_missing).toBe(true);
  });
  test('RDFa typeof/property with an offset datetime', () => {
    const html = `<div vocab="https://schema.org/" typeof="Event"><span property="name">Coin Auction</span>
      <time property="startDate" datetime="2026-12-20T18:00:00-06:00">Dec 20</time><a property="url" href="https://partner.example.com/coins">x</a></div>`;
    const [ev] = parseMicrodataEvents(html, 'https://partner.example.com/');
    expect(ev.payload).toMatchObject({ title: 'Coin Auction', start_at: '2026-12-21T00:00:00.000Z' });
    expect(ev.url).toBe('https://partner.example.com/coins');
  });
});

// ── 4. sitemaps ─────────────────────────────────────────────────────────────────────────────
describe('XML sitemaps', () => {
  test('a sitemap index and a urlset (CDATA, entities, namespace prefixes)', () => {
    const idx = parseSitemap(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://partner.example.com/wp-sitemap-posts-post-1.xml</loc></sitemap>
      <sitemap><loc><![CDATA[https://partner.example.com/wp-sitemap-posts-page-1.xml]]></loc></sitemap></sitemapindex>`);
    expect(idx.sitemaps).toEqual(['https://partner.example.com/wp-sitemap-posts-post-1.xml', 'https://partner.example.com/wp-sitemap-posts-page-1.xml']);
    const set = parseSitemap(`<ns:urlset xmlns:ns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <ns:url><ns:loc>https://partner.example.com/west-university-estate-sale-november-14-2026/</ns:loc><ns:lastmod>2026-10-20</ns:lastmod></ns:url>
      <ns:url><ns:loc>https://partner.example.com/auction-catalog/fall_ABC?a=1&amp;b=2</ns:loc><ns:lastmod>2026-10-25</ns:lastmod></ns:url>
      <ns:url><ns:loc>https://partner.example.com/about-us/</ns:loc></ns:url></ns:urlset>`);
    expect(set.urls).toHaveLength(3);
    expect(set.urls[1]).toEqual({ loc: 'https://partner.example.com/auction-catalog/fall_ABC?a=1&b=2', lastmod: '2026-10-25' });
  });
  test('event candidates: same host, event-like paths, non-events and "lot" alone excluded, newest first', () => {
    const urls = [
      { loc: 'https://partner.example.com/west-university-estate-sale-november-14-2026/', lastmod: '2026-10-20' },
      { loc: 'https://www.partner.example.com/auction-catalog/fall_ABC', lastmod: '2026-10-25' },
      { loc: 'https://partner.example.com/tag/auction/' }, { loc: 'https://partner.example.com/wp-content/uploads/auction.jpg' },
      { loc: 'https://partner.example.com/parking-lot/' }, { loc: 'https://partner.example.com/about-us/' },
      { loc: 'https://elsewhere.example.net/auction/1' }, { loc: 'https://partner.example.com/author/admin/' },
      { loc: 'https://partner.example.com/catalog.pdf' },
    ];
    const c = eventUrlCandidates(urls, { host: 'partner.example.com' });
    expect(c.map((x) => x.loc)).toEqual(['https://www.partner.example.com/auction-catalog/fall_ABC', 'https://partner.example.com/west-university-estate-sale-november-14-2026/']);
    expect(eventUrlCandidates(urls, { host: 'partner.example.com', limit: 1 })).toHaveLength(1);
  });
});

// ── 5. event links ──────────────────────────────────────────────────────────────────────────
describe('event links on a page', () => {
  test('same-site listing and event links, scored; junk dropped; deduplicated', () => {
    const html = `<nav><a href="/auctions/upcoming-auctions/">Upcoming Auctions</a><a href="/about-us/">About</a>
      <a href="mailto:office@partner.example.com">Email</a><a href="tel:7135550100">Call</a><a href="#top">Top</a></nav>
      <main><a href="/auction-catalog/fall-fine-art_ABC">View Catalog</a><a href="/auction-catalog/fall-fine-art_ABC#lots">Lots</a>
      <a href="https://elsewhere.example.net/auction/9">Other site</a><a href="/tag/estate/">Tag</a>
      <a href="/west-university-estate-sale-november-14-2026/">West U Estate Sale</a><a href="javascript:void(0)">x</a></main>`;
    const links = findEventLinks(html, 'https://partner.example.com/');
    expect(links.map((l) => l.url).sort()).toEqual([
      'https://partner.example.com/auction-catalog/fall-fine-art_ABC',
      'https://partner.example.com/auctions/upcoming-auctions/',
      'https://partner.example.com/west-university-estate-sale-november-14-2026/',
    ].sort());
    expect(links.find((l) => /upcoming-auctions/.test(l.url)).kind).toBe('listing');
    expect(links.find((l) => /catalog/.test(l.url))).toMatchObject({ kind: 'event', text: 'View Catalog' });
    expect(findEventLinks(html, 'https://partner.example.com/', { limit: 1 })).toHaveLength(1);
    expect(findEventLinks(html, 'not a url')).toEqual([]);
  });
});
