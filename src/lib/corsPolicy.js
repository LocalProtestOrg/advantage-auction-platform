'use strict';

/**
 * corsPolicy — the ONE narrow cross-origin exception for the Advantage.Bid directory (www.advantage.bid).
 *
 * The directory pages embed the first-party analytics beacon (widgets/shared/local-alerts.js), which POSTs
 * JSON to /api/analytics/events. A JSON POST is preflighted, and the general CORS rule answers a
 * non-allowlisted origin with the primary app origin, so the browser rejected every directory event.
 *
 * The fix is deliberately small:
 *   - exact origins only (the directory's own hosts), never a wildcard, never a pattern;
 *   - exact path only (/api/analytics/events), so no authenticated API becomes reachable from the directory;
 *   - no Access-Control-Allow-Credentials (the beacon sends no cookies, and none are accepted).
 * The general allowlist (FRONTEND_URL / ALLOWED_ORIGINS) is unchanged.
 */

const DIRECTORY_ORIGINS = new Set(['https://www.advantage.bid', 'https://advantage.bid']);
const DIRECTORY_PATHS = new Set(['/api/analytics/events']);

/** The origin to echo for a directory request to an allowed path, or null. Pure. */
function directoryOriginFor(origin, path) {
  if (!origin || !DIRECTORY_ORIGINS.has(origin)) return null;
  return DIRECTORY_PATHS.has(path) ? origin : null;
}

module.exports = { DIRECTORY_ORIGINS, DIRECTORY_PATHS, directoryOriginFor };
