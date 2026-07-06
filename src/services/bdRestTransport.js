'use strict';

/**
 * bdRestTransport — read-only REST transport for the BD directory (Phase 3B).
 * BD API v2 quirks handled here: records live under the `message` array; pagination is
 * cursor-based via an opaque `next_page` token; endpoints occasionally return an empty body
 * (retried). This is the ONLY module that speaks BD REST; a future bdMcpTransport can replace
 * it behind bdDirectoryService with no caller changes.
 */

const BASE = 'https://www.advantage.bid/api/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiKey = () => process.env.BD_API_KEY || '';

async function getWithRetry(path, tries = 4) {
  let last;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(BASE + path, { headers: { 'X-Api-Key': apiKey() } });
      const txt = await r.text();
      if (!txt.trim()) throw new Error('empty body');
      return JSON.parse(txt);
    } catch (e) { last = e; await sleep(700); }
  }
  throw last;
}

/**
 * Fetch all directory listing records. Read-only.
 * BD pagination: the `next_page` token is passed back as the `?page=` query param (NOT
 * `?next_page=`), and `?limit=N` sets the page size. A `seen` set guards against a
 * non-advancing cursor (stops if a page returns no new records).
 */
async function fetchAllListings({ max = 5000, pageSize = 100 } = {}) {
  if (!apiKey()) throw new Error('BD_API_KEY not configured');
  let all = [], cursor = null, iter = 0, total = 0;
  const seen = new Set();
  do {
    const path = '/user/get?limit=' + pageSize + (cursor ? ('&page=' + encodeURIComponent(cursor)) : '');
    const j = await getWithRetry(path);
    total = parseInt(j.total, 10) || total;
    const recs = j.message || [];
    const before = seen.size;
    for (const r of recs) { if (r && r.user_id != null) seen.add(String(r.user_id)); }
    all = all.concat(recs);
    const nx = j.next_page && String(j.next_page).trim();
    cursor = nx || null;
    iter += 1;
    if (cursor && seen.size === before) break; // cursor not advancing — stop to avoid a loop
  } while (cursor && iter < 200 && seen.size < total && all.length < max);
  return { total, records: all, pages: iter, unique: seen.size };
}

module.exports = { fetchAllListings, name: 'rest' };
