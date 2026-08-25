'use strict';

/**
 * imageEnrichment — BEST-EFFORT, decoupled retrieval of ONE legitimate, publicly-accessible,
 * event-specific image for an external auction event. It NEVER fails ingestion and NEVER blocks
 * publication: an event without a real image keeps its branded placeholder (see govSurplusPlaceholder
 * 3-tier fallback). It NEVER defeats authentication — a login-gated / non-200 / non-image response is
 * treated as "no usable image" and skipped.
 *
 * Flow (per event):
 *   1. If a usable (publicly-displayable, non-login-gated) image is already stored → skip.
 *   2. Resolve a CANDIDATE public image URL for the event's source (source-specific).
 *      - GSA / Federal-Surplus: the only image is www.ppms.gov, which requires an interactive login
 *        (401 "Please login again") — PROVEN not publicly retrievable. Returns none (→ placeholder).
 *   3. Validate the candidate: HTTPS GET, must be 200 + an image/* content-type + within size limits +
 *      not a login-gated host. Otherwise reject with a reason.
 *   4. Re-host the validated bytes into managed storage (Cloudinary) and record it in event_images with
 *      provenance (source_url/source_host/retrieved_at). Managed storage avoids fragile hotlinks.
 *
 * Only image RETRIEVAL is here; source event ingestion is untouched. Enrichment runs after
 * ingestion/publication or on its own schedule/script.
 */

const https = require('https');
const db0 = require('../../db');
const { isNonPublicImage } = require('../../lib/govSurplusPlaceholder');
const { extractImageCandidates } = require('./detailImage');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const LOGIN_GATED_HINT = /login|sign\s?in|token expired|unauthor/i;
// Hosts we must NOT scrape for images (login-gated GSA source, and discovery directories — original
// hosts only). Kept deliberately small and explicit.
const SKIP_DETAIL_HOSTS = /(ppms\.gov|gsaauctions\.gov|estatesales\.(net|org|com)|bidsquare\.com|auctionzip\.com|hibid\.com)/i;

// Ordered CANDIDATE public image URLs for an event (best first). Sync fast-path returns a feed-supplied
// image; otherwise the async resolver fetches the ORIGINAL-HOST detail page and extracts candidates.
function candidateImageUrl(event) {
  const existing = event.candidate_image_url || null;
  if (existing && /^https?:\/\//i.test(existing) && !isNonPublicImage(existing)) return existing;
  return null; // no feed-supplied image (GSA etc.) — the async resolver may still find one on the detail page
}

// Async: resolve candidates, including a second-stage fetch of the original event detail page.
async function resolveCandidates(event, deps = {}) {
  const feed = candidateImageUrl(event);
  if (feed) return [feed];
  const url = event.external_url;
  if (!url || !/^https?:\/\//i.test(url)) return [];
  let host = ''; try { host = new URL(url).hostname; } catch (_) { return []; }
  if (SKIP_DETAIL_HOSTS.test(host)) return []; // login-gated / directory / JS-shell → placeholder stays
  const fetchText = deps.fetchText || ((u) => require('../http').fetchText(u, { timeoutMs: 20000, maxBytes: 4 * 1024 * 1024 }));
  let html;
  try { html = await fetchText(url); } catch (_) { return []; }
  return extractImageCandidates(html, url);
}

function fetchImage(url) {
  return new Promise((resolve) => {
    try {
      const req = https.request(url, { method: 'GET', timeout: 20000, headers: { 'User-Agent': 'AdvantageBid-ImageEnrichment/1.0', Accept: 'image/*' } }, (resp) => {
        const chunks = []; let bytes = 0; let aborted = false;
        resp.on('data', (c) => { bytes += c.length; if (bytes > MAX_IMAGE_BYTES) { aborted = true; req.destroy(); return; } chunks.push(c); });
        resp.on('end', () => resolve({ status: resp.statusCode, ctype: String(resp.headers['content-type'] || ''), body: aborted ? null : Buffer.concat(chunks) }));
      });
      req.on('error', (e) => resolve({ status: 0, err: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
      req.end();
    } catch (e) { resolve({ status: 0, err: e.message }); }
  });
}

// Validate a candidate image response is a genuinely-public, usable image (not a login page/401).
function isUsableImageResponse(r) {
  if (!r || r.status !== 200) return { ok: false, reason: r && r.status === 401 ? 'login_gated' : ('http_' + (r ? r.status : 'error')) };
  if (!/^image\//i.test(r.ctype)) return { ok: false, reason: 'not_an_image' };            // e.g. JSON login error served as 200
  if (!r.body || r.body.length < 512) return { ok: false, reason: 'too_small' };
  const head = r.body.slice(0, 64).toString('latin1');
  if (LOGIN_GATED_HINT.test(head)) return { ok: false, reason: 'login_gated' };
  return { ok: true };
}

// Does the event already have a usable stored image?
async function hasUsableStoredImage(db, eventId) {
  const rows = (await db.query('SELECT url FROM event_images WHERE event_id = $1', [eventId])).rows;
  return rows.some((r) => r.url && !isNonPublicImage(r.url));
}

/**
 * Enrich ONE event. Returns { enriched, reason }. Never throws. `deps` allows injecting a fake
 * fetch/uploader in tests.
 */
async function enrichEvent(event, deps = {}) {
  const db = deps.db || db0;
  const doFetch = deps.fetchImage || fetchImage;
  const uploadBuffer = deps.uploadBuffer || (async (buf, opts) => require('../cloudinaryService').uploadBuffer(buf, opts));
  try {
    if (await hasUsableStoredImage(db, event.id)) return { enriched: false, reason: 'already_has_image' };
    const candidates = await resolveCandidates(event, deps);
    if (!candidates.length) return { enriched: false, reason: 'no_public_image_available' };

    // Try candidates in order (best first); store the FIRST that validates as a genuine public image.
    let lastReason = 'no_public_image_available';
    const maxTry = Math.min(candidates.length, 5);
    for (let i = 0; i < maxTry; i++) {
      const candidate = candidates[i];
      const resp = await doFetch(candidate);
      const check = isUsableImageResponse(resp);
      if (!check.ok) { lastReason = check.reason; continue; }

      // Re-host into managed storage (never permanently hotlink a third-party image).
      let hostedUrl;
      try {
        const up = await uploadBuffer(resp.body, { folder: 'event-images', resource_type: 'image' });
        hostedUrl = up.secure_url || up.url || null;
      } catch (e) { lastReason = 'rehost_failed:' + e.message; continue; }
      if (!hostedUrl) { lastReason = 'rehost_failed'; continue; }

      let host = ''; try { host = new URL(candidate).hostname; } catch (_) {}
      await db.query(
        `INSERT INTO event_images (event_id, url, position, is_cover, source_url, source_host, retrieved_at)
         VALUES ($1, $2, 0, true, $3, $4, now())`,
        [event.id, hostedUrl, candidate, host]);
      return { enriched: true, reason: 'stored', url: hostedUrl, source_url: candidate };
    }
    return { enriched: false, reason: lastReason };
  } catch (e) {
    // Best-effort: an enrichment error NEVER propagates to ingestion/publication.
    return { enriched: false, reason: 'error:' + (e && e.message ? e.message : 'unknown') };
  }
}

module.exports = { enrichEvent, candidateImageUrl, resolveCandidates, isUsableImageResponse, fetchImage };
