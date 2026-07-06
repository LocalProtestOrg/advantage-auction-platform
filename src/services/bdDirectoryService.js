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

/** Map + sanitize a raw BD record -> import shape. PII (email/phone) is for invite/verify only. */
function normalize(r) {
  return {
    bdListingId: clean(r.user_id),
    name: cap(r.company, 200) || cap(r.full_name, 200),
    listingType: clean(r.listing_type),                 // Company | Individual
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
    // logo intentionally omitted -- deferred until claim/permission
  };
}

async function listListings(opts) {
  const { total, records, pages } = await transport.fetchAllListings(opts || {});
  const listings = records.map(normalize).filter((l) => l.bdListingId && l.name);
  return { total, pages, transport: transport.name, listings };
}

module.exports = { listListings, normalize, transportName: transport.name };
