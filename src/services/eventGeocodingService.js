'use strict';

/**
 * Applies geocoding results to EVENT records — the events counterpart of auctionGeocodingService.
 *
 * Two-tier, identical privacy model to auctions:
 *   internal_lat / internal_lng  the precise geocoded point (private; never published)
 *   lat / lng                    the public marker = a deterministic ~0.10mi OFFSET of the precise
 *                                point (services/geocoding/publicCoordinates.js), keyed on the event
 *                                id so it is stable across page loads, deploys, and repeated imports.
 *
 * Events store the street address in `address` and the region in `state` (auctions use street_address
 * / address_state); toLocation() is the only adaptation — everything else reuses the shared seam
 * (fingerprint, shouldGeocode, Mapbox provider). Enrichment only: never throws into a save/publish.
 */

const db = require('../db');
const {
  geocodeAuctionLocation,
  publicCoordinatesFor,
  shouldGeocode,
} = require('./geocoding');
const { coordNumber } = require('./geocoding/publicCoordinates');

const COLS = 'id, address, city, state, zip, lat, lng, internal_lat, internal_lng, location_fingerprint, event_format, status';

// Map an events row onto the location shape the geocoding seam expects. The coordinate-presence signal
// is the INTERNAL (precise) point — that is what "do we already have a fix on this location" means now.
function toLocation(ev) {
  ev = ev || {};
  return {
    street_address: ev.address || null,
    city: ev.city || null,
    address_state: ev.state || null,
    zip: ev.zip || null,
    lat: ev.internal_lat,
    lng: ev.internal_lng,
    location_fingerprint: ev.location_fingerprint,
    // events have no coordinates_manually_overridden column → undefined → treated as not overridden
  };
}

async function loadEvent(eventId, runner) {
  const { rows } = await (runner || db).query(`SELECT ${COLS} FROM events WHERE id = $1`, [eventId]);
  return rows[0] || null;
}

/**
 * Derive + persist the PUBLIC offset marker from the stored EXACT internal point. Pure computation —
 * no provider call — so it is cheap, and safe to run inside an import transaction (pass the client as
 * `runner`). Keyed on the event id → the same event always resolves to the same public marker.
 * Never invents a location: with no internal point it makes no change.
 */
async function deriveAndStorePublicOffset(runner, eventId) {
  const ev = await loadEvent(eventId, runner);
  if (!ev) return { ok: false, status: 'not_found' };
  const la = coordNumber(ev.internal_lat);
  const ln = coordNumber(ev.internal_lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return { ok: false, status: 'no_internal_point' };

  const pub = publicCoordinatesFor({ auctionId: eventId, lat: la, lng: ln, fingerprint: ev.location_fingerprint });
  if (!pub) return { ok: false, status: 'offset_failed' };

  await (runner || db).query('UPDATE events SET lat = $2, lng = $3 WHERE id = $1', [eventId, pub.lat, pub.lng]);
  return { ok: true, public: pub };
}

// Record a geocoding attempt that produced no usable coordinates. Never blanks existing coordinates.
async function recordFailure(eventId, result) {
  await db.query(
    `UPDATE events SET geocoding_status = $2, geocoding_source = $3, geocoded_at = NOW() WHERE id = $1`,
    [eventId, result.status, result.source || null]
  );
  return { ok: false, status: result.status, error: result.error || null };
}

/**
 * Geocode ONE event: precise point → internal_lat/lng, offset → lat/lng. Failure-tolerant.
 * @param {string} eventId
 * @param {object} [opts] { force }
 */
async function geocodeEvent(eventId, opts) {
  const force = Boolean(opts && opts.force);
  const ev = await loadEvent(eventId);
  if (!ev) return { ok: false, status: 'not_found', error: 'Event not found' };

  const decision = shouldGeocode(toLocation(ev), { force });
  if (!decision.geocode) return { ok: true, skipped: true, status: decision.reason };

  const result = await geocodeAuctionLocation(toLocation(ev));
  if (!result.ok) return recordFailure(eventId, result);

  const pub = publicCoordinatesFor({ auctionId: eventId, lat: result.lat, lng: result.lng, fingerprint: result.fingerprint });
  if (!pub) {
    return recordFailure(eventId, { status: 'failed', error: 'Could not derive public display coordinates', source: result.source });
  }

  await db.query(
    `UPDATE events
        SET internal_lat = $2, internal_lng = $3,
            lat = $4, lng = $5,
            location_fingerprint = $6,
            geocoding_status = 'ok', geocoding_source = $7, geocoded_at = NOW()
      WHERE id = $1`,
    [eventId, result.lat, result.lng, pub.lat, pub.lng, result.fingerprint, result.source]
  );
  return { ok: true, status: 'ok', public: pub, normalized: result.normalized || null };
}

// Fire-and-forget wrapper for save/publish paths — never rejects, so a provider problem can never
// surface as a failed event save.
async function geocodeEventSafe(eventId, opts) {
  try {
    return await geocodeEvent(eventId, opts);
  } catch (err) {
    console.error('[geocoding] non-fatal failure for event', eventId, err.message);
    try { await recordFailure(eventId, { status: 'failed', error: 'Unexpected geocoding error', source: 'mapbox' }); } catch (e) { /* best-effort */ }
    return { ok: false, status: 'failed', error: 'Unexpected geocoding error' };
  }
}

/**
 * Events eligible for the backfill: published, not archived, PHYSICAL (not online), active/upcoming,
 * with a usable address but no public marker. Online-only events are excluded (no physical pin), and
 * an event without any address is never invented a location.
 */
async function findMissingEventCoordinates(limit = 500) {
  const { rows } = await db.query(
    `SELECT ${COLS}
       FROM events
      WHERE status = 'published'
        AND COALESCE(event_format, '') <> 'online'
        AND (end_at IS NULL OR end_at > now())
        AND (lat IS NULL OR lng IS NULL)
        AND COALESCE(NULLIF(TRIM(COALESCE(address, '')), ''),
                     NULLIF(TRIM(COALESCE(zip, '')), ''),
                     NULLIF(TRIM(COALESCE(city, '')), '')) IS NOT NULL
      ORDER BY start_at ASC NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = {
  geocodeEvent,
  geocodeEventSafe,
  deriveAndStorePublicOffset,
  findMissingEventCoordinates,
  toLocation,
};
