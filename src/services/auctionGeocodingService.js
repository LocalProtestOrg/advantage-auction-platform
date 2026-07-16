'use strict';

/**
 * Applies geocoding results to auction records.
 *
 * Separated from services/geocoding/ on purpose: that directory is the replaceable
 * provider seam, this file is the business rules (when to write, what to protect).
 * Swapping providers should not require touching anything here.
 *
 * Every entry point is failure-tolerant. Geocoding is enrichment: a provider outage,
 * a missing token, or a bad address must never stop an auction being saved or
 * published. Failures are recorded as status + error for an admin to retry.
 */

const db = require('../db');
const {
  geocodeAuctionLocation,
  publicCoordinatesFor,
  shouldGeocode,
} = require('./geocoding');
const { coordNumber } = require('./geocoding/publicCoordinates');

const LOCATION_COLUMNS = 'id, street_address, city, address_state, zip, lat, lng, location_fingerprint, coordinates_manually_overridden';

async function loadAuction(auctionId) {
  const { rows } = await db.query(
    `SELECT ${LOCATION_COLUMNS} FROM auctions WHERE id = $1`,
    [auctionId]
  );
  return rows[0] || null;
}

/**
 * Record a geocoding attempt that produced no usable coordinates.
 *
 * Deliberately does NOT touch lat/lng/internal_*: "Preserve any previously valid
 * coordinates." A failed retry must never blank a working marker.
 */
async function recordFailure(auctionId, result) {
  await db.query(
    `UPDATE auctions
        SET geocoding_status = $2,
            geocoding_error  = $3,
            geocoding_source = $4,
            geocoded_at      = NOW()
      WHERE id = $1`,
    [auctionId, result.status, result.error || null, result.source || null]
  );
  return { ok: false, status: result.status, error: result.error || null };
}

/**
 * Geocode one auction and persist both coordinate tiers.
 *
 * @param {string} auctionId
 * @param {object} [opts]
 * @param {boolean} [opts.force] admin explicitly requested re-geocoding; this is the
 *                               only way a manual override is replaced.
 */
async function geocodeAuction(auctionId, opts) {
  const force = Boolean(opts && opts.force);

  const auction = await loadAuction(auctionId);
  if (!auction) return { ok: false, status: 'not_found', error: 'Auction not found' };

  const decision = shouldGeocode(auction, { force });
  if (!decision.geocode) {
    // Not an error — the rules say no request is warranted.
    return { ok: true, skipped: true, status: decision.reason };
  }

  const result = await geocodeAuctionLocation(auction);
  if (!result.ok) return recordFailure(auctionId, result);

  const publicCoords = publicCoordinatesFor({
    auctionId,
    lat: result.lat,
    lng: result.lng,
    fingerprint: result.fingerprint,
  });
  if (!publicCoords) {
    return recordFailure(auctionId, {
      status: 'failed',
      error: 'Could not derive public display coordinates',
      source: result.source,
    });
  }

  // lat/lng are the PUBLIC offset point; internal_* are the precise private point.
  // A successful automatic geocode clears the manual-override flag only when an
  // admin forced it — that is what makes "force" the sole path past a manual pin.
  await db.query(
    `UPDATE auctions
        SET lat          = $2,
            lng          = $3,
            internal_lat = $4,
            internal_lng = $5,
            location_fingerprint = $6,
            geocoding_status = 'ok',
            geocoding_error  = NULL,
            geocoding_source = $7,
            geocoded_at      = NOW(),
            coordinates_manually_overridden = CASE WHEN $8::boolean THEN false
                                                   ELSE coordinates_manually_overridden END
      WHERE id = $1`,
    [
      auctionId,
      publicCoords.lat,
      publicCoords.lng,
      result.lat,
      result.lng,
      result.fingerprint,
      result.source,
      force,
    ]
  );

  return {
    ok: true,
    status: 'ok',
    public: publicCoords,
    normalized: result.normalized || null,
  };
}

/**
 * Fire-and-forget trigger for save/publish paths.
 *
 * Returns immediately and never rejects, so a caller can await it without any risk
 * of a provider problem surfacing as a failed auction save. Errors are swallowed to
 * the log — the status column is the durable record.
 */
async function geocodeAuctionSafe(auctionId, opts) {
  try {
    return await geocodeAuction(auctionId, opts);
  } catch (err) {
    console.error('[geocoding] non-fatal failure for auction', auctionId, err.message);
    try {
      await recordFailure(auctionId, {
        status: 'failed',
        error: 'Unexpected geocoding error',
        source: 'mapbox',
      });
    } catch (e) { /* status is best-effort; never escalate */ }
    return { ok: false, status: 'failed', error: 'Unexpected geocoding error' };
  }
}

/**
 * Admin manual coordinate override.
 *
 * The admin supplies the PUBLIC display point directly. internal_* is deliberately
 * left alone: an admin pin is a statement about what buyers should see, not a claim
 * about where the property is.
 */
async function setManualCoordinates(auctionId, lat, lng) {
  // coordNumber rejects null/''/booleans, which Number() would silently pin to 0,0.
  const la = coordNumber(lat);
  const ln = coordNumber(lng);
  if (!Number.isFinite(la) || la < -90 || la > 90) {
    return { ok: false, error: 'Latitude must be a number between -90 and 90' };
  }
  if (!Number.isFinite(ln) || ln < -180 || ln > 180) {
    return { ok: false, error: 'Longitude must be a number between -180 and 180' };
  }

  const { rows } = await db.query(
    `UPDATE auctions
        SET lat = $2,
            lng = $3,
            coordinates_manually_overridden = true,
            geocoding_status = 'manual',
            geocoding_error  = NULL,
            geocoding_source = 'manual',
            geocoded_at      = NOW()
      WHERE id = $1
     RETURNING id, lat, lng, geocoding_status, coordinates_manually_overridden`,
    [auctionId, la, ln]
  );
  if (!rows[0]) return { ok: false, error: 'Auction not found' };
  return { ok: true, auction: rows[0] };
}

/**
 * Auctions with a usable location but no public marker. Drives the backfill and is
 * the same predicate the publish-recovery path uses.
 */
async function findMissingPublicCoordinates(limit = 500) {
  const { rows } = await db.query(
    `SELECT ${LOCATION_COLUMNS}
       FROM auctions
      WHERE (lat IS NULL OR lng IS NULL)
        AND coordinates_manually_overridden IS NOT TRUE
        -- Policy #22: archived auctions never appear on any public surface, so a
        -- marker for one can never render. Geocoding them is a billable request for
        -- an invisible pin — on current data that is 14 of 18 candidate rows.
        AND is_archived IS NOT TRUE
        AND (NULLIF(TRIM(COALESCE(zip, '')), '') IS NOT NULL
             OR NULLIF(TRIM(COALESCE(city, '')), '') IS NOT NULL)
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = {
  geocodeAuction,
  geocodeAuctionSafe,
  setManualCoordinates,
  findMissingPublicCoordinates,
};
