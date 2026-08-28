'use strict';

/**
 * googlePlaces — Google Places API (New) business-discovery connector for the Sales Prospect CRM.
 *
 * SECURITY: the API key is read ONLY from process.env.GOOGLE_PLACES_API_KEY, server-side. It is NEVER
 * logged, printed, returned to a client, or stored in the DB. Any error text is passed through redact()
 * which strips the key defensively.
 *
 * COST DISCIPLINE: we call ONLY Text Search (places:searchText) with a MINIMAL field mask — the fields
 * we actually use (id, name, address + components, phone, website, maps URI, types, business status).
 * Phone + website arrive IN the search response, so we never make a separate (billed) Place Details call.
 * No photos/reviews/hours/summaries are ever requested. Callers cap results and pages.
 *
 * DATA HONESTY: absence of a website in Google is NOT asserted as "confirmed no website" (independent_website
 * stays 'unknown'); auction capability is never inferred (online_auctions_offered stays 'unknown').
 */

const KEY_ENV = 'GOOGLE_PLACES_API_KEY';
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
// Minimal field mask — only what the CRM needs. (nextPageToken is a top-level field for pagination.)
const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents',
  'places.nationalPhoneNumber', 'places.websiteUri', 'places.googleMapsUri', 'places.types',
  'places.businessStatus', 'nextPageToken',
].join(',');

function hasApiKey() { return !!process.env[KEY_ENV]; }
function redact(s) { const k = process.env[KEY_ENV]; return k ? String(s == null ? '' : s).split(k).join('***') : String(s == null ? '' : s); }

function diagnose(status, json) {
  const reason = (json && json.error && json.error.status) || '';
  if (status === 403) return 'permission/api-not-enabled/billing/restriction ' + reason;
  if (status === 429) return 'quota/rate-limit ' + reason;
  if (status === 400) return 'invalid-request ' + reason;
  if (status === 401) return 'auth/invalid-key ' + reason;
  return 'http-' + status + ' ' + reason;
}

// Address component helper.
function comp(components, type) {
  const c = (components || []).find((x) => (x.types || []).includes(type));
  return c ? (c.shortText || c.longText || null) : null;
}

// Normalize a raw Places API (New) place → a compact internal shape.
function mapPlace(p) {
  const comps = p.addressComponents || [];
  return {
    googlePlaceId: p.id || null,
    displayName: (p.displayName && p.displayName.text) || null,
    formattedAddress: p.formattedAddress || null,
    city: comp(comps, 'locality') || comp(comps, 'postal_town') || comp(comps, 'sublocality_level_1') || comp(comps, 'sublocality') || null,
    state: comp(comps, 'administrative_area_level_1') || null,
    zip: comp(comps, 'postal_code') || null,
    phone: p.nationalPhoneNumber || null,
    website: p.websiteUri || null,
    googleMapsUri: p.googleMapsUri || null,
    types: p.types || [],
    businessStatus: p.businessStatus || null,
  };
}

// ── Relevance + classification (name-driven; never asserts unverifiable signals) ────────────────────
const REJECT = /real ?estate|realty|realtor|\bre\/max\b|coldwell|keller williams|self ?storage|storage unit|\bbank\b|insurance|law (firm|office)|attorney|\bdentist\b|\bsalon\b|restaurant|\bcafe\b|apartment/i;
const ESTATE = /estate sale|estate liquidat|liquidat|tag sale|downsiz|senior move|moving sale|estate buyer|estate service/i;
const AUCTION = /auction|auctioneer/i;
const CONSIGN = /consign/i;
const SOCIAL_HOST = /facebook\.com|instagram\.com|linktr\.ee|business\.site|linktree|m\.facebook/i;

