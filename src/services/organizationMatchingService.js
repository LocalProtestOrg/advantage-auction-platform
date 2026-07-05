'use strict';

/**
 * organizationMatchingService — dedup/matching for Organizations (Phase 3A).
 * Prevents duplicate Organizations when a business is both mirrored from BD and
 * claimed/signed-up directly. `match_key` mirrors the SQL backfill in migration 079
 * (lowercased alphanumerics of name + ':' + lowercased state). Matching is ADVISORY —
 * callers decide whether to link/enrich an existing Organization or create a new one.
 */

const db = require('../db');

/** Deterministic natural key. MUST match the 079 SQL backfill. */
function computeMatchKey(name, state) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const s = String(state || '').toLowerCase().trim();
  return n + ':' + s;
}

async function findByBdListingId(bdListingId) {
  if (!bdListingId) return null;
  const { rows } = await db.query('SELECT * FROM organizations WHERE bd_listing_id = $1 LIMIT 1', [bdListingId]);
  return rows[0] || null;
}

/** Candidate Organizations with the same natural key (advisory dedup surface). */
async function findCandidatesByMatchKey(name, state) {
  const key = computeMatchKey(name, state);
  const { rows } = await db.query(
    'SELECT id, name, city, state, lifecycle_state, bd_listing_id, source FROM organizations WHERE match_key = $1 LIMIT 10',
    [key]);
  return rows;
}

module.exports = { computeMatchKey, findByBdListingId, findCandidatesByMatchKey };
