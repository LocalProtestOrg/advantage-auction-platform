'use strict';

/**
 * subscriberGeoService — resolve a first-party subscriber's self-reported location (city/state + optional
 * ZIP) to normalized geography, REUSING the certified geocoding seam (src/services/geocoding). No new
 * geo stack, no ZIP-centroid table, no PostGIS. Best-effort and fail-open: a geocoder miss NEVER blocks
 * signup — city/state text is always stored so city/state/nationwide segmentation works regardless.
 *
 * AUDITABILITY: inferred coordinates are distinguishable from user-supplied text via geography_source +
 * geography_precision + geo_resolved_at. Coordinates derived from a city or ZIP are CENTROIDS and are
 * never presented to a recipient as exact household distance.
 */
const geocoding = require('./geocoding');

// Precision reflects the most precise field the visitor supplied (not the geocoder's internal confidence).
function precisionFor({ zip, city, state }) {
  if (zip) return 'postal';
  if (city && state) return 'city_centroid';
  if (state) return 'state_centroid';
  return 'unknown';
}

/**
 * @param {object} loc { city, state, zip }
 * @returns {object} { city, state, zip, latitude, longitude, geography_precision, geography_source, geo_resolved_at }
 *          latitude/longitude are null when the geocoder is unconfigured or the location can't be resolved.
 */
async function resolve(loc = {}) {
  const city = loc.city ? String(loc.city).trim() : null;
  const state = loc.state ? String(loc.state).trim().toUpperCase() : null;
  const zip = loc.zip ? String(loc.zip).trim() : null;
  const base = { city, state, zip, latitude: null, longitude: null, geography_precision: 'unknown', geography_source: 'user_supplied', geo_resolved_at: null };

  // Nothing to resolve, or geocoder not configured → keep the user-supplied text only.
  if ((!city || !state) && !zip) return base;
  if (!geocoding.isConfigured || !geocoding.isConfigured()) return base;

  let result;
  try {
    // The seam's location shape uses address_state; reuse it verbatim so we hit the same query ladder.
    result = await geocoding.geocodeAuctionLocation({ city, address_state: state, zip });
  } catch (_) {
    return base;   // provider threw → fail open with text-only geography
  }

  if (result && result.ok && Number.isFinite(result.lat) && Number.isFinite(result.lng)) {
    return {
      city, state, zip,
      latitude: result.lat,
      longitude: result.lng,
      geography_precision: precisionFor({ zip, city, state }),
      geography_source: 'geocoder',
      geo_resolved_at: new Date().toISOString(),
    };
  }
  return base;
}

module.exports = { resolve, precisionFor };