function classify(place) {
  const name = place.displayName || '';
  const closed = place.businessStatus && place.businessStatus !== 'OPERATIONAL';
  const isEstate = ESTATE.test(name), isAuction = AUCTION.test(name), isConsign = CONSIGN.test(name);
  const onTarget = isEstate || isAuction || isConsign;
  // Reject clearly-irrelevant businesses (unless the name also carries an on-target keyword).
  const relevant = !closed && onTarget && !(REJECT.test(name) && !isEstate && !isAuction);
  const business_type = isEstate ? 'estate_sale_company' : (isAuction ? 'auction_house' : 'other');
  const website = place.website || '';
  const social = website && SOCIAL_HOST.test(website);
  return {
    relevant,
    business_type,
    // Only a name that literally states estate sale/liquidation supports estate_sales_offered='yes'.
    estate_sales_offered: isEstate ? 'yes' : 'unknown',
    online_auctions_offered: 'unknown',                       // never inferred from Places data
    // No website in Google is NOT proof of "no website" → 'unknown', not 'no' (section 10).
    independent_website: website ? (social ? 'no' : 'yes') : 'unknown',
    website_status: website ? (social ? 'social_only' : 'unknown') : 'unknown',
  };
}

// Normalized place → prospect record for salesProspectService.importProspects (research-only fields).
function toProspect(place) {
  const cls = classify(place);
  const social = cls.website_status === 'social_only';
  return {
    company_name: place.displayName,
    city: place.city, state: place.state, zip: place.zip,
    business_phone: place.phone || null,
    business_email: null,                                     // NEVER fabricated; may be enriched from the company's own site
    website: social ? null : (place.website || null),
    social_url: social ? place.website : null,
    website_status: cls.website_status,
    independent_website: cls.independent_website,
    estate_sales_offered: cls.estate_sales_offered,
    online_auctions_offered: cls.online_auctions_offered,
    business_type: cls.business_type,
    google_place_id: place.googlePlaceId,
    source: 'google_places',
    source_url: place.googleMapsUri || null,
    contact_source: 'Google Places API (New)',
    _relevant: cls.relevant,
  };
}

/**
 * searchText(query, opts, deps) → { ok, status, diagnosis, message, requests, places[], nextPageToken }.
 * opts: { max (default 20), paginate (default false), pageSize }. deps.fetch injectable for tests.
 * NEVER throws for an API error — returns { ok:false, diagnosis } so callers can stop safely.
 */
async function searchText(query, opts = {}, deps = {}) {
  const doFetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, status: 0, diagnosis: 'no-fetch', message: 'fetch unavailable', requests: 0, places: [] };
  if (!hasApiKey()) return { ok: false, status: 0, diagnosis: 'missing-key', message: 'GOOGLE_PLACES_API_KEY not set', requests: 0, places: [] };
  const key = process.env[KEY_ENV];
  const max = opts.max || 20;
  const pageSize = Math.min(20, opts.pageSize || max);
  const out = []; let pageToken = null; let requests = 0; let guard = 0;
  do {
    const body = { textQuery: query, regionCode: 'US', pageSize };
    if (pageToken) body.pageToken = pageToken;
    let res, json = {};
    try {
      res = await doFetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK }, body: JSON.stringify(body) });
      json = await res.json().catch(() => ({}));
    } catch (e) { return { ok: false, status: 0, diagnosis: 'network', message: redact(e.message), requests, places: out }; }
    requests++;
    if (!res.ok) {
      return { ok: false, status: res.status, diagnosis: diagnose(res.status, json), message: redact(json && json.error && json.error.message), requests, places: out };
    }
    for (const p of (json.places || [])) out.push(mapPlace(p));
    pageToken = json.nextPageToken || null;
    guard++;
  } while (opts.paginate && pageToken && out.length < max && guard < 3);
  return { ok: true, status: 200, requests, places: out.slice(0, max), nextPageToken: pageToken };
}

module.exports = { hasApiKey, redact, searchText, mapPlace, classify, toProspect, FIELD_MASK, KEY_ENV, diagnose };
