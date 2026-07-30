'use strict';

/**
 * geocode — the import geocoding wrapper (§8, §10, §11 of the plan). REUSES the existing geocoding seam
 * (src/services/geocoding): its fingerprint + shouldGeocode rules + Mapbox provider. Adds the two things
 * imports need that the seam doesn't: an outbound token-bucket throttle and exponential backoff with
 * jitter on transient failures. The location_fingerprint gate is what fixes the BD sync's
 * "re-geocode everything every run" flaw — an unchanged location is never re-requested.
 *
 * Enrichment, never a gate: a provider outage or missing token never fails an import. On failure the
 * previously valid coordinates are preserved (never blanked) and a status is returned for admin retry.
 */

const geoSeam = require('../geocoding');
const { withBackoff } = require('./rateLimit');

// Map an event canonical + existing DB row onto the location shape the geocoding seam expects.
// (Events use address/state; auctions use street_address/address_state — this is the only adaptation.)
function toLocation(canonical, existing) {
  canonical = canonical || {}; existing = existing || {};
  return {
    street_address: canonical.address || null,
    city: canonical.city || null,
    address_state: canonical.state || null,
    zip: canonical.zip || null,
    lat: existing.lat, lng: existing.lng,
    location_fingerprint: existing.location_fingerprint,
    // events have no coordinates_manually_overridden → undefined → treated as not overridden
  };
}

function eventLocationFingerprint(canonical) { return geoSeam.locationFingerprint(toLocation(canonical, {})); }
function shouldGeocodeEvent(canonical, existing, opts) { return geoSeam.shouldGeocode(toLocation(canonical, existing), opts); }

// A provider status is retryable when it looks transient (429 / 5xx / provider throw surfaced as status).
function isRetryableResult(r) {
  if (!r) return false;
  return r.retryable === true || ['rate_limited', 'provider_error', 'timeout', 'unavailable'].includes(r.status);
}

/**
 * Geocode one event's location if (and only if) the rules warrant it.
 * @param canonical  the sanitized CanonicalEvent (address/city/state/zip)
 * @param existing   the current DB row's geo fields { lat, lng, location_fingerprint, geocoding_status } or null
 * @param ctx        { bucket, geocodeFn, force, retries, baseMs, sleep, rand, now }
 * @returns geo-field patch: { geocoded, reason, lat, lng, location_fingerprint, geocoding_status,
 *          geocoding_source, geocoded_at, geocoding_error, normalized }. NEVER throws.
 */
async function geocodeEvent(canonical, existing, ctx) {
  ctx = ctx || {}; existing = existing || {};
  const carry = { lat: existing.lat != null ? existing.lat : null, lng: existing.lng != null ? existing.lng : null,
    location_fingerprint: existing.location_fingerprint || null };

  const decision = shouldGeocodeEvent(canonical, existing, { force: ctx.force });
  if (!decision.geocode) return Object.assign({ geocoded: false, reason: decision.reason }, carry);

  const geocodeFn = ctx.geocodeFn || geoSeam.geocodeAuctionLocation;
  const loc = toLocation(canonical, existing);
  const nowIso = () => (typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString());

  let result;
  try {
    result = await withBackoff(async () => {
      if (ctx.bucket) await ctx.bucket.take();     // outbound throttle before each attempt
      return geocodeFn(loc);
    }, {
      retries: Number.isInteger(ctx.retries) ? ctx.retries : 3,
      baseMs: ctx.baseMs, sleep: ctx.sleep, rand: ctx.rand,
      isRetryable: isRetryableResult,
    });
  } catch (e) {
    // A thrown/exhausted error → record failure, PRESERVE existing coordinates.
    return Object.assign({ geocoded: false, reason: 'error', geocoding_status: 'failed', geocoding_error: String(e && e.message) }, carry);
  }

  if (!result || !result.ok) {
    return Object.assign({ geocoded: false, reason: result ? result.status : 'failed',
      geocoding_status: (result && result.status) || 'failed', geocoding_error: (result && result.error) || null,
      geocoding_source: (result && result.source) || null }, carry);
  }

  // Success — persist the new coordinates + the fingerprint that gates future runs.
  return {
    geocoded: true, reason: decision.reason,
    lat: result.lat, lng: result.lng,
    location_fingerprint: result.fingerprint,
    geocoding_status: 'ok', geocoding_source: result.source,
    geocoded_at: nowIso(), geocoding_error: null,
    normalized: result.normalized || null,
  };
}

module.exports = { geocodeEvent, shouldGeocodeEvent, eventLocationFingerprint, toLocation, isRetryableResult };
