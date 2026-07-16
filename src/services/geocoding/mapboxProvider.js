'use strict';

/**
 * Mapbox Permanent Geocoding provider.
 *
 * The ONLY file in the platform that knows Mapbox exists. Everything else talks to
 * geocodeAuctionLocation() in ./index.js, so replacing this provider later means
 * writing one sibling module — no business logic changes.
 *
 * Why permanent=true: the platform STORES coordinates on the auction record.
 * Mapbox's default (temporary) geocoding forbids persisting results; the permanent
 * endpoint is the tier whose terms allow it. Google forbids storage outright and
 * the public OSM/Nominatim instance forbids permanent commercial storage, which is
 * why they were not viable here.
 *
 * Uses Node's native fetch (v18+). No HTTP dependency is introduced.
 */

const ENDPOINT = 'https://api.mapbox.com/search/geocode/v6/forward';
const TIMEOUT_MS = 8000;

// US-only platform; constraining the country improves precision and cuts ambiguity.
const COUNTRY = 'us';

function token() {
  return process.env.MAPBOX_GEOCODING_TOKEN || '';
}

function isConfigured() {
  return Boolean(token());
}

/**
 * Forward-geocode a single-line address query.
 *
 * Returns a normalized result. NEVER throws for an expected provider condition —
 * geocoding must not be able to fail an auction save or publish, so failures come
 * back as a status the caller records and an admin can retry.
 *
 * @param {string} query single-line address
 * @returns {Promise<{ok:boolean, lat?:number, lng?:number, normalized?:string, status:string, error?:string}>}
 */
async function geocode(query) {
  if (!isConfigured()) {
    return { ok: false, status: 'unconfigured', error: 'MAPBOX_GEOCODING_TOKEN is not set' };
  }
  if (!query || !String(query).trim()) {
    return { ok: false, status: 'insufficient_location', error: 'No usable location' };
  }

  const url =
    ENDPOINT +
    '?q=' + encodeURIComponent(String(query).trim()) +
    '&country=' + COUNTRY +
    '&limit=1' +
    // Storage rights: this is the billable tier whose terms permit persistence.
    '&permanent=true' +
    '&access_token=' + encodeURIComponent(token());

  // AbortSignal.timeout so a hung provider can never stall a seller's save.
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      status: 'failed',
      error: timedOut ? 'Geocoding provider timed out' : 'Geocoding provider unreachable',
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: 'failed', error: 'Geocoding provider rejected the credential' };
  }
  if (res.status === 429) {
    return { ok: false, status: 'failed', error: 'Geocoding provider rate-limited the request' };
  }
  if (!res.ok) {
    return { ok: false, status: 'failed', error: 'Geocoding provider error (HTTP ' + res.status + ')' };
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, status: 'failed', error: 'Geocoding provider returned an unreadable response' };
  }

  const feature = body && Array.isArray(body.features) ? body.features[0] : null;
  const coords = feature && feature.properties && feature.properties.coordinates;
  const lat = coords ? Number(coords.latitude) : NaN;
  const lng = coords ? Number(coords.longitude) : NaN;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, status: 'failed', error: 'No match for this location' };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, status: 'failed', error: 'Provider returned out-of-range coordinates' };
  }

  return {
    ok: true,
    status: 'ok',
    lat,
    lng,
    normalized: (feature.properties && feature.properties.full_address) || null,
  };
}

module.exports = { geocode, isConfigured, name: 'mapbox' };
