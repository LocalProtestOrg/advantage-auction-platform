'use strict';

/**
 * dedupe — the 4-tier duplicate-match ladder + content-hash change detection (§11 of the plan).
 * First match wins; ambiguity is SKIPPED and logged, never guessed; soft matches are created-but-flagged,
 * never auto-merged. The classification (resolve) and signal functions are PURE and unit-tested per tier;
 * only the candidate-gathering `dedupe(db, …)` touches the DB.
 *
 * Ladder:
 *   1. (source_id, source_event_id)     → update path
 *   2. normalized source_url hash        → update path
 *   3. event fingerprint (organizer‖street‖start-date), exactly one → link+update; many → 'ambiguous'
 *   4. soft signal: same ZIP + same start date + title similarity ≥ threshold → create + possible_duplicate
 *
 * Change detection: content_hash equal → 'unchanged' (zero writes). images_hash drives image re-sync.
 */

const { sha256, normalizeUrlForHash } = require('./normalize/canonical');

// Derive the tier-2 source-url hash from a record (normalized-URL → sha256), or null when no URL.
function sourceUrlHashOf(record) {
  if (record && record.sourceUrlHash) return record.sourceUrlHash;
  const u = record && record.sourceUrl;
  return u ? sha256(normalizeUrlForHash(u)) : null;
}

// ── normalization + signals (pure) ──────────────────────────────────────────────
const strip = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const utcDate = (iso) => String(iso == null ? '' : iso).slice(0, 10); // YYYY-MM-DD (UTC)

// Tier-3 key. `e` carries { organizer_name, address, start_at }.
function eventFingerprint(e) {
  e = e || {};
  return sha256([strip(e.organizer_name), strip(e.address), utcDate(e.start_at)].join(''));
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'sale', 'estate', 'auction', 'at', 'in', 'on', 'for']);
function titleTokens(s) { return new Set(strip(s).split(' ').filter((t) => t && !STOP.has(t))); }
// Jaccard similarity of significant title tokens, 0..1.
function titleSimilarity(a, b) {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// ── change detection (pure) ─────────────────────────────────────────────────────
function changeDetect(record, existing) {
  const unchanged = !!(existing && existing.content_hash && existing.content_hash === record.contentHash);
  const imagesChanged = !existing || !existing.images_hash || existing.images_hash !== record.imagesHash;
  return { unchanged, imagesChanged };
}

// ── classification (pure) — `found` is what the DB layer gathered ────────────────
// found = { bySourceEventId, bySourceUrl, byFingerprint:[id...], bySoftSignal:[id...] }
function resolve(record, found) {
  found = found || {};
  const exact = found.bySourceEventId || found.bySourceUrl;
  if (exact) {
    const via = found.bySourceEventId ? 'source_event_id' : 'source_url';
    const { unchanged, imagesChanged } = changeDetect(record, exact);
    return { outcome: unchanged ? 'unchanged' : 'update', eventId: exact.event_id, matchVia: via, imagesChanged, possibleDuplicate: false };
  }
  const fp = found.byFingerprint || [];
  if (fp.length === 1) return { outcome: 'update', eventId: fp[0], matchVia: 'fingerprint', imagesChanged: true, possibleDuplicate: false };
  if (fp.length > 1) return { outcome: 'ambiguous', reason: 'fingerprint_multi', candidates: fp.slice(0, 10) };
  const soft = found.bySoftSignal || [];
  if (soft.length >= 1) return { outcome: 'create', possibleDuplicate: true, softMatches: soft.slice(0, 10) };
  return { outcome: 'create', possibleDuplicate: false };
}

// ── DB-backed ladder ─────────────────────────────────────────────────────────────
async function dedupe(db, record, ctx) {
  ctx = ctx || {};
  const sourceId = ctx.sourceId;
  const threshold = ctx.softTitleThreshold != null ? ctx.softTitleThreshold : 0.6;
  const c = (record && record.canonical) || {};
  const found = { bySourceEventId: null, bySourceUrl: null, byFingerprint: [], bySoftSignal: [] };

  // Tier 1
  if (record.sourceEventId != null) {
    const r = await db.query('SELECT event_id, content_hash, images_hash FROM event_sources WHERE source_id=$1 AND source_event_id=$2', [sourceId, String(record.sourceEventId)]);
    if (r.rows[0]) found.bySourceEventId = r.rows[0];
  }
  // Tier 2
  const sourceUrlHash = sourceUrlHashOf(record);
  if (!found.bySourceEventId && sourceUrlHash) {
    const r = await db.query('SELECT event_id, content_hash, images_hash FROM event_sources WHERE source_id=$1 AND source_url_hash=$2', [sourceId, sourceUrlHash]);
    if (r.rows[0]) found.bySourceUrl = r.rows[0];
  }
  // Tiers 3 & 4 — candidate events sharing the UTC start date and the ZIP or city/state.
  if (!found.bySourceEventId && !found.bySourceUrl) {
    const startDate = utcDate(c.start_at);
    if (startDate && (c.zip || (c.city && c.state))) {
      const rows = (await db.query(
        `SELECT id, organizer_name, address, title, start_at, zip
           FROM events
          WHERE (start_at AT TIME ZONE 'UTC')::date = $1::date
            AND COALESCE(status,'') <> 'archived'
            AND ( ($2::text IS NOT NULL AND zip = $2)
               OR ($3::text IS NOT NULL AND lower(city) = lower($3) AND upper(state) = upper($4)) )`,
        [startDate, c.zip || null, c.city || null, c.state || null])).rows;
      const fp = eventFingerprint(c);
      for (const e of rows) if (eventFingerprint(e) === fp) found.byFingerprint.push(e.id);
      if (!found.byFingerprint.length) {
        for (const e of rows) {
          if (e.zip && c.zip && e.zip === c.zip && titleSimilarity(e.title, c.title) >= threshold) found.bySoftSignal.push(e.id);
        }
      }
    }
  }
  return resolve(record, found);
}

module.exports = { eventFingerprint, titleSimilarity, titleTokens, changeDetect, resolve, dedupe, sourceUrlHashOf, strip, utcDate };
