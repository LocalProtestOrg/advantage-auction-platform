'use strict';

/**
 * Phase 3 (+ acceptance polish) — reusable Professional Profile experience. Behavioral tests for the
 * shared schema module + source-level assertions for the nav, editor, uploads, trust-signal
 * suppression, publication gating, public view, and footer. No Stripe/checkout/subscription/event
 * changes. No real DB/network.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const S = require('../src/lib/professionalProfileSchema');

// customer-facing copy strings from the schema (labels/hints/placeholders/guidance/options/suggestions)
function schemaCopy() {
  const out = [];
  S.SECTIONS.forEach((s) => {
    out.push(s.title);
    s.fields.forEach((f) => {
      ['label', 'hint', 'placeholder', 'guidance'].forEach((k) => { if (f[k]) out.push(f[k]); });
      (f.options || []).forEach((o) => out.push(o[1]));
      (f.suggestions || []).forEach((x) => out.push(x));
    });
  });
  return out;
}

describe('schema — regrouped sections + approved copy', () => {
  test('sections match the approved groups', () => {
    expect(S.SECTIONS.map((s) => s.title)).toEqual([
      'General Information', 'About Your Business', 'Service Area', 'Appraisal Services',
      'Credentials and Experience', 'Contact and Availability', 'Trust and Media', 'Social Links', 'Search Appearance']);
  });
  test('no em dashes in customer copy; no readability slashes in labels', () => {
    schemaCopy().forEach((s) => expect(s).not.toContain('—')); // em dash — all copy
    // labels/titles/option-labels must not use "A / B" (URLs in placeholders/hints are fine)
    const labels = [];
    S.SECTIONS.forEach((s) => { labels.push(s.title); s.fields.forEach((f) => { labels.push(f.label); (f.options || []).forEach((o) => labels.push(o[1])); }); });
    labels.forEach((l) => expect(l).not.toMatch(/\s\/\s|\w\/\w/));
    expect(labels).toContain('Offers Virtual or Online Services');
    expect(labels).toContain('Cover Image');
  });
});

describe('schema — validation + moderation-gated publication', () => {
  test('published is NEVER user-writable; review_status is', () => {
    expect(S.profileDataKeys().has('published')).toBe(false);
    expect(S.profileDataKeys().has('review_status')).toBe(true);
    const out = S.sanitizeProfileData({ published: true, review_status: 'submitted', tagline: 'x', evil: 1 });
    expect('published' in out).toBe(false);
    expect(out.review_status).toBe('submitted');
    expect('evil' in out).toBe(false);
  });
  test('review_status coerces to a safe enum', () => {
    expect(S.sanitizeProfileData({ review_status: 'garbage' }).review_status).toBe('draft');
  });
});

describe('schema — completeness does not require optional fields', () => {
  test('100% is reachable without social links or most credentials', () => {
    const org = { name: 'A', description: 'd', logo_url: 'l', cover_image_url: 'c', contact_phone: 'p', contact_email: 'e@x.co', website_url: 'w', city: 'H', state: 'TX' };
    const pd = {
      tagline: 't', bio: 'b', service_area: 'sa', states_served: ['TX'],
      appraisal_types: ['Jewelry'], certifications: ['ASA'], years_experience: 10,
      insurance_appraisals: true, written_reports: true, years_in_business: 12, gallery: ['g'],
      // deliberately NO facebook/instagram/etc, NO associations/licenses/awards/education/memberships
    };
    expect(S.completeness(org, pd, ['appraiser'])).toBe(100);
  });
});

describe('schema — public view (honest trust, no leak, empty suppression)', () => {
  const base = {
    slug: 'ace', name: 'Ace', description: 'short', city: 'Houston', state: 'TX',
    logo_url: 'L', cover_image_url: 'C', contact_phone: '555', contact_email: 'a@b.com', website_url: 'http://x',
    bd_metadata: { secret: 1 }, crm_stage: 'lead', health_score: 88, verified_by: 'x',
    profile_data: { tagline: 'T', bio: 'B', appraisal_types: ['Jewelry'], insurance_appraisals: true, facebook: 'http://fb' },
  };
  test('verified reflects ONLY real verification_status', () => {
    expect(S.buildProfileView(Object.assign({}, base, { verification_status: 'verified' }), ['appraiser']).header.verified).toBe(true);
    expect(S.buildProfileView(Object.assign({}, base, { verification_status: 'community' }), ['appraiser']).header.verified).toBe(false);
    expect(S.buildProfileView(Object.assign({}, base, { verification_status: 'unverified' }), ['appraiser']).header.verified).toBe(false);
  });
  test('empty sections/arrays are omitted', () => {
    const v = S.buildProfileView({ slug: 's', name: 'N', verification_status: 'unverified', profile_data: {} }, ['appraiser']);
    expect(v.sections).toEqual([]);
    expect(v.gallery).toEqual([]);
    expect(v.social).toEqual([]);
    expect(v.about).toBe('');
  });
  test('never leaks internal/admin columns', () => {
    const json = JSON.stringify(S.buildProfileView(Object.assign({}, base, { verification_status: 'community' }), ['appraiser']));
    ['bd_metadata', 'crm_stage', 'health_score', 'verified_by', 'secret'].forEach((k) => expect(json).not.toContain(k));
  });
});

describe('nav + editor', () => {
  const portal = read('public', 'org', 'portal.js');
  const shell = read('public', 'org', 'profile.html');
  const editor = read('public', 'org', 'profile-editor.js');
  const css = read('public', 'org', 'profile.css');
  test('navigation label reads "Professional Profile" (not Organization)', () => {
    expect(portal).toMatch(/'profile', 'Professional Profile', '\/org\/profile\.html'/);
    expect(portal).not.toMatch(/'profile', 'Organization'/);
  });
  test('no "Logo URL" anywhere; explicit Upload controls exist', () => {
    [shell, editor].forEach((f) => expect(f).not.toContain('Logo URL'));
    expect(editor).toMatch(/Upload ' \+ esc\(f\.label\)/); // "Upload Logo" / "Upload Cover Image"
    expect(editor).toMatch(/ORG\.uploadImage/);
  });
  test('uploaded images get explicit Replace + Remove controls (not only a ×) with aria-labels', () => {
    expect(editor).toMatch(/'Replace ' \+ f\.label/);
    expect(editor).toMatch(/'Remove ' \+ f\.label/);
    expect(editor).toMatch(/setAttribute\('aria-label', 'Replace ' \+ f\.label\)/);
    expect(editor).toMatch(/class="pbar"/); // upload progress indicator
    expect(editor).toMatch(/up-err/); // error state
  });
  test('buttons read "Save Profile" / "Preview Public Profile" (never a bare Save)', () => {
    expect(editor).toContain('Save Profile');
    expect(editor).toContain('Preview Public Profile');
    expect(editor).not.toMatch(/>Save<\/button>/);
  });
  test('live preview shows NO placeholder stars and only real verification', () => {
    expect(editor).not.toMatch(/★/);
    expect(editor).toMatch(/S\.verified \? ' <span class="vf">Verified/); // badge gated on real verification
    expect(editor).toMatch(/New profile/); // neutral review state
  });
  test('completeness suggestions scroll to the field + clarify publication is separate', () => {
    expect(editor).toMatch(/class="jump" data-k=/);
    expect(editor).toMatch(/scrollIntoView/);
    expect(editor).toMatch(/Directory listing is approved separately/);
  });
  test('publication is Submit for Review, not self-publish', () => {
    expect(editor).toMatch(/Submit Profile for Review/);
    expect(editor).toMatch(/review_status = 'submitted'/);
    expect(editor).not.toMatch(/List my profile publicly/);
  });
  test('layout: form-first grid, stacks at tablet, safe sticky, no overflow', () => {
    expect(css).toMatch(/grid-template-columns:minmax\(0,1fr\) 300px/);
    expect(css).toMatch(/@media\(max-width:1080px\)\{\.pp-grid\{grid-template-columns:1fr\}/);
    expect(css).toMatch(/\.pp-preview\{position:sticky;top:74px;max-height:calc\(100vh - 96px\)/);
    expect(css).toMatch(/overflow-wrap:anywhere/);
  });
  test('a11y: labels tied to inputs + live-region status', () => {
    expect(shell).toMatch(/aria-live="polite"/);
    expect(editor).toMatch(/for="' \+ lid \+ '"/);
  });
});

describe('public view page — honest hero, type-aware actions, footer', () => {
  const pro = read('public', 'pro.html');
  test('no placeholder stars; Verified only when real', () => {
    expect(pro).not.toMatch(/★/);
    expect(pro).toMatch(/h\.verified \? '<div class="vf">✓ Verified/);
    expect(pro).toMatch(/New Profile/);
  });
  test('contact actions use explicit, type-aware labels and hide when absent', () => {
    expect(pro).toMatch(/Call '\+esc\(cat\)/);
    expect(pro).toMatch(/Email '\+esc\(cat\)/);
    expect(pro).toContain('Visit Website');
    expect(pro).toMatch(/if\(c\.phone\)/);
    expect(pro).toMatch(/rel="nofollow noopener noreferrer"/);
  });
  test('empty contact card is suppressed; logo falls back to initials (no gray blank)', () => {
    expect(pro).toMatch(/var contactCard = rows \? /);
    expect(pro).toMatch(/initials\(h\.name\)/);
  });
  test('preview mode is labelled "Profile Preview"; public 404 is handled', () => {
    expect(pro).toMatch(/Profile Preview/);
    expect(pro).toMatch(/has not been published/);
    expect(pro).toMatch(/<meta name="robots" content="noindex"/);
  });
  test('uses the shared public footer treatment with approved links (no BD dependency)', () => {
    expect(pro).toMatch(/footer class="site"/);
    expect(pro).toMatch(/\/privacy\.html/);
    expect(pro).toMatch(/\/terms\.html/);
    expect(pro).not.toMatch(/advantage\.bid\/[a-z]/); // no BD runtime links
  });
  test('no em dashes in customer copy (comments stripped)', () => {
    const noComments = pro.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
    expect(noComments).not.toContain('—');
  });
});

describe('API — publication gate + reuse (unchanged endpoints)', () => {
  const pub = read('src', 'routes', 'public.js');
  const org = read('src', 'routes', 'orgEvents.js');
  test('public professional view is published-gated and reuses the shared builder', () => {
    expect(pub).toMatch(/\(profile_data->>'published'\) = 'true'/);
    expect(pub).toMatch(/buildProfileView/);
  });
  test('POST persists sanitized profile_data (published can never be set through it)', () => {
    expect(org).toMatch(/profileSchema\.sanitizeProfileData\(b\.profileData\)/);
  });
});

describe('scope guard — BD appraisers + billing untouched', () => {
  test('no Phase 3 code references bd_import, and none touches billing/checkout/subscription', () => {
    const files = ['public/org/profile-editor.js', 'public/pro.html', 'src/lib/professionalProfileSchema.js', 'src/routes/orgEvents.js'];
    files.forEach((rel) => {
      const f = read(...rel.split('/'));
      expect(f).not.toMatch(/bd_import/);
      expect(f).not.toMatch(/checkout-session|billing-portal|\bstripe\b|subscription/i);
    });
    expect(read('src', 'services', 'appraiserMembershipService.js')).not.toMatch(/professionalProfileSchema/);
  });
});
