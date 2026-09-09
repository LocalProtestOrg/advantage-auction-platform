'use strict';

/**
 * lmauction connector — Lewis & Maese Auction Co. (www.lmauctionco.com), OWNER-AUTHORIZED original-host
 * auction house. Parses the public catalog page (<title>, "Month DD, YYYY HH:MM AM/PM TZ" start, public
 * Invaluable housePhotos images) into a canonical payload. Attribution "Lewis & Maese", original-host URL.
 */
const c = require('../src/services/eventImport/connectors/lmauctionConnector');

const CATALOG_PATH = '/auction-catalog/l-m-mancave-auction-houston-s-premiere-choice_D8STMP86HH';
const CATALOG_URL = 'https://www.lmauctionco.com' + CATALOG_PATH;

// Compact fixture mirroring the real catalog page shape (verified live 2026-08-25).
function detailHtml(overrides = {}) {
  const o = Object.assign({
    title: 'Catalog - L&amp;M ManCave Auction | Houston&#x27;s Premiere Choice',
    date: 'September 13, 2026 11:00 AM CDT',
    imgs: [
      'https://image.invaluable.com/housePhotos/lmauctionco/24/817424/H3993-L444718619.jpg',
      'https://image.invaluable.com/housePhotos/lmauctionco/24/817424/H3993-L444718633.jpg',
      'https://image.invaluable.com/housePhotos/lmauctionco/24/817424/H3993-L444718620.jpg',
      'https://image.invaluable.com/housePhotos/lmauctionco/24/817424/H3993-L444718625.jpg',
    ],
  }, overrides);
  const imgTags = o.imgs.map((u) => `<img src="${u}">`).join('');
  return `<html><head><title>${o.title}</title></head><body>` +
    `<div class="lot-date">Starts: ${o.date}</div>${imgTags}</body></html>`;
}

function listingHtml() {
  return `<html><body><a href="${CATALOG_PATH}">View Catalog</a>` +
    `<a href="${CATALOG_PATH}">duplicate link</a>` +
    `<img src="https://image.invaluable.com/housePhotos/lmauctionco/24/817424/H3993-C444720592.jpg"></body></html>`;
}

describe('parseUpcomingLinks', () => {
  test('extracts unique catalog links from the listing', () => {
    const links = c.parseUpcomingLinks(listingHtml());
    expect(links).toEqual([CATALOG_PATH]);
  });
  test('empty / non-matching HTML → []', () => {
    expect(c.parseUpcomingLinks('<html>nothing</html>')).toEqual([]);
    expect(c.parseUpcomingLinks(null)).toEqual([]);
  });
  test('refFromPath returns the trailing _{REF}', () => {
    expect(c.refFromPath(CATALOG_PATH)).toBe('D8STMP86HH');
  });
});

describe('titleFromHtml', () => {
  test('decodes entities, strips the Catalog- prefix, joins with em dash', () => {
    expect(c.titleFromHtml(detailHtml())).toBe("L&M ManCave Auction — Houston's Premiere Choice");
  });
  test('missing <title> → null', () => {
    expect(c.titleFromHtml('<html><body>x</body></html>')).toBeNull();
  });
});

describe('parseStart', () => {
  test('parses "September 13, 2026 11:00 AM CDT" to a UTC ISO anchored in Central time', () => {
    const st = c.parseStart(detailHtml());
    expect(st).toBeTruthy();
    // 11:00 CDT (UTC-5) → 16:00Z
    expect(st.startIso).toBe('2026-09-13T16:00:00.000Z');
    expect(st.tz).toBe('America/Chicago');
  });
  test('handles 12 AM / 12 PM correctly', () => {
    expect(c.parseStart('<div>January 1, 2027 12:00 PM CST</div>').startIso).toBe('2027-01-01T18:00:00.000Z'); // noon CST(UTC-6)
    expect(c.parseStart('<div>January 1, 2027 12:00 AM CST</div>').startIso).toBe('2027-01-01T06:00:00.000Z'); // midnight CST
  });
  test('no parseable date → null', () => {
    expect(c.parseStart('<div>coming soon</div>')).toBeNull();
  });
});

describe('parseImages', () => {
  test('prefers -L renditions, dedupes, caps at 3, marks cover', () => {
    const imgs = c.parseImages(detailHtml());
    expect(imgs.length).toBe(3);
    expect(imgs[0]).toMatchObject({ position: 0, is_cover: true });
    expect(imgs.every((i) => /housePhotos\/lmauctionco/.test(i.url))).toBe(true);
  });
  test('no housePhotos images → []', () => {
    expect(c.parseImages('<html><img src="https://x/logo.svg"></html>')).toEqual([]);
  });
});

