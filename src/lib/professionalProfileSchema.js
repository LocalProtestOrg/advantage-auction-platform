'use strict';

/**
 * Professional Profile schema — the SINGLE source of truth for the reusable professional profile
 * experience (Phase 3). Drives: the editor form rendering, server-side validation of profile_data,
 * and the public profile view. Adding a new professional type = add its capability key to a section's
 * `applies` list (or add a new section) — no new editor, no per-type code paths.
 *
 * Persistence:
 *   - CORE fields map to existing organizations COLUMNS (name, description, contact_email,
 *     contact_phone, website_url, logo_url, cover_image_url, city, state).
 *   - Every other field is stored in organizations.profile_data (JSONB), keyed by `key`.
 *
 * Field types → stored shape: text|textarea|tel|email|url|select|hours → string; number → number;
 *   chips → string[]; toggle → boolean; image → string(url); gallery → string[].
 *
 * `applies`: 'all' (every professional type) OR an array of capability keys (e.g. ['appraiser']).
 */

// Professional type registry (capability key → display). Extend as new memberships ship.
const PROFESSIONAL_TYPES = {
  appraiser: { label: 'Appraiser', singular: 'Appraiser' },
  auction_house: { label: 'Auction House', singular: 'Auction House' },
  estate_sale_company: { label: 'Estate Sale Company', singular: 'Estate Sale Company' },
  professional_liquidator: { label: 'Professional Liquidator', singular: 'Liquidator' },
  consignment_company: { label: 'Consignment Company', singular: 'Consignment Company' },
  moving_company: { label: 'Moving Company', singular: 'Mover' },
  cleanout_company: { label: 'Clean-out Company', singular: 'Clean-out Company' },
};

const APPRAISAL_TYPES = ['Fine Art', 'Antiques', 'Jewelry', 'Coins', 'Firearms', 'Watches', 'Furniture',
  'Mid Century', 'Asian Art', 'Books', 'Sports Memorabilia', 'Military', 'Toys', 'General Household', 'Commercial Assets'];
const CERTS = ['ASA', 'ISA', 'AAA', 'USPAP', 'Other'];

// Core fields (persisted to columns). key → column.
const CORE_COLUMNS = {
  name: 'name', short_description: 'description', phone: 'contact_phone', email: 'contact_email',
  website: 'website_url', logo: 'logo_url', cover: 'cover_image_url', city: 'city', state: 'state',
};

