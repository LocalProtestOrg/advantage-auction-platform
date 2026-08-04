'use strict';

/**
 * Professional Profile schema — the SINGLE source of truth for the reusable professional profile
 * experience (Phase 3). Drives: the editor form rendering, server-side validation of profile_data,
 * completeness, and the public profile view. Adding a professional type = add its capability key to a
 * section's `applies` list (or add a section) — no new editor, no per-type code paths.
 *
 * Persistence:
 *   CORE fields → existing organizations COLUMNS (name, description, contact_email, contact_phone,
 *     website_url, logo_url, cover_image_url, city, state). Everything else → organizations.profile_data.
 *
 * Types → stored shape: text|textarea|tel|email|url|select|hours → string; number → number;
 *   chips|states|gallery → string[]; toggle → boolean; image → string(url); toggle-group → booleans.
 *
 * Publication is moderation-gated: the user can only set review_status ('draft'|'submitted'); the
 * `published` flag is NOT user-writable (admin/moderation only) so a paid signup can never make
 * itself directory-visible by a checkbox. Completeness never counts optional fields (weight 0).
 */

const PROFESSIONAL_TYPES = {
  appraiser: { label: 'Appraiser', singular: 'Appraiser' },
  auction_house: { label: 'Auction House', singular: 'Auction House' },
  estate_sale_company: { label: 'Estate Sale Company', singular: 'Estate Sale Company' },
  professional_liquidator: { label: 'Professional Liquidator', singular: 'Liquidator' },
  consignment_company: { label: 'Consignment Company', singular: 'Consignment Company' },
  moving_company: { label: 'Moving Company', singular: 'Mover' },
  cleanout_company: { label: 'Clean-out Company', singular: 'Clean-out Company' },
};

const APPRAISAL_TYPES = ['Antiques', 'Asian Art', 'Books', 'Coins', 'Commercial Assets', 'Fine Art', 'Firearms',
  'Furniture', 'General Household', 'Jewelry', 'Mid Century', 'Military', 'Sports Memorabilia', 'Toys', 'Watches'];
const CERTS = ['ASA', 'ISA', 'AAA', 'USPAP', 'Other'];
const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND',
  'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];

// Core fields (persisted to columns). key → column.
const CORE_COLUMNS = {
  name: 'name', short_description: 'description', phone: 'contact_phone', email: 'contact_email',
  website: 'website_url', logo: 'logo_url', cover: 'cover_image_url', city: 'city', state: 'state',
};
// profile_data keys the user may set beyond the rendered fields (never `published`).
const EXTRA_WRITABLE = ['review_status'];

