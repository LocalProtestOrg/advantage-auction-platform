'use strict';

/**
 * marketResolver — resolve an event's location to a curated market, with a permanent 'national'
 * fallback so imports never fail on geography (§6 of docs/event-import-framework-plan.md).
 *
 * Resolution order (first match wins), returning { marketSlug, via }:
 *   1. radius     — nearest ACTIVE market whose center is within its radius_km (great-circle)
 *   2. zip        — longest ZIP-prefix rule that prefixes the event's ZIP
 *   3. city_state — exact (case-insensitive) city + state rule
 *   4. fallback   — 'national'
 *
 * The pure `resolve(input, rules)` has no DB dependency (unit-tested). `resolveWithDb(db, input)`
 * loads the rules, calls resolve, and — on fallback — bumps the metro discovery queue
 * (market_candidates) so admins can promote a real metro later. No secrets, no PII persisted here.
 */

const FALLBACK = 'national';

// Great-circle distance in km between two lat/lng points.
function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const finite = (v) => typeof v === 'number' && isFinite(v);
const digits = (s) => String(s == null ? '' : s).replace(/[^0-9]/g, '');
const normCity = (s) => String(s == null ? '' : s).trim().toLowerCase();
const normState = (s) => String(s == null ? '' : s).trim().toUpperCase();

// Normalized dedup key for the metro discovery queue.
function candidateKey(city, state) {
  const c = normCity(city), s = normState(state);
  return (c || s) ? (c + '|' + s) : '';
}

/**
 * Pure resolver. `rules` = { markets:[{slug,center_lat,center_lng,radius_km}],
 *   zipRules:[{zip_prefix,market_slug}], cityRules:[{city,state,market_slug}], fallback? }.
 */
function resolve(input, rules) {
  input = input || {};
  rules = rules || {};
  const fallback = rules.fallback || FALLBACK;

  // 1) radius — nearest active market within its radius.
  if (finite(input.lat) && finite(input.lng)) {
    let best = null;
    for (const m of rules.markets || []) {
      if (!finite(m.center_lat) || !finite(m.center_lng) || !finite(m.radius_km)) continue;
      const d = haversineKm(input.lat, input.lng, m.center_lat, m.center_lng);
      if (d <= m.radius_km && (!best || d < best.d)) best = { slug: m.slug, d };
    }
    if (best) return { marketSlug: best.slug, via: 'radius' };
  }

  // 2) zip — longest matching prefix wins (more specific rule beats a broader one).
  const zip = digits(input.zip);
  if (zip) {
    let best = null;
    for (const r of rules.zipRules || []) {
      const pfx = digits(r.zip_prefix);
      if (pfx && zip.slice(0, pfx.length) === pfx && (!best || pfx.length > best.len)) best = { slug: r.market_slug, len: pfx.length };
    }
    if (best) return { marketSlug: best.slug, via: 'zip' };
  }

  // 3) city + state exact (case-insensitive).
  if (input.city && input.state) {
    const c = normCity(input.city), s = normState(input.state);
    for (const r of rules.cityRules || []) {
      if (normCity(r.city) === c && normState(r.state) === s) return { marketSlug: r.market_slug, via: 'city_state' };
    }
  }

  // 4) fallback.
  return { marketSlug: fallback, via: 'fallback' };
}

/**
 * DB-backed resolve. Loads active markets + curated rules, resolves, and on fallback records the
 * metro in market_candidates (idempotent upsert). Fail-open: returns national on any error.
 */
async function resolveWithDb(db, input, opts) {
  opts = opts || {};
  const record = opts.record !== false; // dry-run passes record:false → no market_candidates write
  try {
    const markets = (await db.query(
      `SELECT slug, center_lat, center_lng, radius_km FROM event_markets
        WHERE is_active = true AND center_lat IS NOT NULL AND center_lng IS NOT NULL AND radius_km IS NOT NULL`)).rows;
    const rulesRows = (await db.query(
      `SELECT market_slug, zip_prefix, city, state FROM event_market_zips`)).rows;
    const zipRules = rulesRows.filter((r) => r.zip_prefix != null);
    const cityRules = rulesRows.filter((r) => r.city != null && r.state != null);

    const out = resolve(input, { markets, zipRules, cityRules, fallback: FALLBACK });

    if (out.via === 'fallback' && record) {
      const key = candidateKey(input.city, input.state);
      if (key) {
        await db.query(
          `INSERT INTO market_candidates (candidate_key, city, state, event_count, last_seen_at)
           VALUES ($1, $2, $3, 1, now())
           ON CONFLICT (candidate_key)
           DO UPDATE SET event_count = market_candidates.event_count + 1, last_seen_at = now()`,
          [key, input.city || null, input.state || null]);
      }
    }
    return out;
  } catch (e) {
    return { marketSlug: FALLBACK, via: 'fallback' };
  }
}

module.exports = { resolve, resolveWithDb, haversineKm, candidateKey, FALLBACK };
