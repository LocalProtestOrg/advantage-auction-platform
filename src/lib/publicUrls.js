'use strict';
// Centralized public-URL / allowed-origin resolution (bid.advantage.bid cutover).
//
// Two concerns, deliberately separated so a multi-origin transition window
// (e.g. the Railway URL AND bid.advantage.bid live at once) does not break
// buyer-facing links:
//   • allowedOrigins() — the CORS / socket.io allow-list. FRONTEND_URL may be a
//     comma-separated list; ALLOWED_ORIGINS can add more. Used for access control.
//   • publicBaseUrl()  — the single canonical base used to BUILD links (emails,
//     etc.). Prefers PUBLIC_BASE_URL, else the first FRONTEND_URL origin, else a
//     safe live default. Never a comma-list.
//
// Defaults preserve today's behavior when env is unset (no breaking change); the
// cutover is achieved by setting FRONTEND_URL / PUBLIC_BASE_URL (see the cutover
// plan doc). DEFAULT_BUYER_BASE stays a currently-live domain on purpose.
const DEFAULT_BUYER_BASE = 'https://advantageauction.bid';
const DEV_ORIGIN = 'http://localhost:3001';

function splitList(v) {
  return String(v == null ? '' : v).split(',').map(s => s.trim()).filter(Boolean);
}
function firstOrigin(v) {
  const l = splitList(v);
  return l.length ? l[0] : '';
}
// The CORS / socket.io allow-list (deduped). Falls back to the dev origin.
function allowedOrigins() {
  const list = [...splitList(process.env.FRONTEND_URL), ...splitList(process.env.ALLOWED_ORIGINS)];
  const uniq = [...new Set(list)];
  return uniq.length ? uniq : [DEV_ORIGIN];
}
function isOriginAllowed(origin) {
  return !!origin && allowedOrigins().indexOf(origin) !== -1;
}
// The canonical base for building buyer-facing links (single origin, never a list).
function publicBaseUrl() {
  const pub = process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim();
  return pub || firstOrigin(process.env.FRONTEND_URL) || DEFAULT_BUYER_BASE;
}

module.exports = { allowedOrigins, isOriginAllowed, publicBaseUrl, firstOrigin, splitList, DEFAULT_BUYER_BASE, DEV_ORIGIN };