const SECTIONS = [
  {
    id: 'general', title: 'General Information', applies: 'all',
    fields: [
      { key: 'logo', label: 'Logo', type: 'image', core: true, weight: 3, guidance: 'Square, at least 400 by 400 pixels.' },
      { key: 'cover', label: 'Cover Image', type: 'image', core: true, weight: 1, guidance: 'Wide landscape, about 1600 by 600 pixels.' },
      { key: 'name', label: 'Business Name', type: 'text', core: true, required: true, weight: 3, max: 120 },
      { key: 'tagline', label: 'Business Tagline', type: 'text', weight: 1, max: 140, placeholder: 'A short line that sums up what you do' },
    ],
  },
  {
    id: 'about', title: 'About Your Business', applies: 'all',
    fields: [
      { key: 'short_description', label: 'Short Description', type: 'textarea', core: true, weight: 2, max: 400, hint: 'One or two sentences shown on cards and previews.' },
      { key: 'bio', label: 'Full Biography', type: 'textarea', weight: 2, max: 4000 },
    ],
  },
  {
    id: 'service', title: 'Service Area', applies: 'all',
    fields: [
      { key: 'service_area', label: 'Primary Service Area', type: 'text', weight: 1, placeholder: 'e.g. Greater Houston, Texas' },
      { key: 'states_served', label: 'States Served', type: 'states', weight: 1, placeholder: 'Add a state and press Enter' },
      { key: 'city', label: 'City', type: 'text', core: true, weight: 1 },
      { key: 'state', label: 'State', type: 'text', core: true, weight: 1 },
      { key: 'office_address', label: 'Business Address', type: 'text', weight: 0, hint: 'Optional. Add this only if customers should visit your location.' },
      { key: 'virtual_services', label: 'Offers Virtual or Online Services', type: 'toggle', weight: 0 },
    ],
  },
  {
    id: 'appraiser', title: 'Appraisal Services', applies: ['appraiser'],
    fields: [
      { key: 'appraisal_types', label: 'Appraisal Types', type: 'chips', weight: 3, suggestions: APPRAISAL_TYPES },
      { key: 'certifications', label: 'Professional Credentials', type: 'chips', weight: 2, suggestions: CERTS,
        hint: 'Add only credentials you actually hold.' },
      { key: 'years_experience', label: 'Years of Experience', type: 'number', weight: 1 },
      { key: 'appraisal_purposes', label: 'Appraisal Purposes', type: 'toggle-group', weight: 2, options: [
        ['insurance_appraisals', 'Insurance'], ['estate_appraisals', 'Estate'], ['donation_appraisals', 'Donation'],
        ['divorce_appraisals', 'Divorce'], ['bankruptcy_appraisals', 'Bankruptcy'], ['probate_appraisals', 'Probate'],
        ['fair_market_value', 'Fair Market Value'], ['replacement_value', 'Replacement Value'] ] },
      { key: 'appraisal_options', label: 'Options', type: 'toggle-group', weight: 1, options: [
        ['written_reports', 'Written Reports'], ['remote_appraisals', 'Remote Appraisals'], ['travel_available', 'Travel Available'],
        ['appointment_required', 'Appointment Required'], ['free_consultation', 'Free Initial Consultation'] ] },
    ],
  },
  {
    id: 'credentials', title: 'Credentials and Experience', applies: 'all',
    fields: [
      { key: 'years_in_business', label: 'Years in Business', type: 'number', weight: 1 },
      { key: 'owner_name', label: 'Owner or Lead', type: 'text', weight: 0, max: 120, hint: 'Optional.' },
      { key: 'languages', label: 'Languages', type: 'chips', weight: 0 },
      { key: 'associations', label: 'Professional Associations', type: 'chips', weight: 0 },
      { key: 'licenses', label: 'Licenses', type: 'chips', weight: 0 },
      { key: 'awards', label: 'Awards', type: 'chips', weight: 0 },
      { key: 'education', label: 'Education', type: 'chips', weight: 0 },
      { key: 'memberships', label: 'Memberships', type: 'chips', weight: 0 },
    ],
  },
  {
    id: 'contact', title: 'Contact and Availability', applies: 'all',
    fields: [
      { key: 'phone', label: 'Business Phone', type: 'tel', core: true, weight: 2 },
      { key: 'email', label: 'Contact Email', type: 'email', core: true, weight: 2 },
      { key: 'website', label: 'Website', type: 'url', core: true, weight: 1, placeholder: 'yourbusiness.com' },
      { key: 'hours', label: 'Business Hours', type: 'textarea', weight: 0, placeholder: 'e.g. Mon to Fri, 9 to 5. Weekends by appointment.' },
    ],
  },
  {
    id: 'trust', title: 'Trust and Media', applies: 'all',
    fields: [
      { key: 'headshot', label: 'Headshot', type: 'image', weight: 0, guidance: 'Optional. A photo of you or your lead.' },
      { key: 'gallery', label: 'Business Photos', type: 'gallery', weight: 1, hint: 'Showcase your work.' },
    ],
  },
  {
    id: 'social', title: 'Social Links', applies: 'all',
    fields: [
      { key: 'facebook', label: 'Facebook', type: 'url', weight: 0, placeholder: 'facebook.com/yourbusiness' },
      { key: 'instagram', label: 'Instagram', type: 'url', weight: 0, placeholder: 'instagram.com/yourbusiness' },
      { key: 'linkedin', label: 'LinkedIn', type: 'url', weight: 0, placeholder: 'linkedin.com/company/yourbusiness' },
      { key: 'youtube', label: 'YouTube', type: 'url', weight: 0 },
      { key: 'tiktok', label: 'TikTok', type: 'url', weight: 0 },
    ],
  },
  {
    id: 'seo', title: 'Search Appearance', applies: 'all',
    fields: [
      { key: 'headline', label: 'Search Headline', type: 'text', weight: 0, max: 160 },
      { key: 'seo_description', label: 'Search Description', type: 'textarea', weight: 0, max: 320 },
      { key: 'keywords', label: 'Service Keywords', type: 'chips', weight: 0 },
    ],
  },
];

