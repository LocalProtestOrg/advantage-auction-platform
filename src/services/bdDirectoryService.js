'use strict';

/**
 * bdDirectoryService — transport-agnostic BD directory adapter (Phase 3B).
 * Exposes the directory operations the platform needs; the underlying transport (REST today,
 * MCP if/when connected) is an implementation detail. Normalizes + sanitizes raw BD records
 * into the import shape. Read-only. Logos are intentionally NOT surfaced (deferred until claim).
 */

const restTransport = require('./bdRestTransport');
// A future MCP transport would be selected here when BD MCP tools are available.
const transport = restTransport;

const CONTROL = /[\x00-\x1F\x7F]/g; // strip control characters only
const clean = (v) => {
  if (v == null) return null;
  const s = String(v).replace(CONTROL, '').trim();
  return s || null;
};
const cap = (v, n) => { const c = clean(v); return c ? c.slice(0, n) : null; };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// Classify BD's resolved main image URL. BD's `image_main_file` already implements its own
// logo→picture→default fallback, so we trust it and label the treatment:
//   /logos/profile/…    → an uploaded company LOGO        (contained treatment)
//   /pictures/profile/… → an uploaded listing PHOTO/cover (fill treatment)
//   …Favicon…           → BD's DEFAULT directory asset    (contained default treatment)
function classifyBdImage(url) {
  const u = clean(url);
  if (!u) return { url: null, type: null };
  if (/\/logos\/profile\//i.test(u)) return { url: u, type: 'logo' };
  if (/\/pictures\/profile\//i.test(u)) return { url: u, type: 'photo' };
  if (/favicon/i.test(u)) return { url: u, type: 'default' };
  return { url: u, type: 'photo' }; // unknown remote image → treat as a photographic cover
}

/** Map + sanitize a raw BD record -> import shape. PII (email/phone) is for invite/verify only. */
function normalize(r) {
  const bdImg = classifyBdImage(r.image_main_file);
  return {
    bdListingId: clean(r.user_id),
    companyName: cap(r.company, 200),                   // authoritative "this is a business" signal
    name: cap(r.company, 200) || cap(r.full_name, 200),
    listingType: clean(r.listing_type),                 // Company | Individual
    street: cap(r.address1, 240),                       // public street address (for geocoding fallback)
    city: cap(r.city, 120),
    state: (clean(r.state_code) || '').toUpperCase().slice(0, 8) || null,
    zip: cap(r.zip_code, 20),
    lat: num(r.lat),
    lng: num(r.lon),
    website: cap(r.website, 300),
    description: cap(r.about_me, 4000) || cap(r.search_description, 4000),
    contactEmail: cap(r.email, 200),                    // PII
    contactPhone: cap(r.phone_number, 40),              // PII
    googlePlaceId: clean(r.goolge_place_id),            // note: BD field name is misspelled
    professionId: clean(r.profession_id),
    subscriptionName: clean(r.subscription_name),       // warm-lead hint
    // Public listing imagery + canonical profile path (owner-approved for Marketplace display).
    bdImageUrl: cap(bdImg.url, 500),                    // resolved main image on www.advantage.bid
    bdImageType: bdImg.type,                            // 'logo' | 'photo' | 'default' | null
    profilePath: cap(r.filename, 300),                  // canonical BD listing slug (→ /<filename>)
    // Publish/eligibility signals (used to include only legitimate public listings).
    bdStatus: (clean(r.status) || '').toLowerCase() || null,   // e.g. 'active'
    bdActive: clean(r.active),                                 // BD numeric status code
  };
}

// A listing is eligible for the public Marketplace mirror when it is a real, active BUSINESS
// listing. The authoritative structured signal is a non-empty `company` name: BD business
// listings carry one; administrative/system/blog-author/general-user records (e.g. the
// "Admin User - Blog Author" and "Sample General User" accounts, all listing_type Individual
// or uncategorized profession_id 0) leave `company` blank. This is durable, data-driven, and
// applied at sync time so excluded records are reconciled away and never reappear nightly.
const SAMPLE_RE = /\b(sample|test|demo|placeholder|example)\b/i;
function isEligible(l) {
  if (!l || !l.bdListingId) return false;
  if (!l.companyName) return false;                     // must be a named business, not a person/admin record
  if (SAMPLE_RE.test(l.companyName)) return false;      // sample/test/demo business records
  // BD `status` text is the authoritative publish signal when present; default-allow when absent.
  if (l.bdStatus && l.bdStatus !== 'active') return false;
  return true;
}

async function listListings(opts) {
  const { total, records, pages } = await transport.fetchAllListings(opts || {});
  const listings = records.map(normalize).filter((l) => l.bdListingId && l.name);
  return { total, pages, transport: transport.name, listings };
}

/** Eligible public listings only (excludes sample/test and non-active BD statuses). */
async function listEligibleListings(opts) {
  const { total, pages, listings, transport: t } = await listListings(opts);
  const eligible = listings.filter(isEligible);
  return { total, pages, transport: t, listings: eligible, seen: listings.length, excluded: listings.length - eligible.length };
}

module.exports = { listListings, listEligibleListings, normalize, isEligible, transportName: transport.name };