const SECTIONS = [
  {
    id: 'general', title: 'General Information', applies: 'all',
    fields: [
      { key: 'logo', label: 'Logo', type: 'image', core: true, weight: 3, hint: 'Upload your business logo (square works best).' },
      { key: 'cover', label: 'Cover / Banner Image', type: 'image', core: true, weight: 1, hint: 'A wide banner shown on your public profile.' },
      { key: 'name', label: 'Business Name', type: 'text', core: true, required: true, weight: 3, max: 120 },
      { key: 'tagline', label: 'Business Tagline', type: 'text', weight: 1, max: 140, placeholder: 'A short line that sums up what you do' },
      { key: 'short_description', label: 'Short Description', type: 'textarea', core: true, weight: 2, max: 400, hint: 'One or two sentences shown on cards and previews.' },
      { key: 'bio', label: 'Full Biography / About', type: 'textarea', weight: 2, max: 4000 },
      { key: 'years_in_business', label: 'Years in Business', type: 'number', weight: 1 },
      { key: 'owner_name', label: 'Owner / Lead', type: 'text', weight: 1, max: 120, hint: 'Optional.' },
      { key: 'phone', label: 'Business Phone', type: 'tel', core: true, weight: 2 },
      { key: 'email', label: 'Email', type: 'email', core: true, weight: 2 },
      { key: 'website', label: 'Website', type: 'url', core: true, weight: 1, placeholder: 'https://…' },
      { key: 'service_area', label: 'Service Area', type: 'text', weight: 1, placeholder: 'e.g. Greater Houston, TX' },
      { key: 'states_served', label: 'States Served', type: 'chips', weight: 1, placeholder: 'Add a state and press Enter' },
      { key: 'city', label: 'City', type: 'text', core: true, weight: 1 },
      { key: 'state', label: 'State', type: 'text', core: true, weight: 1 },
      { key: 'office_address', label: 'Office Address', type: 'text', weight: 0, hint: 'Optional.' },
      { key: 'virtual_services', label: 'Offers virtual / online services', type: 'toggle', weight: 0 },
      { key: 'languages', label: 'Languages Spoken', type: 'chips', weight: 0 },
      { key: 'hours', label: 'Business Hours', type: 'textarea', weight: 0, placeholder: 'e.g. Mon–Fri 9–5, weekends by appointment' },
    ],
  },
  {
    id: 'appraiser', title: 'Appraisal Services', applies: ['appraiser'],
    fields: [
      { key: 'appraisal_types', label: 'Appraisal Types', type: 'chips', weight: 3, suggestions: APPRAISAL_TYPES },
      { key: 'certifications', label: 'Professional Certifications', type: 'chips', weight: 2, suggestions: CERTS },
      { key: 'years_experience', label: 'Years Experience', type: 'number', weight: 1 },
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
    id: 'credentials', title: 'Credentials', applies: 'all',
    fields: [
      { key: 'associations', label: 'Professional Associations', type: 'chips', weight: 1 },
      { key: 'licenses', label: 'Licenses', type: 'chips', weight: 1 },
      { key: 'awards', label: 'Awards', type: 'chips', weight: 0 },
      { key: 'education', label: 'Education', type: 'chips', weight: 0 },
      { key: 'memberships', label: 'Memberships', type: 'chips', weight: 0 },
    ],
  },
  {
    id: 'trust', title: 'Trust & Media', applies: 'all',
    fields: [
      { key: 'headshot', label: 'Headshot', type: 'image', weight: 1, hint: 'Optional — a photo of you or your lead.' },
      { key: 'gallery', label: 'Business Photos', type: 'gallery', weight: 1, hint: 'Showcase your work (future-ready gallery).' },
    ],
  },
  {
    id: 'social', title: 'Social', applies: 'all',
    fields: [
      { key: 'facebook', label: 'Facebook', type: 'url', weight: 0, placeholder: 'https://facebook.com/…' },
      { key: 'instagram', label: 'Instagram', type: 'url', weight: 0, placeholder: 'https://instagram.com/…' },
      { key: 'linkedin', label: 'LinkedIn', type: 'url', weight: 0, placeholder: 'https://linkedin.com/…' },
      { key: 'youtube', label: 'YouTube', type: 'url', weight: 0 },
      { key: 'tiktok', label: 'TikTok', type: 'url', weight: 0 },
    ],
  },
  {
    id: 'seo', title: 'Search & Visibility', applies: 'all',
    fields: [
      { key: 'headline', label: 'Professional Headline', type: 'text', weight: 1, max: 160 },
      { key: 'seo_description', label: 'SEO Description', type: 'textarea', weight: 1, max: 320 },
      { key: 'keywords', label: 'Service Keywords', type: 'chips', weight: 0 },
      { key: 'published', label: 'List my profile publicly', type: 'toggle', weight: 0, hint: 'When on, your public profile page is viewable by anyone with the link.' },
    ],
  },
];

// ── Derived helpers ──────────────────────────────────────────────────────────
function flatFields() { return SECTIONS.reduce((a, s) => a.concat(s.fields.map((f) => ({ ...f, section: s.id }))), []); }

// Every profile_data key (non-core, and the individual toggle-group option keys).
function profileDataKeys() {
  const keys = new Set();
  flatFields().forEach((f) => {
    if (f.core) return;
    if (f.type === 'toggle-group') (f.options || []).forEach(([k]) => keys.add(k));
    else keys.add(f.key);
  });
  return keys;
}

function typeMap(f) { // coerce type for a field key
  if (f.type === 'chips' || f.type === 'gallery') return 'array';
  if (f.type === 'toggle') return 'boolean';
  if (f.type === 'number') return 'number';
  return 'string';
}

// key → coarse type across all fields (including toggle-group option keys as boolean).
function keyTypes() {
  const m = {};
  flatFields().forEach((f) => {
    if (f.type === 'toggle-group') (f.options || []).forEach(([k]) => { m[k] = 'boolean'; });
    else m[f.key] = typeMap(f);
  });
  return m;
}

/** Sanitize a client-supplied profile_data object → only whitelisted keys, coerced by type. */
function sanitizeProfileData(input) {
  const allowed = profileDataKeys();
  const types = keyTypes();
  const out = {};
  if (!input || typeof input !== 'object') return out;
  Object.keys(input).forEach((k) => {
    if (!allowed.has(k)) return;
    const v = input[k];
    const t = types[k];
    if (t === 'array') out[k] = Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 60) : [];
    else if (t === 'boolean') out[k] = v === true || v === 'true' || v === 1;
    else if (t === 'number') { const n = Number(v); out[k] = Number.isFinite(n) ? n : null; }
    else out[k] = v == null ? '' : String(v).slice(0, 8000);
  });
  return out;
}

/** Which sections apply to an org given its professional type keys (capabilities). */
function sectionsForTypes(typeKeys) {
  const set = new Set(typeKeys || []);
  return SECTIONS.filter((s) => s.applies === 'all' || (s.applies || []).some((t) => set.has(t)));
}

