'use strict';

/**
 * Auction geocoding — the seam the rest of the platform talks to.
 *
 * Contract (approved):
 *   geocodeAuctionLocation(location) -> latitude, longitude, normalized result,
 *                                       provider metadata / status
 *
 * Callers never import a provider directly, so swapping Mapbox for another vendor
 * (or adding intersection snapping) is a change to this directory only.
 *
 * NON-NEGOTIABLE: nothing here may throw into a save or publish path. Geocoding is
 * an enrichment, never a gate — a provider outage must not stop a seller listing an
 * auction. Every failure is returned as a status for an admin to see and retry.
 */

const crypto = require('crypto');
const provider = require('./mapboxProvider');
const { publicCoordinatesFor, coordNumber } = require('./publicCoordinates');

/**
 * Build the provider query from a seller-supplied location, most precise first.
 *
 * Precision ladder (approved):
 *   1. street, city, state, zip   2. city, state, zip   3. zip   4. city, state
 *
 * The street address is used to locate the property accurately; it is NEVER what
 * gets published. The public marker is the offset derived downstream, so using the
 * full address here improves buyer accuracy without weakening seller privacy.
 */
function buildQuery(location) {
  const clean = (v) => (v == null ? '' : String(v).trim());
  const street = clean(location.street_address);
  const city = clean(location.city);
  const state = clean(location.address_state);
  const zip = clean(location.zip);

  const cityState = [city, state].filter(Boolean).join(', ');

  if (street && (cityState || zip)) return [street, cityState, zip].filter(Boolean).join(', ');
  if (cityState && zip) return cityState + ' ' + zip;
  if (zip) return zip;
  if (cityState) return cityState;
  return '';
}

/**
 * Stable hash of the normalized location. Drives the "don't re-request when the
 * location has not changed" rule, so it must depend on the location ONLY — not on
 * the auction id, title, or anything an unrelated edit could disturb.
 */
function locationFingerprint(location) {
  const q = buildQuery(location).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return null;
  return crypto.createHash('sha256').update(q).digest('hex').slice(0, 32);
}

/**
 * Geocode a location. Resolves a normalized result; never rejects.
 *
 * @returns {Promise<{ok:boolean, lat?:number, lng?:number, normalized?:string|null,
 *                    status:string, error?:string, source:string, fingerprint:string|null}>}
 */
async function geocodeAuctionLocation(location) {
  const loc = location || {};
  const fingerprint = locationFingerprint(loc);
  const query = buildQuery(loc);

  if (!query) {
    return {
      ok: false,
      status: 'insufficient_location',
      error: 'Auction has no city, state, or ZIP to locate',
      source: provider.name,
      fingerprint: null,
    };
  }

  let result;
  try {
    result = await provider.geocode(query);
  } catch (err) {
    // Defensive: a provider bug must still not surface as a save failure.
    result = { ok: false, status: 'failed', error: 'Geocoding provider threw unexpectedly' };
  }

  return Object.assign({ source: provider.name, fingerprint, normalized: null }, result);
}

/**
 * Decide whether an auction needs geocoding, and why not when it doesn't.
 *
 * Rules (approved):
 *   - A manual override is never overwritten automatically.
 *   - Skip when the location is unchanged AND valid public coordinates exist.
 *   - Existing valid coordinates are never replaced automatically.
 *
 * @param {object} auction current row
 * @param {object} [opts]
 * @param {boolean} [opts.force] admin explicitly requested re-geocoding
 */
function shouldGeocode(auction, opts) {
  const a = auction || {};
  const force = Boolean(opts && opts.force);

  // An explicit admin re-geocode is the ONLY thing that overrides a manual pin.
  if (force) return { geocode: true, reason: 'admin_forced' };

  if (a.coordinates_manually_overridden) {
    return { geocode: false, reason: 'manual_override' };
  }

  // coordNumber, not Number: a NULL lat must read as "no coordinates", otherwise an
  // auction missing its marker would be skipped as "unchanged" and never recovered.
  const hasPublic = Number.isFinite(coordNumber(a.lat)) && Number.isFinite(coordNumber(a.lng));
  const fresh = locationFingerprint(a);

  // Nothing to work with — a request would fail anyway.
  if (!fresh) return { geocode: false, reason: 'insufficient_location' };

  // Unchanged location + coordinates already on file → no request. This is what stops
  // an unrelated edit (title, times, photos) from re-billing the provider.
  if (hasPublic && a.location_fingerprint === fresh) {
    return { geocode: false, reason: 'unchanged' };
  }

  return { geocode: true, reason: hasPublic ? 'location_changed' : 'missing_coordinates' };
}

module.exports = {
  geocodeAuctionLocation,
  locationFingerprint,
  buildQuery,
  publicCoordinatesFor,
  shouldGeocode,
  providerName: provider.name,
  isConfigured: provider.isConfigured,
};