describe('parseDetail', () => {
  test('maps to a canonical payload with attribution + ORIGINAL-host URL + real image', () => {
    const { payload, images } = c.parseDetail(detailHtml(), CATALOG_URL, 'America/Chicago');
    expect(payload).toMatchObject({
      sale_type: 'auction', event_format: 'live',
      title: "L&M ManCave Auction — Houston's Premiere Choice",
      start_at: '2026-09-13T16:00:00.000Z',
      city: 'Houston', state: 'TX',
      organizer_name: 'Lewis & Maese',
      external_url: CATALOG_URL,
    });
    // reliable same-day end for expiration
    expect(payload.end_at).toBe('2026-09-14T04:59:00.000Z'); // 23:59 CDT Sep 13 → 04:59Z Sep 14
    expect(images.length).toBeGreaterThan(0);
    expect(images[0].url).toMatch(/housePhotos\/lmauctionco/);
    // never a directory host
    expect(payload.external_url).not.toMatch(/estatesales|govdeals|publicsurplus|bidsquare|auctionzip|hibid/i);
  });
  test('a page with no date is rejected (never-expire guard)', () => {
    expect(c.parseDetail(detailHtml({ date: '' }), CATALOG_URL)).toBeNull();
  });
  test('a page with no title is rejected', () => {
    expect(c.parseDetail('<html><body>no title</body></html>', CATALOG_URL)).toBeNull();
  });
});

// ── Estate-sale posts (WordPress) — the West University sale shape, verified live 2026-09-09 ──
const ES_SLUG = 'exclusive-west-university-on-site-estate-sale-september-19-2026';
const ES_URL = 'https://www.lmauctionco.com/' + ES_SLUG + '/';
const ES_IMG = 'https://image.invaluable.com/privatelabel/connectwp/wp-content/uploads/sites/223/2026/09/08152032/IMG_0323-1-871x1024.png';
function estateHtml(o = {}) {
  const x = Object.assign({ ogTitle: 'Exclusive West University On-Site Estate Sale | September 19, 2026',
    time: 'Saturday, September 19 | 9:00 AM &#8211; 3:00 PM (ONE DAY ONLY)', location: 'Location: West University Area &#8212; Houston, TX', og: ES_IMG }, o);
  return `<html><head><title>${x.ogTitle} - Lewis &amp; Maese</title>
    <meta property="og:title" content="${x.ogTitle}" /><meta property="og:image" content="${x.og}" />
    <meta property="article:modified_time" content="2026-09-09T16:35:06+00:00" /></head><body>
    <h1>${x.ogTitle}</h1><p>One Day Only | Presented by Lewis &amp; Maese Antiques &amp; Auctions</p>
    <h2>ABOUT THIS SALE</h2><p>Join Lewis &amp; Maese for an exclusive one-day estate sale in Houston&#8217;s highly sought-after West University neighborhood!</p>
    <h2>FEATURED ITEMS INCLUDE</h2><p>Furniture &amp; Seating: Quality furniture for every room</p>
    <h2>EVENT DETAILS</h2><p>Date &amp; Time: ${x.time}</p><p>${x.location}</p><p>(Exact street address will be posted on our website on Wednesday, September 16th)</p>
    <img src="https://image.invaluable.com/privatelabel/connectwp/wp-content/uploads/sites/223/2026/09/08151834/IMG_0526-1600x300-1788898793.jpg">
    <img src="https://image.invaluable.com/privatelabel/connectwp/wp-content/uploads/sites/223/2026/09/08153632/IMG_0520-1200x700.jpg">
    <img src="https://image.invaluable.com/privatelabel/connectwp/wp-content/uploads/sites/223/2026/09/08153650/IMG_0522-1200x700.jpg">
    <h2>TERMS &amp; CONDITIONS</h2><p>Payment: Cash or Credit Card only. Children: NO CHILDREN PERMITTED.</p><p>Full Terms: See website for full terms and conditions.</p>
    <footer>Lewis &amp; Maese, Houston, TX 77055</footer></body></html>`;
}
function homeHtml() {
  return `<html><body><a href="https://www.lmauctionco.com/estate-auction-august-16">auction post</a>
    <a href="https://www.lmauctionco.com/${ES_SLUG}/">West U</a><a href="https://www.lmauctionco.com/${ES_SLUG}/">dup</a>
    <a href="https://www.lmauctionco.com/katy-tx-estate-sale-designer-fashion-baccarat-fine-furnishings-lewis-maese/">Katy</a>
    <a href="https://www.lmauctionco.com/auction-catalog/some-estate-sale_ABC123">catalog</a></body></html>`;
}