/** Completeness 0..100 for the applicable fields (weighted). */
function completeness(org, profileData, typeKeys) {
  const secs = sectionsForTypes(typeKeys);
  let total = 0, got = 0;
  const filled = (f) => {
    if (f.type === 'toggle-group') return (f.options || []).some(([k]) => profileData[k]);
    let v;
    if (f.core) v = org[CORE_COLUMNS[f.key]];
    else v = profileData[f.key];
    if (f.type === 'chips' || f.type === 'gallery') return Array.isArray(v) && v.length > 0;
    if (f.type === 'toggle') return v === true;
    return v != null && String(v).trim() !== '';
  };
  secs.forEach((s) => s.fields.forEach((f) => {
    const w = f.weight == null ? 1 : f.weight;
    if (w <= 0) return; // weight 0 fields don't count toward completeness
    total += w;
    if (filled(f)) got += w;
  }));
  return total ? Math.round((got / total) * 100) : 0;
}

/** From an org's effective capability keys, the subset that are professional types (for section gating + labels). */
function professionalTypesFrom(capabilityKeys) {
  return (capabilityKeys || []).filter((k) => PROFESSIONAL_TYPES[k]);
}
function primaryTypeLabel(typeKeys) {
  const k = (typeKeys || []).find((t) => PROFESSIONAL_TYPES[t]);
  return k ? PROFESSIONAL_TYPES[k].singular : 'Professional';
}

/**
 * Reusable, read-only profile VIEW model built from the schema — used by the public professional
 * endpoint AND the owner preview so both render identically. Emits only non-empty values; never
 * leaks internal/admin columns. Contact fields are business contact details the professional
 * chooses to publish (not buyer-privacy-governed auction data).
 */
function buildProfileView(org, typeKeys) {
  const pd = (org && org.profile_data) || {};
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== '');
  const sections = [];
  sectionsForTypes(typeKeys).forEach((s) => {
    if (s.id === 'general' || s.id === 'trust' || s.id === 'social' || s.id === 'seo') return; // rendered specially below
    const items = [];
    s.fields.forEach((f) => {
      if (f.type === 'toggle-group') {
        const on = (f.options || []).filter(([k]) => pd[k]).map(([, lbl]) => lbl);
        if (on.length) items.push({ label: f.label, value: on, kind: 'tags' });
      } else if (f.type === 'chips') {
        if (nonEmpty(pd[f.key])) items.push({ label: f.label, value: pd[f.key], kind: 'tags' });
      } else if (f.type === 'toggle') {
        if (pd[f.key] === true) items.push({ label: f.label, value: 'Yes', kind: 'text' });
      } else if (!f.core) {
        if (nonEmpty(pd[f.key])) items.push({ label: f.label, value: String(pd[f.key]), kind: 'text' });
      }
    });
    if (items.length) sections.push({ id: s.id, title: s.title, items });
  });

  // "General details" block (the non-header general fields worth showing publicly)
  const details = [];
  const gPush = (label, v) => { if (nonEmpty(v)) details.push({ label, value: Array.isArray(v) ? v : String(v), kind: Array.isArray(v) ? 'tags' : 'text' }); };
  gPush('Years in Business', pd.years_in_business);
  gPush('Owner / Lead', pd.owner_name);
  gPush('Service Area', pd.service_area);
  gPush('States Served', pd.states_served);
  gPush('Languages', pd.languages);
  gPush('Hours', pd.hours);
  if (pd.virtual_services === true) details.push({ label: 'Virtual / Online Services', value: 'Available', kind: 'text' });
  if (details.length) sections.unshift({ id: 'details', title: 'Details', items: details });

  const socials = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['linkedin', 'LinkedIn'], ['youtube', 'YouTube'], ['tiktok', 'TikTok']]
    .filter(([k]) => nonEmpty(pd[k])).map(([k, label]) => ({ network: label, url: pd[k] }));

  return {
    slug: org.slug,
    header: {
      logo: org.logo_url || null, cover: org.cover_image_url || null, headshot: pd.headshot_url || null,
      name: org.name, tagline: pd.tagline || '', category: primaryTypeLabel(typeKeys),
      location: [org.city, org.state].filter(Boolean).join(', '),
      short_description: org.description || '', verified: org.verification_status === 'verified',
    },
    contact: { phone: org.contact_phone || null, email: org.contact_email || null, website: org.website_url || null },
    about: pd.bio || '',
    sections,
    gallery: Array.isArray(pd.gallery) ? pd.gallery : [],
    social: socials,
    seo: { headline: pd.headline || '', description: pd.seo_description || org.description || '', keywords: Array.isArray(pd.keywords) ? pd.keywords : [] },
    published: pd.published === true,
    professional_types: typeKeys || [],
  };
}

module.exports = {
  SECTIONS, CORE_COLUMNS, PROFESSIONAL_TYPES, APPRAISAL_TYPES, CERTS,
  flatFields, profileDataKeys, keyTypes, sanitizeProfileData, sectionsForTypes, completeness,
  professionalTypesFrom, primaryTypeLabel, buildProfileView,
};
