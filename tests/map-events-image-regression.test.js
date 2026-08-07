'use strict';

/**
 * Map View — imported/GSA event image regression coverage. Proves the event-image data contract end to end:
 *   • the public feed + map APIs derive an event image from the event_images table (unchanged contract),
 *   • the homepage map cards read that image_url with a branded fallback when it is absent,
 *   • the GSA connector only ingests PUBLICLY displayable cover images (the PPMS-401 root cause),
 *   • coordless events are excluded from the viewport-scoped panel.
 * Source-level assertions (the codebase's established pattern for map wiring) + a live connector unit check.
 *
 * The map↔panel SYNC requirements (map move refreshes results; current-view scoping; marker↔card sync)
 * are covered by tests/map-viewport-drawer.test.js and remain green — this file covers the image path.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const index = read('public/index.html');
const feed = read('src/routes/public.js');
const eventsApi = read('src/routes/publicEvents.js');

describe('event card image field chain (symptom 1)', () => {
  test('[#1/#2/#3] event cards read image_url, mapped from the event record cover image', () => {
    // evToMp maps the event record's cover_image_url onto image_url (the field both card renderers read).
    expect(index).toMatch(/image_url:r\.cover_image_url\|\|null/);
    // Panel card + map popup card both render image_url.
    expect(index).toMatch(/r\.image_url\?\("url\('"\+esc\(r\.image_url\)/);   // evToDrawer background
    expect(index).toMatch(/r\.image_url\?'<div class="mpc-ev-img" style="background-image:url\(\\''\+mpEsc\(r\.image_url\)/); // popup
  });

  test('[#8] an event with no image falls back to the branded gradient (never a broken tile)', () => {
    // evToDrawer: image present → url(...) over gradient; absent → gradient only (GRAD[0]).
    expect(index).toMatch(/bg:\(r\.image_url\?\("url\('"\+esc\(r\.image_url\)\+"'\),"\+GRAD\[0\]\):GRAD\[0\]\)/);
  });

  test('native auction cards keep their cover||banner coalesce (unaffected)', () => {
    expect(index).toMatch(/var cover=a\.cover_image_url\|\|a\.banner_image_url\|\|null;/);
  });
});

describe('[#9] public feed + map API image contract is intact (event_images source of truth)', () => {
  test('marketplace feed derives the event image from event_images (cover first, then position)', () => {
    expect(feed).toMatch(/SELECT url FROM event_images ei WHERE ei\.event_id = e\.id ORDER BY is_cover DESC, position ASC LIMIT 1/);
    // native auctions still coalesce cover→banner
    expect(feed).toMatch(/COALESCE\(a\.cover_image_url, a\.banner_image_url\) AS image_url/);
  });
  test('the events/map API derives cover_image_url from event_images', () => {
    expect(eventsApi).toMatch(/SELECT url FROM event_images ei WHERE ei\.event_id = e\.id ORDER BY is_cover DESC, position ASC LIMIT 1/);
    expect(eventsApi).toMatch(/cover_image_url: r\.cover_url \|\| null/);
  });
});

describe('GSA connector ingests only publicly displayable cover images (root cause fix)', () => {
  jest.mock('../src/services/eventImport/http', () => ({ fetchJson: jest.fn(), fetchText: jest.fn() }));
  const http = require('../src/services/eventImport/http');
  const gsa = require('../src/services/eventImport/connectors/gsaConnector');
  const ROW = (o) => Object.assign({
    saleNo: 'S1', itemName: 'X', lotDescript: 'd', aucStartDt: '2999-01-01', aucEndDt: '2999-01-05',
    auctionStatus: 'Active', propertyCity: 'DALLAS', propertyState: 'TX',
    itemDescURL: 'https://www.gsaauctions.gov/x', imageURL: 'https://img.example.gov/1.jpg',
  }, o || {});
  async function collect(gen) { const out = []; for await (const x of gen) out.push(x); return out; }

  test('authenticated PPMS image URL (HTTP 401 to the public) is dropped; a public URL is kept', async () => {
    http.fetchJson.mockResolvedValueOnce({ Results: [
      ROW({ saleNo: 'PPMS', imageURL: 'https://www.ppms.gov/gw/auction/ppms/api/v1/auction/image/x.jpg' }),
      ROW({ saleNo: 'PUB',  imageURL: 'https://img.example.gov/ok.jpg' }),
    ] });
    const byId = Object.fromEntries((await collect(gsa.fetch({ config: {} }))).map((r) => [r.sourceEventId, r]));
    expect(byId.PPMS.images).toEqual([]);
    expect(byId.PUB.images).toEqual([{ url: 'https://img.example.gov/ok.jpg', position: 0 }]);
  });
});

describe('[#7] coordless events do not dominate the viewport-scoped panel', () => {
  test('inViewport excludes records without coordinates (GSA online auctions are coordless)', () => {
    expect(index).toMatch(/function inViewport\(d\)\{[\s\S]{0,80}if\(d\.lng==null\|\|d\.lat==null\) return false;/);
    // coordless online auctions are surfaced list-only in a separate section, never as viewport pins
    expect(index).toMatch(/Online \(coordless\) auctions surfaced list-only for non-archive tabs — never viewport-filtered/);
    expect(index).toMatch(/hdr\.textContent='Online auctions · nationwide';/);
  });
});
