'use strict';

/**
 * Google Places (New) prospect discovery — connector parsing/classification, safe key handling, minimal
 * field mask, error diagnosis, and Place-ID dedup that ENRICHES rather than duplicates + preserves Sales work.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const gp = require('../src/services/prospectResearch/googlePlaces');

const PLACE = {
  id: 'ChIJ_test_123', displayName: { text: 'Adrian Estate Liquidation Co' },
  formattedAddress: '12 Main St, Adrian, MI 49221, USA',
  addressComponents: [
    { longText: 'Adrian', shortText: 'Adrian', types: ['locality'] },
    { longText: 'Michigan', shortText: 'MI', types: ['administrative_area_level_1'] },
    { longText: '49221', shortText: '49221', types: ['postal_code'] }],
  nationalPhoneNumber: '(517) 555-0100', websiteUri: 'https://adrianestates.com',
  googleMapsUri: 'https://maps.google.com/?cid=1', types: ['point_of_interest'], businessStatus: 'OPERATIONAL',
};
function fakeFetch(status, jsonBody) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => jsonBody });
}

describe('mapPlace + classify — parsing and honest classification', () => {
  test('extracts name/city/state/zip/phone/website/place-id', () => {
    const m = gp.mapPlace(PLACE);
    expect(m).toMatchObject({ googlePlaceId: 'ChIJ_test_123', displayName: 'Adrian Estate Liquidation Co', city: 'Adrian', state: 'MI', zip: '49221', phone: '(517) 555-0100', website: 'https://adrianestates.com' });
  });
  test('estate/liquidation recognized; auction unknown (never inferred)', () => {
    const c = gp.classify(gp.mapPlace(PLACE));
    expect(c).toMatchObject({ relevant: true, business_type: 'estate_sale_company', estate_sales_offered: 'yes', online_auctions_offered: 'unknown' });
  });
  test('auction house recognized', () => {
    expect(gp.classify({ displayName: 'Smith Auction Gallery' }).business_type).toBe('auction_house');
  });
  test('irrelevant businesses rejected (real-estate broker)', () => {
    expect(gp.classify({ displayName: 'ABC Realty Real Estate' }).relevant).toBe(false);
    expect(gp.classify({ displayName: 'Downtown Dentist' }).relevant).toBe(false);
  });
  test('permanently closed rejected', () => {
    expect(gp.classify({ displayName: 'Old Estate Sales', businessStatus: 'CLOSED_PERMANENTLY' }).relevant).toBe(false);
  });
  test('no website is NOT asserted as "confirmed no website" (section 10)', () => {
    expect(gp.classify({ displayName: 'Bobs Estate Sales', website: null }).independent_website).toBe('unknown');
  });
  test('social-only presence distinguished', () => {
    expect(gp.classify({ displayName: 'Bobs Estate Sales', website: 'https://facebook.com/bobs' }).website_status).toBe('social_only');
  });
  test('toProspect carries Place-ID + provenance + never fabricates email', () => {
    const p = gp.toProspect(gp.mapPlace(PLACE));
    expect(p).toMatchObject({ google_place_id: 'ChIJ_test_123', source: 'google_places', contact_source: 'Google Places API (New)', business_email: null });
    expect(p.source_url).toMatch(/maps\.google/);
  });
});

describe('searchText — safe API handling + minimal field mask', () => {
  const OLD = process.env.GOOGLE_PLACES_API_KEY;
  afterAll(() => { process.env.GOOGLE_PLACES_API_KEY = OLD; });

  test('field mask requests only needed fields — never photos/reviews/hours/summaries', () => {
    expect(gp.FIELD_MASK).toMatch(/places\.id/);
    expect(gp.FIELD_MASK).toMatch(/nationalPhoneNumber/);
    expect(gp.FIELD_MASK).not.toMatch(/photos|reviews|regularOpeningHours|editorialSummary/i);
  });
  test('missing key → ok:false, never throws, never leaks', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const r = await gp.searchText('estate sale company in Michigan', {}, { fetch: fakeFetch(200, { places: [] }) });
    expect(r.ok).toBe(false); expect(r.diagnosis).toBe('missing-key');
  });
  test('200 parses places to normalized prospects', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'TEST_KEY_NOT_REAL';
    const r = await gp.searchText('estate sale company in Michigan', { max: 5 }, { fetch: fakeFetch(200, { places: [PLACE] }) });
    expect(r.ok).toBe(true); expect(r.places.length).toBe(1);
    expect(r.places[0].displayName).toBe('Adrian Estate Liquidation Co');
    expect(JSON.stringify(r)).not.toContain('TEST_KEY_NOT_REAL'); // key never in the return
  });
  test('403 SERVICE_DISABLED → ok:false with an api-not-enabled diagnosis (no throw)', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'TEST_KEY_NOT_REAL';
    const r = await gp.searchText('x', {}, { fetch: fakeFetch(403, { error: { status: 'PERMISSION_DENIED', message: 'Places API (New) has not been used' } }) });
    expect(r.ok).toBe(false); expect(r.status).toBe(403); expect(r.diagnosis).toMatch(/api-not-enabled|permission/);
  });
  test('429 → quota diagnosis', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'TEST_KEY_NOT_REAL';
    const r = await gp.searchText('x', {}, { fetch: fakeFetch(429, { error: { status: 'RESOURCE_EXHAUSTED' } }) });
    expect(r.diagnosis).toMatch(/quota|rate-limit/);
  });
});

describe('Place-ID dedup — enrich, never duplicate; preserve Sales work', () => {
  jest.resetModules();
  jest.doMock('../src/db', () => ({ query: jest.fn() }));
  const db = require('../src/db');
  const svc = require('../src/services/salesProspectService');
  function route(routes, rec) {
    db.query.mockImplementation(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim(); if (rec) rec.push({ sql: flat, params });
      for (const [re, res] of routes) if (re.test(flat)) return typeof res === 'function' ? res(params) : res;
      return { rows: [], rowCount: 0 };
    });
  }
  test('dedupKeys includes the Google Place ID', () => {
    expect(svc.dedupKeys({ company_name: 'X', google_place_id: 'ChIJ_abc' }).google_place_id).toBe('ChIJ_abc');
  });
  test('an existing Place ID → UPDATE (enrich) research only, no duplicate insert, no CRM columns touched', async () => {
    const rec = [];
    route([[/SELECT \* FROM sales_prospects WHERE/, { rows: [{ id: 'existing', priority_locked: false }] }], [/UPDATE sales_prospects SET/, { rowCount: 1 }]], rec);
    const rprospect = gp.toProspect(gp.mapPlace(PLACE));
    const sum = await svc.importProspects([rprospect], { source: 'google_places' });
    expect(sum.updated).toBe(1); expect(sum.inserted).toBe(0);
    const dupSel = rec.find((c) => /SELECT \* FROM sales_prospects WHERE/.test(c.sql));
    expect(dupSel.sql).toMatch(/google_place_id = \$1/);          // Place ID checked first
    const upd = rec.find((c) => /UPDATE sales_prospects SET/.test(c.sql));
    expect(upd.sql).toMatch(/google_place_id=COALESCE/);
    expect(upd.sql).not.toMatch(/contact_status\s*=|assigned_rep_user_id\s*=|last_contact_at\s*=|next_follow_up_at\s*=/);
  });
});

describe('security — key is never hardcoded/committed/exposed', () => {
  test('connector reads the key only from process.env and never returns/logs it', () => {
    const src = read('src/services/prospectResearch/googlePlaces.js');
    expect(src).toMatch(/process\.env\[KEY_ENV\]/);
    expect(src).toMatch(/redact/);
    // no hardcoded Google API key literal (AIza...)
    expect(src).not.toMatch(/AIza[0-9A-Za-z_\-]{20,}/);
  });
  test('harvest + verify scripts never print the key VALUE (printing the var NAME in a message is fine)', () => {
    const h = read('scripts/research-prospects-google.js');
    const v = read('scripts/verify-google-places.js');
    // A leak would be logging the actual env VALUE — e.g. console.log(process.env.GOOGLE_PLACES_API_KEY).
    expect(h).not.toMatch(/console\.log\([^;]*process\.env\.GOOGLE_PLACES_API_KEY/);
    expect(v).not.toMatch(/console\.log\([^;]*process\.env\.GOOGLE_PLACES_API_KEY/);
    expect(v).toMatch(/KEY_PRESENT/);
    expect(h).not.toMatch(/AIza[0-9A-Za-z_\-]{20,}/);
    expect(v).not.toMatch(/AIza[0-9A-Za-z_\-]{20,}/);
  });
});