describe('estate-sale discovery (WordPress posts, not catalog pages)', () => {
  test('parseEstateSaleLinks: unique estate-sale post slugs; excludes auction posts and catalog pages', () => {
    expect(c.parseEstateSaleLinks(homeHtml())).toEqual([ES_SLUG, 'katy-tx-estate-sale-designer-fashion-baccarat-fine-furnishings-lewis-maese']);
    expect(c.parseEstateSaleLinks('')).toEqual([]);
  });
  test('parseEstateSale: factual canonical payload — title, Central-time start/end, venue/city/state, description, images; nothing invented', () => {
    const { payload, images } = c.parseEstateSale(estateHtml(), ES_URL, 'America/Chicago');
    expect(payload).toMatchObject({
      title: 'Exclusive West University On-Site Estate Sale', sale_type: 'estate_sale', event_format: 'live',
      start_at: '2026-09-19T14:00:00.000Z', end_at: '2026-09-19T20:00:00.000Z', timezone: 'America/Chicago', // 9 AM–3 PM CDT
      venue_name: 'West University Area', city: 'Houston', state: 'TX',
      organizer_name: 'Lewis & Maese', external_url: ES_URL,
    });
    expect(payload.address).toBeUndefined(); expect(payload.zip).toBeUndefined();                  // address not yet published → not invented
    expect(payload.description).toMatch(/^Join Lewis & Maese for an exclusive one-day estate sale/);
    expect(payload.description).toMatch(/Exact street address will be posted/);
    expect(payload.terms_text).toMatch(/Cash or Credit Card/);
    expect(images[0]).toEqual({ url: ES_IMG, position: 0, is_cover: true });                        // og:image is the cover
    expect(images.map((i) => i.url)).not.toContain(expect.stringMatching(/1600x300/));            // banner crop excluded
    expect(images.length).toBe(3);
  });
  test('parseEstateSale: no time range → null; no date → null (never-expire guard)', () => {
    expect(c.parseEstateSale(estateHtml({ time: 'Saturday (ONE DAY ONLY)' }), ES_URL)).toBeNull();
    expect(c.parseEstateSale(estateHtml({ ogTitle: 'Exclusive West University On-Site Estate Sale' }).replace(/September 19, 2026/g, ''), ES_URL)).toBeNull();
  });
  test('parseEstateSale: missing Location line falls back to the house metro (Houston, TX) without a venue', () => {
    const { payload } = c.parseEstateSale(estateHtml({ location: 'Admission: First come, first served' }), ES_URL);
    expect(payload.venue_name).toBeNull(); expect(payload.city).toBe('Houston'); expect(payload.state).toBe('TX');
  });
});

describe('fetch — catalog auctions + estate-sale posts through one gentle pass', () => {
  const http = require('../src/services/eventImport/http');   // the connector references http.fetchText (injectable)
  let orig;
  beforeAll(() => { orig = http.fetchText; });
  afterEach(() => { http.fetchText = orig; });
  const mockSite = (map) => { http.fetchText = async (url) => ({ ok: !!map[url], status: map[url] ? 200 : 404, text: map[url] || '' }); };

  test('yields the catalog auction AND the estate-sale post (distinct source ids, original-host URLs); past posts skipped', async () => {
    mockSite({ 'https://www.lmauctionco.com/auctions/upcoming-auctions/': listingHtml(), [CATALOG_URL]: detailHtml(),
      'https://www.lmauctionco.com/': homeHtml(), [ES_URL]: estateHtml(),
      'https://www.lmauctionco.com/katy-tx-estate-sale-designer-fashion-baccarat-fine-furnishings-lewis-maese/': estateHtml({ ogTitle: 'Katy Estate Sale | January 1, 2020', time: '9:00 AM - 3:00 PM' }) });
    const out = [];
    for await (const it of c.fetch({ config: { cap: 10, timezone: 'America/Chicago' } })) out.push(it);
    expect(out.map((x) => x.sourceEventId)).toEqual(['D8STMP86HH', ES_SLUG]);
    expect(out[1].sourceUrl).toBe(ES_URL); expect(out[1].sourceUpdatedAt).toBe('2026-09-09T16:35:06+00:00');
    expect(out[1].payload.sale_type).toBe('estate_sale'); expect(out[1].images.length).toBe(3);
  }, 30000);
  test('only_estate_sale_slugs narrows a manual run to the named post(s) and skips the catalog path', async () => {
    mockSite({ 'https://www.lmauctionco.com/auctions/upcoming-auctions/': listingHtml(), [CATALOG_URL]: detailHtml(), 'https://www.lmauctionco.com/': homeHtml(), [ES_URL]: estateHtml() });
    const out = [];
    for await (const it of c.fetch({ config: { cap: 10, only_estate_sale_slugs: [ES_SLUG] } })) out.push(it);
    expect(out.map((x) => x.sourceEventId)).toEqual([ES_SLUG]);
  }, 30000);
});

describe('registry', () => {
  test('lmauction connector is registered + selectable', () => {
    const { getConnector } = require('../src/services/eventImport/connectors');
    expect(getConnector('rest', 'lmauction')).toBe(c);
  });
});
