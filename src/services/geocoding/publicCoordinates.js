'use strict';

/**
 * Public display coordinates — deterministic privacy offset.
 *
 * The homepage map is a discovery tool, but the platform must never publish the
 * seller's exact property. Production already exposes city, state, zip and the
 * STREET NAME (routes/auctions.js strips the house number into pickup_street) —
 * publishing rooftop coordinates would effectively restore the house number and
 * reverse-geocode straight back to the property.
 *
 * So the public marker is the precise point displaced by ~0.10 miles on a bearing
 * derived from the auction's own identity.
 *
 * DETERMINISM is a product requirement: the same auction must always produce the
 * same public coordinate, so the marker never drifts between page loads, deploys,
 * or unrelated edits. The bearing is therefore an HMAC of the auction id + the
 * location fingerprint — no randomness, no clock, no call ordering. Re-running this
 * on the same inputs on any machine yields the identical point.
 *
 * Keying on the fingerprint (not the id alone) means a genuine location change
 * produces a new bearing rather than reusing the old one, which would otherwise
 * leak the direction of the move.
 *
 * NOT road-aware: identifying roads needs road-network data, which would mean a
 * second external provider. That was explicitly deferred until after launch. At the
 * map's default zoom (fitBounds maxZoom 11, ~38m/px) a 161m offset is roughly four
 * pixels, so road adjacency is imperceptible there; it only matters if a viewer
 * zooms hard. Snapping can be added later behind geocodeAuctionLocation() without
 * touching business logic.
 */

const crypto = require('crypto');

/**
 * Strict coordinate coercion.
 *
 * Number(null), Number('') and Number(false) are all 0 — a real latitude. Plain
 * Number() therefore turns "no coordinates" into a marker at 0,0 (Gulf of Guinea),
 * and makes a NULL lat look like valid data. Every coordinate check goes through
 * this instead.
 */
function coordNumber(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
  return Number(v);
}

// ~0.10 miles. The privacy displacement: far enough that the marker is not the
// property, close enough that it stays in the immediate neighborhood.
const OFFSET_METERS = 161;
const EARTH_RADIUS_M = 6378137;

// Stable, non-secret domain separator. This is NOT a secret: the offset's job is to
// avoid publishing the property, not to resist an attacker who already holds the
// address. Deriving it from a secret would make markers move if the secret rotated,
// which would break the stability requirement.
const BEARING_SALT = 'advantage.bid/public-marker/v1';

/**
 * Deterministic bearing in [0, 360) from stable inputs.
 */
function bearingFor(auctionId, fingerprint) {
  const h = crypto
    .createHmac('sha256', BEARING_SALT)
    .update(String(auctionId) + '|' + String(fingerprint || ''))
    .digest();
  // First 4 bytes → uniform-enough integer → degrees. Bounded and reproducible.
  const n = h.readUInt32BE(0);
  return (n % 36000) / 100;
}

/**
 * Project a point by `distance` metres along `bearing` degrees.
 * Standard spherical forward geodesic — accurate well past 161m.
 */
function project(lat, lng, bearingDeg, distanceM) {
  const d = distanceM / EARTH_RADIUS_M;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: (lat2 * 180) / Math.PI,
    // Normalize longitude back into [-180, 180].
    lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180,
  };
}

/**
 * Derive the stable public display coordinate for an auction.
 *
 * @param {object} args
 * @param {string} args.auctionId
 * @param {number} args.lat  precise (internal) latitude
 * @param {number} args.lng  precise (internal) longitude
 * @param {string} [args.fingerprint] normalized-location hash
 * @returns {{lat:number,lng:number}|null} null when inputs are unusable
 */
function publicCoordinatesFor({ auctionId, lat, lng, fingerprint }) {
  const la = coordNumber(lat);
  const ln = coordNumber(lng);
  if (!auctionId || !Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;

  const point = project(la, ln, bearingFor(auctionId, fingerprint), OFFSET_METERS);

  // 5dp ≈ 1m — well below the offset, so rounding cannot betray the true point,
  // and it keeps the stored value stable across float formatting.
  return {
    lat: Math.round(point.lat * 1e5) / 1e5,
    lng: Math.round(point.lng * 1e5) / 1e5,
  };
}

/**
 * Great-circle distance in metres. Used by tests and by the backfill report to
 * assert the published marker really is ~0.10mi from the property.
 */
function distanceMeters(aLat, aLng, bLat, bLng) {
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

module.exports = {
  publicCoordinatesFor,
  distanceMeters,
  bearingFor,
  coordNumber,
  OFFSET_METERS,
};
