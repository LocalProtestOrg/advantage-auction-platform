#!/usr/bin/env node
/*
 * backfill-auction-geocoding.js — fills in PUBLIC display coordinates for auctions
 * that have a usable location but no marker on the homepage map.
 *
 * Includes the Jersey City Owner Acceptance auction (zip 07302), which lists in the
 * sidebar but has no marker precisely because lat/lng are NULL.
 *
 * Safety / idempotence:
 *   - Selects ONLY rows missing public coordinates (lat IS NULL OR lng IS NULL).
 *     The nine Knoxville auctions with valid coordinates can never be selected, so
 *     re-running is a no-op rather than a re-geocode.
 *   - Never touches a manual admin override.
 *   - Per-row: one row's failure never aborts the run or the other rows.
 *   - Reports every success and failure, and asserts the published marker really is
 *     ~0.10mi from the property (privacy check, not just a "did it write" check).
 *   - --dry-run geocodes nothing and only reports what WOULD be processed.
 *
 *   railway run --service advantage-auction-platform node scripts/backfill-auction-geocoding.js [--dry-run]
 *
 * Requires MAPBOX_GEOCODING_TOKEN in the environment. Without it every row reports
 * 'unconfigured' and nothing is written — safe to run, just useless.
 */

const db = require('../src/db');
const svc = require('../src/services/auctionGeocodingService');
const { distanceMeters, OFFSET_METERS } = require('../src/services/geocoding/publicCoordinates');
const { isConfigured } = require('../src/services/geocoding');

const DRY = process.argv.includes('--dry-run');

async function main() {
  if (!isConfigured()) {
    console.error('MAPBOX_GEOCODING_TOKEN is not set — every row would report "unconfigured".');
    console.error('Set it in the service environment and re-run. Nothing was written.');
    process.exit(1);
  }

  const targets = await svc.findMissingPublicCoordinates();
  console.log(`Auctions missing public coordinates: ${targets.length}${DRY ? '  (DRY RUN)' : ''}\n`);

  if (!targets.length) {
    console.log('Nothing to backfill. Every auction with a usable location already has a marker.');
    return;
  }

  let ok = 0, failed = 0;

  for (const a of targets) {
    const where = [a.city, a.address_state, a.zip].filter(Boolean).join(', ') || '(no location)';
    const label = `${String(a.id).slice(0, 8)}  ${where}`;

    if (DRY) {
      console.log(`WOULD GEOCODE  ${label}`);
      continue;
    }

    let result;
    try {
      result = await svc.geocodeAuction(a.id);
    } catch (err) {
      // Defensive: the service already swallows provider errors, but a backfill must
      // never die halfway and leave the operator guessing which rows were done.
      failed++;
      console.log(`FAIL           ${label}  — unexpected: ${err.message}`);
      continue;
    }

    if (!result.ok) {
      failed++;
      console.log(`FAIL           ${label}  — ${result.status}: ${result.error || 'no detail'}`);
      continue;
    }
    if (result.skipped) {
      console.log(`SKIP           ${label}  — ${result.status}`);
      continue;
    }

    // Privacy assertion: prove the published point is the offset, not the property.
    const { rows } = await db.query(
      'SELECT lat, lng, internal_lat, internal_lng FROM auctions WHERE id = $1',
      [a.id]
    );
    const r = rows[0] || {};
    const d = (r.internal_lat != null && r.lat != null)
      ? distanceMeters(r.internal_lat, r.internal_lng, r.lat, r.lng)
      : null;

    if (d == null || d < OFFSET_METERS - 5 || d > OFFSET_METERS + 5) {
      failed++;
      console.log(`FAIL           ${label}  — offset check failed (${d == null ? 'no internal point' : Math.round(d) + 'm'})`);
      continue;
    }

    ok++;
    console.log(`OK             ${label}  → marker ${r.lat}, ${r.lng}  (${Math.round(d)}m from property)`);
  }

  console.log(`\nBackfilled: ${ok}   Failed: ${failed}   Of: ${targets.length}`);
  if (failed) console.log('Failed rows keep their previous state and can be retried from the admin auction record.');
}

main()
  .catch((err) => { console.error('Backfill aborted:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
