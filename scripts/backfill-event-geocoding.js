#!/usr/bin/env node
/*
 * backfill-event-geocoding.js — fills PUBLIC display coordinates for published, physical, active
 * events that have a usable address but no marker on the map. The events counterpart of
 * backfill-auction-geocoding.js.
 *
 * Safety / idempotence:
 *   - Selects ONLY eligible rows (published, not archived, physical/not-online, active/upcoming,
 *     address present, lat/lng NULL). Re-running is a no-op once a marker exists.
 *   - Online-only events and address-less events are never selected (no invented location).
 *   - Per-row isolation: one failure never aborts the run.
 *   - Stores the precise point in internal_lat/lng and publishes only the ~0.10mi OFFSET in lat/lng;
 *     asserts the published marker really is ~0.10mi from the precise point (privacy check).
 *   - --dry-run geocodes nothing; only reports what WOULD be processed.
 *   - --limit=N bounds the batch (default 100).
 *
 *   railway run --service advantage-auction-platform node scripts/backfill-event-geocoding.js [--dry-run] [--limit=N]
 *
 * Requires MAPBOX_GEOCODING_TOKEN. Without it the run aborts before any write (nothing is billed).
 */

const db = require('../src/db');
const svc = require('../src/services/eventGeocodingService');
const { distanceMeters, OFFSET_METERS } = require('../src/services/geocoding/publicCoordinates');
const { isConfigured } = require('../src/services/geocoding');

const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 100) : 100;

async function main() {
  if (!isConfigured()) {
    console.error('MAPBOX_GEOCODING_TOKEN is not set — every row would report "unconfigured".');
    console.error('Set it in the production service environment and re-run. Nothing was written.');
    process.exit(1);
  }

  const targets = await svc.findMissingEventCoordinates(LIMIT);
  const counts = { attempted: 0, ok: 0, ambiguous: 0, no_result: 0, skipped: 0, already: 0, error: 0, offset_fail: 0 };
  console.log(`Eligible events missing public coordinates: ${targets.length}${DRY ? '  (DRY RUN)' : ''}  (limit ${LIMIT})\n`);
  if (!targets.length) { console.log('Nothing to backfill.'); return; }

  for (const e of targets) {
    const where = [e.city, e.state, e.zip].filter(Boolean).join(', ') || '(no location)';
    const label = `${String(e.id).slice(0, 8)}  ${where}`;
    if (DRY) { console.log(`WOULD GEOCODE  ${label}`); continue; }

    counts.attempted++;
    let result;
    try { result = await svc.geocodeEvent(e.id); }
    catch (err) { counts.error++; console.log(`FAIL           ${label}  — unexpected: ${err.message}`); continue; }

    if (result.skipped) { counts.skipped++; console.log(`SKIP           ${label}  — ${result.status}`); continue; }
    if (!result.ok) {
      if (result.status === 'insufficient_location') counts.no_result++;
      else counts.no_result++;
      console.log(`NO-RESULT      ${label}  — ${result.status}: ${result.error || 'no detail'}`);
      continue;
    }

    // Privacy assertion: the published marker must be the offset, not the precise point.
    const { rows } = await db.query('SELECT lat, lng, internal_lat, internal_lng FROM events WHERE id = $1', [e.id]);
    const r = rows[0] || {};
    const d = (r.internal_lat != null && r.lat != null)
      ? distanceMeters(r.internal_lat, r.internal_lng, r.lat, r.lng) : null;
    if (d == null || d < OFFSET_METERS - 5 || d > OFFSET_METERS + 5) {
      counts.offset_fail++;
      console.log(`FAIL           ${label}  — offset check failed (${d == null ? 'no internal point' : Math.round(d) + 'm'})`);
      continue;
    }
    counts.ok++;
    console.log(`OK             ${label}  → marker ${r.lat}, ${r.lng}  (${Math.round(d)}m from precise point)`);
  }

  console.log(`\nAttempted: ${counts.attempted}  OK: ${counts.ok}  No-result: ${counts.no_result}  ` +
    `Skipped: ${counts.skipped}  Offset-fail: ${counts.offset_fail}  Errors: ${counts.error}  Of: ${targets.length}`);
  if (counts.error || counts.offset_fail || counts.no_result) {
    console.log('Unwritten rows keep their previous state and can be retried.');
  }
}

main()
  .catch((err) => { console.error('Backfill aborted:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
