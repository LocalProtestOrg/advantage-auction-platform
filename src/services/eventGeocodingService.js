'use strict';

/**
 * Applies geocoding to Marketplace Event records — the two-tier privacy model reused from auctions.
 *
 * Mirrors auctionGeocodingService: the replaceable provider seam lives in services/geocoding/, the
 * business rules (when to write, what to protect) live here. Public lat/lng = the ~0.10-mile OFFSET
 * marker; internal_lat/lng = the precise point, never exposed by any public serializer.
 *
 * NON-NEGOTIABLE: nothing here throws into a save/publish path. Geocoding is enrichment; a missing
 * Mapbox token or provider outage must never block an event being published — failures are recorded
 * as status/error for an admin to retry, and the time-based address reveal still works without a map.
 */

const db = require('../db');
const { geocodeAuctionLocation, publicCoordinatesFor, shouldGeocode } = require('./geocoding');
const { coordNumber } = require('./geocoding/publicCoordinates');

// Map event columns onto the generic geocoder's expected shape (street_address / address_state).
const SELECT = `id, address AS street_address, city, state AS address_state, zip,
                lat, lng, location_fingerprint, coordinates_manually_overridden`;

async function loadEvent(eventId) {
  const { rows } = await db.query(`SELECT ${SELECT} FROM events WHERE id = $1`, [eventId]);
  return rows[0] || null;
}

// Records a failed/insufficient attempt WITHOUT touching lat/lng/internal_* — a failed retry must
// never blank a working marker.
async function recordFailure(eventId, result) {
  await db.query(
    `UPDATE events SET geocoding_status=$2, geocoding_error=$3, geocoding_source=$4, geocoded_at=NOW()
      WHERE id=$1`,
    [eventId, result.status, result.error || null, result.source || null]);
  return { ok: false, status: result.status, error: result.error || null };
}

async function geocodeEvent(eventId, opts) {
  const force = Boolean(opts && opts.force);
  const ev = await loadEvent(eventId);
  if (!ev) return { ok: false, status: 'not_found', error: 'Event not found' };

  const decision = shouldGeocode(ev, { force });
  if (!decision.geocode) return { ok: true, skipped: true, status: decision.reason };

  const result = await geocodeAuctionLocation(ev);
  if (!result.ok) return recordFailure(eventId, result);

  const pub = publicCoordinatesFor({ auctionId: eventId, lat: result.lat, lng: result.lng, fingerprint: result.fingerprint });
  if (!pub) {
    return recordFailure(eventId, { status: 'failed', error: 'Could not derive public display coordinates', source: result.source });
  }

  // lat/lng = PUBLIC offset point; internal_* = precise private point.
  await db.query(
    `UPDATE events
        SET lat=$2, lng=$3, internal_lat=$4, internal_lng=$5, location_fingerprint=$6,
            geocoding_status='ok', geocoding_error=NULL, geocoding_source=$7, geocoded_at=NOW(),
            coordinates_manually_overridden = CASE WHEN $8::boolean THEN false
                                                   ELSE coordinates_manually_overridden END
      WHERE id=$1`,
    [eventId, pub.lat, pub.lng, result.lat, result.lng, result.fingerprint, result.source, force]);

  return { ok: true, status: 'ok', public: pub };
}

/** Fire-and-forget for save/publish paths — never rejects. */
async function geocodeEventSafe(eventId, opts) {
  try {
    return await geocodeEvent(eventId, opts);
  } catch (err) {
    console.error('[geocoding] non-fatal failure for event', eventId, err.message);
    try {
      await recordFailure(eventId, { status: 'failed', error: 'Unexpected geocoding error', source: 'mapbox' });
    } catch (e) { /* status is best-effort; never escalate */ }
    return { ok: false, status: 'failed', error: 'Unexpected geocoding error' };
  }
}

/** Admin manual override — sets the PUBLIC display point directly; internal_* is left untouched. */
async function setManualCoordinates(eventId, lat, lng) {
  const la = coordNumber(lat);
  const ln = coordNumber(lng);
  if (!Number.isFinite(la) || la < -90 || la > 90) return { ok: false, error: 'Latitude must be a number between -90 and 90' };
  if (!Number.isFinite(ln) || ln < -180 || ln > 180) return { ok: false, error: 'Longitude must be a number between -180 and 180' };
  const { rows } = await db.query(
    `UPDATE events
        SET lat=$2, lng=$3, coordinates_manually_overridden=true, geocoding_status='manual',
            geocoding_error=NULL, geocoding_source='manual', geocoded_at=NOW()
      WHERE id=$1 RETURNING id, lat, lng, geocoding_status`,
    [eventId, la, ln]);
  if (!rows[0]) return { ok: false, error: 'Event not found' };
  return { ok: true, event: rows[0] };
}

module.exports = { geocodeEvent, geocodeEventSafe, setManualCoordinates };