// ── derived helpers ──
function flatFields() { return SECTIONS.reduce(function (a, s) { return a.concat(s.fields.map(function (f) { return Object.assign({ section: s.id }, f); })); }, []); }
function profileDataKeys() {
  var keys = new Set(EXTRA_WRITABLE);
  flatFields().forEach(function (f) {
    if (f.core) return;
    if (f.type === 'toggle-group') (f.options || []).forEach(function (o) { keys.add(o[0]); });
    else keys.add(f.key);
  });
  return keys;
}
function keyTypes() {
  var m = { review_status: 'enum' };
  flatFields().forEach(function (f) {
    if (f.type === 'toggle-group') (f.options || []).forEach(function (o) { m[o[0]] = 'boolean'; });
    else if (f.type === 'chips' || f.type === 'states' || f.type === 'gallery') m[f.key] = 'array';
    else if (f.type === 'toggle') m[f.key] = 'boolean';
    else if (f.type === 'number') m[f.key] = 'number';
    else m[f.key] = 'string';
  });
  return m;
}
/** Sanitize client profile_data → whitelisted keys only, coerced by type. `published` is never accepted. */
function sanitizeProfileData(input) {
  var allowed = profileDataKeys(); var types = keyTypes(); var out = {};
  if (!input || typeof input !== 'object') return out;
  Object.keys(input).forEach(function (k) {
    if (!allowed.has(k) || k === 'published') return;
    var v = input[k], t = types[k];
    if (t === 'array') out[k] = Array.isArray(v) ? v.map(function (x) { return String(x).trim(); }).filter(Boolean).slice(0, 60) : [];
    else if (t === 'boolean') out[k] = v === true || v === 'true' || v === 1;
    else if (t === 'number') { var n = Number(v); out[k] = Number.isFinite(n) ? n : null; }
    else if (t === 'enum') out[k] = (v === 'submitted' ? 'submitted' : 'draft');
    else out[k] = v == null ? '' : String(v).slice(0, 8000);
  });
  return out;
}
function sectionsForTypes(typeKeys) {
  var set = new Set(typeKeys || []);
  return SECTIONS.filter(function (s) { return s.applies === 'all' || (s.applies || []).some(function (t) { return set.has(t); }); });
}
function completeness(org, pd, typeKeys) {
  var total = 0, got = 0; pd = pd || {};
  function filled(f) {
    if (f.type === 'toggle-group') return (f.options || []).some(function (o) { return pd[o[0]]; });
    var v = f.core ? org[CORE_COLUMNS[f.key]] : pd[f.key];
    if (f.type === 'chips' || f.type === 'states' || f.type === 'gallery') return Array.isArray(v) && v.length > 0;
    if (f.type === 'toggle') return v === true;
    return v != null && String(v).trim() !== '';
  }
  sectionsForTypes(typeKeys).forEach(function (s) { s.fields.forEach(function (f) {
    var w = f.weight == null ? 1 : f.weight; if (w <= 0) return; total += w; if (filled(f)) got += w;
  }); });
  return total ? Math.round(got / total * 100) : 0;
}
function professionalTypesFrom(capabilityKeys) { return (capabilityKeys || []).filter(function (k) { return PROFESSIONAL_TYPES[k]; }); }
function primaryTypeLabel(typeKeys) { var k = (typeKeys || []).find(function (t) { return PROFESSIONAL_TYPES[t]; }); return k ? PROFESSIONAL_TYPES[k].singular : 'Professional'; }

/** Normalize a credential name to its lookup key (case-insensitive, trimmed). */
function credentialKey(name) { return String(name == null ? '' : name).trim().toUpperCase(); }
/**
 * Claimed credentials (profile_data.certifications) → display list, each flagged verified ONLY when a
 * matching admin record exists in profile_data.verified_credentials. Emits neither admin ids nor
 * timestamps — public-safe. Users cannot influence `verified` (verified_credentials is admin-only).
 */
function credentialView(pd) {
  var claimed = Array.isArray(pd && pd.certifications) ? pd.certifications : [];
  var vc = (pd && pd.verified_credentials && typeof pd.verified_credentials === 'object') ? pd.verified_credentials : {};
  var seen = {};
  return claimed.map(function (c) { return String(c).trim(); }).filter(function (c) { // de-dup, drop empties
    if (!c) return false; var k = credentialKey(c); if (seen[k]) return false; seen[k] = 1; return true;
  }).map(function (c) { return { name: c, verified: !!vc[credentialKey(c)] }; });
}

/**
 * Read-only public view model — used by the public endpoint AND the owner preview so both render
 * identically. Emits ONLY non-empty values (empty sections suppressed downstream). NEVER fabricates
 * trust: `verified` reflects the real organizations.verification_status only; no ratings are emitted.
 */
