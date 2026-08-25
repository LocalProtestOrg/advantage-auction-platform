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

describe('registry', () => {
  test('lmauction connector is registered + selectable', () => {
    const { getConnector } = require('../src/services/eventImport/connectors');
    expect(getConnector('rest', 'lmauction')).toBe(c);
  });
});
