'use strict';

/**
 * Branded GSA / Federal Surplus placeholder. GSA auction photos are login-gated at the source (PPMS 401),
 * so those auctions get a distinct, branded placeholder — not the generic gradient — consistently across
 * every public surface, derived SERVER-SIDE from external_url (never exposing the discovery-source URL).
 * Unit + source-level + asset assertions.
 */
const fs = require('fs');
const path = require('path');
const gs = require('../src/lib/govSurplusPlaceholder');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('gov-surplus detection + image fallback', () => {
  test('isGovSurplus matches gsaauctions.gov listing URLs only', () => {
    expect(gs.isGovSurplus('https://www.gsaauctions.gov/auctions/preview/373282')).toBe(true);
    expect(gs.isGovSurplus('https://www.estatesales.net/TX/x')).toBe(false);
    expect(gs.isGovSurplus(null)).toBe(false);
    expect(gs.isGovSurplus('')).toBe(false);
  });

  test('a publicly displayable real image is kept (imported estate sale / native)', () => {
    expect(gs.eventImage('https://picturescdn.estatesales.net/1/a.jpg', 'https://www.estatesales.net/x'))
      .toBe('https://picturescdn.estatesales.net/1/a.jpg');
  });

  test('a GSA event with a login-gated ppms.gov image gets the branded placeholder (existing data)', () => {
    expect(gs.eventImage('https://www.ppms.gov/gw/auction/ppms/api/v1/auction/image/x.jpg',
      'https://www.gsaauctions.gov/auctions/preview/1')).toBe('/img/gsa-surplus-placeholder.svg');
  });

  test('a GSA event with no image at all gets the branded placeholder (future imports)', () => {
    expect(gs.eventImage(null, 'https://www.gsaauctions.gov/auctions/preview/1')).toBe('/img/gsa-surplus-placeholder.svg');
  });

  test('a non-GSA event with no image gets null (generic placeholder handled by the surface)', () => {
    expect(gs.eventImage(null, null)).toBeNull();
    expect(gs.eventImage(null, 'https://www.estatesales.net/x')).toBeNull();
  });

  test('coverImageSql nulls a ppms.gov image then falls back to the placeholder for gsaauctions.gov', () => {
    const sql = gs.coverImageSql('(SELECT url FROM event_images ei WHERE ei.event_id = e.id LIMIT 1)');
    expect(sql).toMatch(/ILIKE '%ppms\.gov%' THEN NULL/);
    expect(sql).toMatch(/e\.external_url ILIKE '%gsaauctions\.gov%' THEN '\/img\/gsa-surplus-placeholder\.svg'/);
    expect(sql.startsWith('COALESCE(')).toBe(true);
  });
});

describe('the placeholder asset (Advantage Design System)', () => {
  const svg = read('public/img/gsa-surplus-placeholder.svg');
  test('exists and is a valid-looking SVG', () => {
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(svg).toMatch(/viewBox="0 0 800 600"/);
  });
  test('communicates Federal/Government Surplus + carries the required message + Advantage branding', () => {
    expect(svg).toMatch(/FEDERAL SURPLUS AUCTION/);
    expect(svg).toMatch(/U\.S\. Government Surplus/);
    expect(svg).toMatch(/Official auction photo not publicly available\./);   // owner-required copy
    expect(svg).toMatch(/Advantage/);
    expect(svg).toMatch(/Fraunces/);                                          // design-system serif
  });
  test('does not impersonate a real agency (no official name/seal in the rendered artwork)', () => {
    // Strip comments, then assert the visible artwork does not use the actual agency name.
    const rendered = svg.replace(/<!--[\s\S]*?-->/g, '');
    expect(rendered).not.toMatch(/General Services Administration/i);
  });
});

describe('every public event-image surface uses the shared placeholder helper (consistency)', () => {
  const pub = read('src/routes/public.js');
  const pubEvents = read('src/routes/publicEvents.js');
  test('marketplace feed folds the placeholder into the event image column', () => {
    expect(pub).toMatch(/coverImageSql\('\(SELECT url FROM event_images ei WHERE ei\.event_id = e\.id/);
  });
  test('event list / map / related use coverImageSql; event detail uses eventImage', () => {
    expect((pubEvents.match(/coverImageSql\(/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(pubEvents).toMatch(/eventImage\(\(images\.find/);
  });
  test('the discovery-source URL (external_url) is not surfaced to clients', () => {
    // The helper derives from external_url server-side; the routes must not add it to a response object.
    expect(pub).not.toMatch(/external_url:\s*r\.external_url/);
    expect(pubEvents).not.toMatch(/external_url:\s*r\.external_url/);
  });
});