function buildProfileView(org, typeKeys) {
  var pd = (org && org.profile_data) || {};
  var ne = function (v) { return Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== ''; };
  var sections = [];

  // Details (from Service Area + general Credentials fields)
  var details = [];
  var push = function (label, v, kind) { if (ne(v)) details.push({ label: label, value: v, kind: kind || (Array.isArray(v) ? 'tags' : 'text') }); };
  push('Service Area', pd.service_area);
  push('States Served', pd.states_served);
  push('Years in Business', pd.years_in_business != null ? String(pd.years_in_business) : '');
  push('Owner or Lead', pd.owner_name);
  push('Languages', pd.languages);
  push('Business Hours', pd.hours);
  if (pd.virtual_services === true) details.push({ label: 'Virtual or Online Services', value: 'Available', kind: 'text' });
  // Business Address is shown ONLY when the professional intentionally entered it (never inferred).
  // It is excluded from JSON-LD (city/state remain independent) per the address-privacy policy.
  push('Business Address', pd.office_address);
  if (details.length) sections.push({ id: 'details', title: 'Details', items: details });

  // Appraisal Services
  if ((typeKeys || []).indexOf('appraiser') >= 0) {
    var ap = [];
    if (ne(pd.appraisal_types)) ap.push({ label: 'Appraisal Types', value: pd.appraisal_types, kind: 'tags' });
    // Certifications are rendered in their own "Professional Credentials" section (claimed vs verified) below.
    if (pd.years_experience != null && String(pd.years_experience) !== '') ap.push({ label: 'Years of Experience', value: String(pd.years_experience), kind: 'text' });
    var purposes = [['insurance_appraisals', 'Insurance'], ['estate_appraisals', 'Estate'], ['donation_appraisals', 'Donation'],
      ['divorce_appraisals', 'Divorce'], ['bankruptcy_appraisals', 'Bankruptcy'], ['probate_appraisals', 'Probate'],
      ['fair_market_value', 'Fair Market Value'], ['replacement_value', 'Replacement Value']].filter(function (o) { return pd[o[0]]; }).map(function (o) { return o[1]; });
    if (purposes.length) ap.push({ label: 'Appraisal Purposes', value: purposes, kind: 'tags' });
    var options = [['written_reports', 'Written Reports'], ['remote_appraisals', 'Remote Appraisals'], ['travel_available', 'Travel Available'],
      ['appointment_required', 'Appointment Required'], ['free_consultation', 'Free Initial Consultation']].filter(function (o) { return pd[o[0]]; }).map(function (o) { return o[1]; });
    if (options.length) ap.push({ label: 'Options', value: options, kind: 'tags' });
    if (ap.length) sections.push({ id: 'appraiser', title: 'Appraisal Services', items: ap });
  }

  // Professional Credentials — CLAIMED (user-entered) shown neutrally; only a credential with an
  // admin-approved record in profile_data.verified_credentials shows a "Verified" marker. Users can
  // never set the verified flag (sanitizeProfileData drops verified_credentials). Hidden when none.
  var creds = credentialView(pd);
  if (creds.length) sections.push({ id: 'professional_credentials', title: 'Professional Credentials', items: [{ label: '', value: creds, kind: 'credentials' }] });

  // Credentials
  var cr = [];
  [['associations', 'Professional Associations'], ['licenses', 'Licenses'], ['awards', 'Awards'], ['education', 'Education'], ['memberships', 'Memberships']]
    .forEach(function (o) { if (ne(pd[o[0]])) cr.push({ label: o[1], value: pd[o[0]], kind: 'tags' }); });
  if (cr.length) sections.push({ id: 'credentials', title: 'Credentials', items: cr });

  var socials = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['linkedin', 'LinkedIn'], ['youtube', 'YouTube'], ['tiktok', 'TikTok']]
    .filter(function (o) { return ne(pd[o[0]]); }).map(function (o) { return { network: o[1], url: pd[o[0]] }; });

  return {
    slug: org.slug,
    header: {
      logo: org.logo_url || null, cover: org.cover_image_url || null, headshot: pd.headshot_url || null,
      name: org.name, tagline: pd.tagline || '', category: primaryTypeLabel(typeKeys),
      location: [org.city, org.state].filter(Boolean).join(', '), short_description: org.description || '',
      verified: org.verification_status === 'verified', // REAL verification only — never inferred
    },
    contact: { phone: org.contact_phone || null, email: org.contact_email || null, website: org.website_url || null },
    about: pd.bio || '',
    sections: sections,
    gallery: Array.isArray(pd.gallery) ? pd.gallery : [],
    social: socials,
    seo: { headline: pd.headline || '', description: pd.seo_description || org.description || '', keywords: Array.isArray(pd.keywords) ? pd.keywords : [] },
    published: pd.published === true, review_status: pd.review_status || 'draft',
    professional_types: typeKeys || [],
  };
}

module.exports = {
  SECTIONS, CORE_COLUMNS, PROFESSIONAL_TYPES, APPRAISAL_TYPES, CERTS, US_STATES, EXTRA_WRITABLE,
  flatFields, profileDataKeys, keyTypes, sanitizeProfileData, sectionsForTypes, completeness,
  professionalTypesFrom, primaryTypeLabel, buildProfileView, credentialView, credentialKey,
};
