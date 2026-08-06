'use strict';

/**
 * GAP-1 + GAP-3 privacy hardening. Public seller-profile + professional-profile endpoints must fail
 * closed to 404 for anyone who is not an APPROVED public professional. Pure policy tests (the three
 * authoritative helpers) + source-level guarantees that the endpoints enforce them at the query layer.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const sb = require('../src/lib/sellerBranding');
const schema = require('../src/lib/professionalProfileSchema');

describe('GAP-1 — public seller profile is professional-only, fail closed', () => {
  const src = read('src', 'routes', 'public.js');
  const endpoint = src.slice(src.indexOf("router.get('/sellers/:sellerId/profile'"), src.indexOf("// ── GET /api/public/config"));

  test('1. professional seller with branding enabled is publicly visible', () => {
    expect(sb.brandingVisible('business', true)).toBe(true);
    expect(sb.brandingVisible('auction_house', true)).toBe(true);
    expect(sb.brandingVisible('estate_sale_company', undefined)).toBe(true); // default true
  });
  test('2/4/5. private / unknown / branding-off sellers are NOT visible (fail closed)', () => {
    expect(sb.brandingVisible('private', true)).toBe(false);
    expect(sb.brandingVisible('other', true)).toBe(false);
    expect(sb.brandingVisible(null, true)).toBe(false);      // missing type
    expect(sb.brandingVisible(undefined, true)).toBe(false);
    expect(sb.brandingVisible('business', false)).toBe(false); // branding disabled
  });
  test('3/6/7. the endpoint enforces the branding gate in the WHERE (hidden identity never selected) → 404', () => {
    expect(endpoint).toMatch(/brandingVisibleSql\('sp\.seller_type', 'sp\.show_branding_to_buyers'\)/);
    expect(endpoint).toMatch(/if \(!rows\.length\) return res\.status\(404\)/);
  });
  test('brandingVisibleSql only passes professional types with the preference on', () => {
    const p = sb.brandingVisibleSql('sp.seller_type', 'sp.show_branding_to_buyers');
    expect(p).toContain("'auction_house'");
    expect(p).toContain("'business'");
    expect(p).toContain('COALESCE(sp.show_branding_to_buyers, true)');
    expect(p).not.toContain("'private'");
    expect(p).not.toContain("'other'");
  });
  test('8. no public page consumes the endpoint (a 404 breaks no UI)', () => {
    // Grep guard: the public bundle never calls /api/public/sellers/:id/profile.
    const hits = fs.readdirSync(path.join(__dirname, '..', 'public'))
      .filter((f) => f.endsWith('.html'))
      .filter((f) => read('public', f).includes('/api/public/sellers/'));
    expect(hits).toEqual([]);
  });
});

describe('GAP-3 — public professional profile requires an APPROVED professional type, fail closed', () => {
  const src = read('src', 'routes', 'public.js');
  const route = src.slice(src.indexOf("router.get('/professionals/:slug'"), src.indexOf("// ── POST /api/public/feedback"));

  test('9/13. approved professional types (incl. appraiser) resolve a profile', () => {
    expect(schema.professionalTypesFrom(['appraiser'])).toEqual(['appraiser']);
    expect(schema.professionalTypesFrom(['auction_house'])).toEqual(['auction_house']);
    expect(schema.professionalTypesFrom(['estate_sale_company'])).toEqual(['estate_sale_company']);
  });
  test('10/11/12. individual / platform-only / unknown / system orgs resolve NO professional type → 404', () => {
    expect(schema.professionalTypesFrom(['events', 'organizations', 'widgets'])).toEqual([]); // individual estate-sale org
    expect(schema.professionalTypesFrom([])).toEqual([]);   // unknown / no caps
    expect(schema.professionalTypesFrom(['imports', 'widgets'])).toEqual([]); // importer/system-ish
  });
  test('the route 404s when no approved professional type is present', () => {
    expect(route).toMatch(/if \(!types\.length\) return res\.status\(404\)/);
    expect(route).toMatch(/professionalTypesFrom\(/);
  });
  test('16. approved professional path still builds the profile view (no regression)', () => {
    expect(route).toMatch(/buildProfileView\(org, types\)/);
  });
});

describe('centralized identity policy — endpoints do not invent their own rules', () => {
  test('sellerBranding (auctions) + organizerPrivacy (events) + professionalProfileSchema (profiles) are the 3 authoritative sources', () => {
    expect(typeof sb.brandingVisible).toBe('function');
    expect(typeof sb.brandingVisibleSql).toBe('function');
    expect(typeof require('../src/lib/organizerPrivacy').isPublicOrganizer).toBe('function');
    expect(typeof schema.professionalTypesFrom).toBe('function');
    // the approved professional-profile type allowlist is a single map (never re-listed ad hoc)
    for (const t of ['appraiser', 'auction_house', 'estate_sale_company', 'professional_liquidator', 'consignment_company', 'moving_company', 'cleanout_company'])
      expect(schema.PROFESSIONAL_TYPES[t]).toBeTruthy();
  });
});
