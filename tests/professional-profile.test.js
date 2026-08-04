'use strict';

/**
 * Phase 3 — reusable Professional Profile experience. Behavioral tests for the shared schema module
 * (validation, completeness, type-gated view) + source-level assertions for the API, editor, and
 * public view. No Stripe/checkout/subscription/event changes. No real DB/network.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const S = require('../src/lib/professionalProfileSchema');

describe('schema — validation + coercion', () => {
  test('sanitizeProfileData keeps only whitelisted keys and coerces by type', () => {
    const out = S.sanitizeProfileData({
      tagline: 'x', appraisal_types: ['Jewelry', 'Coins'], insurance_appraisals: 'true',
      years_experience: '12', gallery: ['a', 'b'], evil_key: 'nope', published: true,
    });
    expect(out.tagline).toBe('x');
    expect(out.appraisal_types).toEqual(['Jewelry', 'Coins']);
    expect(out.insurance_appraisals).toBe(true);
    expect(out.years_experience).toBe(12);
    expect(out.gallery).toEqual(['a', 'b']);
    expect(out.published).toBe(true);
    expect('evil_key' in out).toBe(false);
  });
  test('non-object input yields {}', () => { expect(S.sanitizeProfileData(null)).toEqual({}); });
});

describe('schema — reusable across professional types (section gating)', () => {
  test('appraiser section only applies to appraiser type', () => {
    const forApp = S.sectionsForTypes(['appraiser']).map((s) => s.id);
    const forMover = S.sectionsForTypes(['moving_company']).map((s) => s.id);
    expect(forApp).toContain('appraiser');
    expect(forMover).not.toContain('appraiser');
    // general/credentials/trust/social/seo apply to ALL types
    ['general', 'credentials', 'trust', 'social', 'seo'].forEach((id) => {
      expect(forApp).toContain(id); expect(forMover).toContain(id);
    });
  });
  test('professionalTypesFrom filters capability keys to professional types', () => {
    expect(S.professionalTypesFrom(['appraiser', 'events', 'auctions', 'moving_company']))
      .toEqual(['appraiser', 'moving_company']);
  });
});

describe('schema — completeness', () => {
  test('empty profile is low, filled profile is higher, capped 0..100', () => {
    const empty = S.completeness({ name: '' }, {}, ['appraiser']);
    const filled = S.completeness(
      { name: 'A', description: 'd', logo_url: 'l', contact_phone: 'p', contact_email: 'e', city: 'c', state: 's' },
      { tagline: 't', bio: 'b', appraisal_types: ['Jewelry'], certifications: ['ASA'], insurance_appraisals: true },
      ['appraiser']);
    expect(empty).toBeGreaterThanOrEqual(0);
    expect(filled).toBeGreaterThan(empty);
    expect(filled).toBeLessThanOrEqual(100);
  });
});

describe('schema — public view builder (no internal leak)', () => {
  const org = {
    slug: 'ace', name: 'Ace', description: 'short', city: 'Houston', state: 'TX',
    logo_url: 'L', cover_image_url: 'C', contact_phone: '555', contact_email: 'a@b.com', website_url: 'http://x',
    verification_status: 'verified',
    // internal columns that must NEVER surface:
    bd_metadata: { secret: 1 }, crm_stage: 'lead', health_score: 88, verified_by: 'admin-uuid',
    profile_data: { tagline: 'T', bio: 'B', appraisal_types: ['Jewelry'], insurance_appraisals: true, facebook: 'http://fb', published: true },
  };
  const v = S.buildProfileView(org, ['appraiser']);
  test('emits header/contact/sections/social from the profile', () => {
    expect(v.header.category).toBe('Appraiser');
    expect(v.header.verified).toBe(true);
    expect(v.contact.phone).toBe('555');
    expect(v.sections.some((s) => s.title === 'Appraisal Services')).toBe(true);
    expect(v.social.some((s) => s.network === 'Facebook')).toBe(true);
    expect(v.published).toBe(true);
  });
  test('never includes internal/admin columns', () => {
    const json = JSON.stringify(v);
    ['bd_metadata', 'crm_stage', 'health_score', 'verified_by', 'secret'].forEach((k) => expect(json).not.toContain(k));
  });
});

describe('migration 104 — additive profile fields', () => {
  const mig = read('db', 'migrations', '104_organization_profile_fields.sql');
  test('adds cover_image_url + profile_data JSONB (idempotent) and a published index', () => {
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS cover_image_url TEXT/);
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS profile_data JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    expect(mig).toMatch(/idx_organizations_profile_published/);
    const sql = mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'); // executable SQL only
    expect(sql).not.toMatch(/users\.role|DROP |ALTER COLUMN|DELETE |UPDATE /i);
  });
});

describe('API — /api/org/profile extended (reuses existing editor endpoint)', () => {
  const org = read('src', 'routes', 'orgEvents.js');
  const svc = read('src', 'services', 'organizationsService.js');
  const pub = read('src', 'routes', 'public.js');
  test('serializer exposes description + cover + profile_data', () => {
    expect(org).toMatch(/description: o\.description \|\| ''/);
    expect(org).toMatch(/cover_image_url: o\.cover_image_url \|\| null/);
    expect(org).toMatch(/profile_data: o\.profile_data \|\| \{\}/);
  });
  test('update whitelist maps shortDescription + coverUrl', () => {
    expect(org).toMatch(/shortDescription: 'description'/);
    expect(org).toMatch(/coverUrl: 'cover_image_url'/);
  });
  test('GET returns professional_types, completeness, preview; schema endpoint exists', () => {
    expect(org).toMatch(/router\.get\('\/profile-schema'/);
    expect(org).toMatch(/professional_types: types/);
    expect(org).toMatch(/preview: profileSchema\.buildProfileView/);
  });
  test('POST persists validated + merged profile_data', () => {
    expect(org).toMatch(/profileSchema\.sanitizeProfileData\(b\.profileData\)/);
    expect(org).toMatch(/Object\.assign\(\{\}, existing, profileSchema\.sanitizeProfileData/);
  });
  test('service allows profile_data as a JSONB cast (never role/plan/verification)', () => {
    expect(svc).toMatch(/'description', 'cover_image_url', 'profile_data'/);
    expect(svc).toMatch(/profile_data = \$\$\{vals\.length\}::jsonb/);
  });
  test('public professional view is published-gated + reuses the shared builder', () => {
    expect(pub).toMatch(/router\.get\('\/professionals\/:slug'/);
    expect(pub).toMatch(/\(profile_data->>'published'\) = 'true'/);
    expect(pub).toMatch(/buildProfileView/);
  });
});

describe('editor page — Upload (not URL), reusable, correct buttons', () => {
  const htmlShell = read('public', 'org', 'profile.html');
  const editor = read('public', 'org', 'profile-editor.js');
  test('the editor replaces "Logo URL" with an Upload control', () => {
    expect(htmlShell).not.toContain('Logo URL');
    expect(editor).not.toContain('Logo URL');
    expect(editor).toMatch(/Upload /); // image tiles read "＋ Upload <label>"
    expect(editor).toMatch(/ORG\.uploadImage/);
  });
  test('buttons read "Save Profile" and "Preview Public Profile" (never a bare "Save")', () => {
    expect(editor).toContain('Save Profile');
    expect(editor).toContain('Preview Public Profile');
    expect(editor).not.toMatch(/>Save<\/button>/);
  });
  test('one editor, schema-driven (no per-type editor pages)', () => {
    expect(htmlShell).toMatch(/profile-editor\.js/);
    expect(editor).toMatch(/\/api\/org\/profile-schema/);
    expect(editor).toMatch(/visibleSections/);
  });
  test('a11y: inputs are labelled + live-region status', () => {
    expect(htmlShell).toMatch(/aria-live="polite"/);
    expect(editor).toMatch(/for="' \+ lid \+ '"/); // <label for> tied to input id
  });
});

describe('public view page — cross-link + structured data', () => {
  const pro = read('public', 'pro.html');
  test('renders the shared view model with an Edit cross-link in preview', () => {
    expect(pro).toMatch(/\/api\/public\/professionals\//);
    expect(pro).toMatch(/preview.*===.*'1'|preview'\) === '1'/);
    expect(pro).toContain('Edit Profile');
    expect(pro).toMatch(/href="\/org\/profile\.html"/);
  });
  test('emits JSON-LD structured data and is noindex for now', () => {
    expect(pro).toMatch(/application\/ld\+json/);
    expect(pro).toMatch(/<meta name="robots" content="noindex"/);
  });
});

describe('scope guard — no billing/checkout/subscription/event changes', () => {
  test('profile work does not touch appraiser billing or Stripe', () => {
    const editor = read('public', 'org', 'profile-editor.js');
    const pub = read('src', 'routes', 'public.js');
    [editor, pub].forEach((f) => expect(f).not.toMatch(/checkout-session|billing-portal|stripe|subscription/i));
    // appraiser membership service is unchanged by Phase 3 (no profile-schema import there)
    expect(read('src', 'services', 'appraiserMembershipService.js')).not.toMatch(/professionalProfileSchema/);
  });
});
