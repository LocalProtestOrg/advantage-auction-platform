'use strict';

/**
 * Buyer privacy / seller branding policy. Private/other/unknown sellers are ALWAYS anonymous to
 * buyers; professional/business sellers may show branding only when show_branding_to_buyers=true.
 * Enforced at the API layer (buyer feeds never even select hidden identity). Directory unchanged.
 */

const fs = require('fs');
const path = require('path');
const b = require('../../src/lib/sellerBranding');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

describe('brandingVisible — eligibility rules', () => {
  const cases = [
    ['private', true, false], ['private', false, false],
    ['other', true, false], ['other', false, false],
    [null, true, false], [undefined, true, false], ['bogus', true, false], ['', true, false],
    ['auction_house', true, true], ['auction_house', false, false],
    ['estate_sale_company', true, true], ['estate_sale_company', false, false],
    ['professional_liquidator', true, true], ['professional_liquidator', false, false],
    ['business', true, true], ['business', false, false],
    ['business', undefined, true], // default (no explicit pref) → visible for professionals
  ];
  for (const [type, pref, exp] of cases) {
    test(`${type} / pref=${pref} → ${exp}`, () => expect(b.brandingVisible(type, pref)).toBe(exp));
  }
  test('the preference can NEVER make a private/other/unknown seller visible', () => {
    for (const t of ['private', 'other', null, undefined, 'bogus', ''])
      expect(b.brandingVisible(t, true)).toBe(false);
  });
});

describe('scrubSellerIdentity — nulls identity when not visible; keeps it when visible', () => {
  const idFields = { seller_display_name: 'Jane Doe Estate', seller_logo_url: 'x.png', seller_location_label: 'Nashville', seller_bio: 'bio', seller_profile_id: 'sp-1' };
  test('private seller → all identity nulled, preference flag stripped', () => {
    const row = b.scrubSellerIdentity(Object.assign({ seller_type: 'private', show_branding_to_buyers: true }, idFields));
    for (const f of Object.keys(idFields)) expect(row[f]).toBeNull();
    expect(row).not.toHaveProperty('show_branding_to_buyers');
  });
  test('professional + enabled → identity preserved', () => {
    const row = b.scrubSellerIdentity(Object.assign({ seller_type: 'auction_house', show_branding_to_buyers: true }, idFields));
    expect(row.seller_display_name).toBe('Jane Doe Estate');
    expect(row.seller_logo_url).toBe('x.png');
  });
  test('professional + disabled → identity nulled (behaves private)', () => {
    const row = b.scrubSellerIdentity(Object.assign({ seller_type: 'business', show_branding_to_buyers: false }, idFields));
    expect(row.seller_display_name).toBeNull();
  });
  test('unknown type → anonymous even with preference true', () => {
    const row = b.scrubSellerIdentity(Object.assign({ seller_type: 'weird', show_branding_to_buyers: true }, idFields));
    expect(row.seller_display_name).toBeNull();
  });
});

describe('brandedColSql — SQL gate matches brandingVisible', () => {
  test('emits a CASE gated on professional types AND the preference', () => {
    const sql = b.brandedColSql('sp.display_name');
    expect(sql).toContain('CASE WHEN');
    expect(sql).toContain("IN ('auction_house','estate_sale_company','professional_liquidator','business')");
    expect(sql).toContain('COALESCE(sp.show_branding_to_buyers, true)');
    expect(sql).toContain('ELSE NULL END');
  });
});

describe('API layer applies the policy on every buyer-facing feed', () => {
  const pub = read('src', 'routes', 'public.js');
  const sellers = read('src', 'routes', 'sellers.js');
  test('public.js buyer feeds use the branded seller columns (not raw sp.display_name)', () => {
    expect(pub).toContain("require('../lib/sellerBranding')");
    // every buyer-facing seller identity column is the branded expression
    expect(pub).toContain('${B_NAME}    AS seller_display_name');
    expect(pub).toContain('${B_LOGO}');
    expect(pub).toContain('${B_BIO}');
    expect(pub).toContain('${B_PROFILE_ID}');
    // the auction/lot feeds must not select the raw identity column any more
    expect(pub).not.toMatch(/sp\.display_name\s+AS seller_display_name/);
    expect(pub).not.toMatch(/sp\.bio\s+AS seller_bio/);
  });
  test('public company DIRECTORY (/marketplace) is intentionally left unchanged', () => {
    // the directory still selects sp.logo_url directly (discovery product, not scrubbed)
    const mkt = pub.slice(pub.indexOf("router.get('/marketplace'"), pub.indexOf("router.get('/marketplace/'") > 0 ? pub.indexOf("router.get('/marketplace/'") : pub.indexOf("router.get('/marketplace'") + 2000);
    expect(mkt).toContain('sp.logo_url AS seller_logo_url');
  });
  test('buyer following endpoint: no personal email; name is branded only', () => {
    const foll = sellers.slice(sellers.indexOf("router.get('/following'"), sellers.indexOf("router.get('/following'") + 900);
    expect(foll).not.toContain('u.email');
    expect(foll).not.toContain('seller_email');
    expect(foll).toContain("brandedColSql('sp.display_name')");
  });
});

describe('professional-only branding preference (settings) — server authoritative', () => {
  const sellers = read('src', 'routes', 'sellers.js');
  test('GET /me returns branding_eligible (professional-only)', () => {
    expect(sellers).toContain('show_branding_to_buyers');
    expect(sellers).toContain('branding_eligible = isProfessional');
  });
  test('PATCH /me/branding rejects non-professional sellers (403), never exposing them', () => {
    const patch = sellers.slice(sellers.indexOf("patch('/me/branding'"), sellers.indexOf("patch('/me/branding'") + 900);
    expect(patch).toContain('isProfessional(sp.seller_type)');
    expect(patch).toContain('BRANDING_NOT_ELIGIBLE');
    expect(patch).toContain('403');
  });
});

describe('frontend never renders empty / "by null" seller content', () => {
  test('components guard seller render on a present name', () => {
    expect(read('public', 'marketplace-components.js')).toContain('if (auction.seller_display_name)');
    expect(read('public', 'widgets', 'featured-near-you.js')).toContain('a.seller_display_name');
    expect(read('public', 'seller-pilot.html')).toContain('if (auction.seller_display_name)');
    const shell = read('public', 'widgets', 'shared', 'member-shell.js');
    expect(shell).toMatch(/if \(nm\)/); // Following tab only overrides the generic label when a name exists
  });
  test('shell Account exposes the branding toggle only to eligible professional sellers', () => {
    const shell = read('public', 'widgets', 'shared', 'member-shell.js');
    expect(shell).toContain('Display company branding to buyers');
    expect(shell).toContain('/api/sellers/me/branding');
    expect(shell).toContain('if (!d || !d.branding_eligible) return');
  });
});
