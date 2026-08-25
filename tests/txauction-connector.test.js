'use strict';

/**
 * txauction connector — parses window.__APOLLO_STATE__ from a Gaston & Sheehan auction page into a
 * canonical payload. Government auctions (Treasury/USMS/local), original-host attribution, image-capable.
 */
const c = require('../src/services/eventImport/connectors/txauctionConnector');

// Compact fixture mirroring the real page shape (verified live against auction 31469).
function pageHtml(overrides = {}) {
  const auction = Object.assign({
    __typename: 'Auction', auction_id: 31469, auction_status: 200,
    title: 'Southside Wrecker & Austin Police Department Online Auction',
    description_plain: 'Impounded vehicles. Approval to bid required.',
    start_time: '2026-08-19T14:00:00.000Z', end_time: '2099-01-01T15:00:00.000Z',
    public_url: 'https://www.txauction.com/auctions/31469-southside-wrecker-and-austin-police-department-online-auction',
    primary_image: { large: 'https://d3j17a2r8lnfte.cloudfront.net/gs/2024/4/large/x.jpeg' },
    auction_location: { __typename: 'AuctionLocation', line_1: 'Southside Wrecker', city: 'Austin', state_name: 'Texas' },
  }, overrides);
  const state = { 'Query': { __typename: 'Query' }, 'Auction:31469': auction };
  return `<html><head><meta property="og:image" content="${auction.primary_image.large}"></head>` +
    `<body></body><script>window.__APOLLO_STATE__ = ${JSON.stringify(state)};</script></html>`;
}

describe('parseAuctionState + auctionToPayload', () => {
  test('extracts the Auction node from __APOLLO_STATE__', () => {
    const a = c.parseAuctionState(pageHtml());
    expect(a).toBeTruthy();
    expect(a.auction_id).toBe(31469);
  });
  test('maps to a canonical auction payload with ISO dates, location, and ORIGINAL-host URL', () => {
    const { payload } = c.auctionToPayload(c.parseAuctionState(pageHtml()), 'America/Chicago');
    expect(payload).toMatchObject({
      sale_type: 'auction', event_format: 'online',
      title: 'Southside Wrecker & Austin Police Department Online Auction',
      start_at: '2026-08-19T14:00:00.000Z', end_at: '2099-01-01T15:00:00.000Z',
      city: 'Austin', state: 'Texas',
      external_url: expect.stringContaining('txauction.com/auctions/31469-'),
    });
    // Attribution present (host_company gate) and NEVER points at a directory.
    expect(payload.organizer_name).toBeTruthy();
    expect(payload.external_url).not.toMatch(/estatesales|govdeals|publicsurplus|bidsquare|auctionzip|hibid/i);
  });
  test('images are left empty at ingestion (enrichment re-hosts the og:image to Cloudinary)', () => {
    const { images } = c.auctionToPayload(c.parseAuctionState(pageHtml()), 'America/Chicago');
    expect(images).toEqual([]);
  });
  test('an auction with no end_time is rejected (never-expire guard)', () => {
    expect(c.auctionToPayload(c.parseAuctionState(pageHtml({ end_time: null })), 'America/Chicago')).toBeNull();
  });
  test('organizer_name falls back to the auctioneer when no location line is present', () => {
    const { payload } = c.auctionToPayload(c.parseAuctionState(pageHtml({ auction_location: { city: 'Austin', state_name: 'Texas' } })), 'America/Chicago');
    expect(payload.organizer_name).toMatch(/Gaston & Sheehan/);
  });
  test('malformed / missing Apollo state → null (never throws)', () => {
    expect(c.parseAuctionState('<html>no state</html>')).toBeNull();
    expect(c.parseAuctionState('<script>window.__APOLLO_STATE__ = {not json;</script>')).toBeNull();
  });
});

describe('registry', () => {
  test('txauction connector is registered + selectable', () => {
    const { getConnector } = require('../src/services/eventImport/connectors');
    expect(getConnector('rest', 'txauction')).toBe(c);
  });
});
