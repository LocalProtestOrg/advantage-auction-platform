'use strict';

/**
 * GAP-2 fix — individual event organizers must be anonymous on ALL public surfaces (the events
 * counterpart to sellerBranding for auctions). Pure policy tests + source-level guarantees that every
 * public events surface gates the organizer identity on a PROFESSIONAL org type (fail-closed).
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const { isPublicOrganizer, organizerColSql, PROFESSIONAL_ORG_TYPES } = require('../src/lib/organizerPrivacy');

describe('organizerPrivacy policy (pure)', () => {
  test('professional org types are publicly attributable', () => {
    for (const t of ['auction_company', 'auction_house', 'estate_sale_company', 'professional_liquidator']) {
      expect(isPublicOrganizer(t)).toBe(true);
      expect(isPublicOrganizer(t.toUpperCase())).toBe(true); // case-insensitive
    }
  });
  test('individual / unknown / absent org types are ANONYMOUS (fail-closed)', () => {
    for (const t of ['individual', null, undefined, '', 'random', 'private']) expect(isPublicOrganizer(t)).toBe(false);
  });
  test('organizerColSql gates the column on professional types only', () => {
    const sql = organizerColSql('o.name');
    expect(sql).toMatch(/CASE WHEN lower\(o\.type\) IN \(/);
    expect(sql).toContain("'auction_company'");
    expect(sql).toContain('ELSE NULL END');
  });
});

describe('every public events surface anonymizes an individual organizer', () => {
  const pubEvents = read('src', 'routes', 'publicEvents.js');
  const publicJs = read('src', 'routes', 'public.js');
  const shareMeta = read('src', 'services', 'shareMetaService.js');

  test('publicEvents serializer + /events + /map gate host name/profile on a professional org type', () => {
    expect(pubEvents).toContain("require('../lib/organizerPrivacy')");
    expect(pubEvents).toMatch(/o\.type AS org_type/);                 // org type selected for the gate
    expect(pubEvents).toMatch(/publicOrg = !imported && isPublicOrganizer\(r\.org_type\)/); // serializer gate
    expect(pubEvents).toMatch(/hostCompany = imported \? \(r\.organizer_name \|\| undefined\) : \(publicOrg \?/);
    // /events/map host is gated too
    expect(pubEvents).toMatch(/isPublicOrganizer\(r\.org_type\) \? \(r\.org_name \|\| undefined\) : undefined/);
  });
  test('related-companies list is restricted to professional org types', () => {
    expect(pubEvents).toMatch(/lower\(o\.type\) = ANY\(\$3\)/);
    expect(pubEvents).toMatch(/PROFESSIONAL_ORG_TYPES\]\)\)\.rows/);
  });
  test('unified marketplace feed gates the events-branch company name', () => {
    expect(publicJs).toContain("require('../lib/organizerPrivacy')");
    expect(publicJs).toMatch(/\$\{organizerColSql\('o\.name'\)\} AS company/);
  });
  test('SSR JSON-LD / OG organizer is gated (so byline + Event.organizer omit individuals)', () => {
    expect(shareMeta).toContain("require('../lib/organizerPrivacy')");
    expect(shareMeta).toMatch(/o\.type AS org_type/);
    expect(shareMeta).toMatch(/isPublicOrganizer\(r\.org_type\) \? r\.org_name : null/);
  });
  test('SSR byline + JSON-LD organizer already omit when null (no "by undefined")', () => {
    const mw = read('src', 'middleware', 'shareMeta.js');
    expect(mw).toMatch(/organizer: meta\.organizer \? \{ '@type': 'Organization'/); // JSON-LD omits when null
    expect(mw).toMatch(/if \(meta\.organizer\) parts\.push/);                        // byline omits when null
  });
});
