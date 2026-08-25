'use strict';

/**
 * lmauctionConnector — Lewis & Maese Auction Co. (www.lmauctionco.com), a Houston, TX auction house.
 * ORIGINAL-HOST, image-capable auctions. OWNER-AUTHORIZED source (explicit): discover publicly
 * advertised Lewis & Maese auctions, publish qualifying events, follow the original L&M catalog URLs,
 * retrieve publicly-accessible event-specific images, re-host via Cloudinary with provenance, and
 * revisit on a recurring schedule. Attribution stays "Lewis & Maese" and every event links to its
 * original L&M catalog page. Technical access controls are still respected — no auth/CAPTCHA/private
 * resource circumvention; only the public upcoming-auctions listing + public catalog pages are read.
 *
 * ACCESS BASIS (documented 2026-08-25):
 *   • Owner explicitly authorized this source by name (LMAuctionCo.com).
 *   • The public listing /auctions/upcoming-auctions/ and each /auction-catalog/{slug}_{REF} page serve
 *     over HTTP 200 to a normal browser UA. robots.txt is edge-blocked (403, no readable policy); given
 *     explicit owner authorization we read ONLY those public, human-facing pages, gently (crawl delay +
 *     small cap), and never touch any gated/login/API path.
 *   • The site is WordPress + the Invaluable "ConnectWP" catalog widget. There is no og:image / JSON-LD
 *     Event block, so we parse the human-readable page: the <title>, the "Month DD, YYYY HH:MM AM/PM TZ"
 *     start datetime, and the public Invaluable `image.invaluable.com/housePhotos/lmauctionco/...` photos.
 *
 * Flow (gentle): upcoming-auctions listing → catalog links → (cap) each catalog page → parse title/date/
 * images → canonical payload. Images are surfaced INLINE (so events publish with a real image on every
 * run, incl. scheduled) and the enrichment pass can re-host them to Cloudinary with provenance.
 */

const { fetchText } = require('../http');
const { IDENTITY_FIELD_MAP } = require('../normalize/identityFieldMap');
const { localToUtcIso } = require('../../../lib/timezoneUtils');

const BASE = 'https://www.lmauctionco.com';
const UPCOMING_URL = BASE + '/auctions/upcoming-auctions/';
const DEFAULT_TZ = 'America/Chicago';     // Houston, TX
const DEFAULT_CAP = 25;                    // gentle per-run cap
const CRAWL_DELAY_MS = 3000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const MAX_IMAGES = 3;

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12 };
// The site quotes US Central time (CDT/CST); anything else we still anchor to Central (the house's tz).
const TZ_ABBR = { cdt: DEFAULT_TZ, cst: DEFAULT_TZ, ct: DEFAULT_TZ, edt: 'America/New_York', est: 'America/New_York' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetchText returns { ok, status, text }; return the body only on a usable 2xx, else null.
async function getText(url, opts) {
  const r = await fetchText(url, Object.assign({ headers: { 'User-Agent': BROWSER_UA } }, opts));
  return r && r.ok && typeof r.text === 'string' ? r.text : null;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#x2F;|&#47;/g, '/').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

// Extract unique catalog links (path only) from the upcoming-auctions listing HTML.
function parseUpcomingLinks(html) {
  const paths = (String(html || '').match(/\/auction-catalog\/[a-z0-9\-]+_[A-Z0-9]+/gi) || []);
  return [...new Set(paths)];
}

// The stable reference id is the trailing _{REF} of the catalog slug.
function refFromPath(path) {
  const m = String(path || '').match(/_([A-Z0-9]+)\s*$/);
  return m ? m[1] : String(path || '');
}

// Clean the catalog <title> into a human auction title.
function titleFromHtml(html) {
  const m = String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return null;
  let t = decodeEntities(m[1]);
  t = t.replace(/^\s*Catalog\s*[-–—:]\s*/i, '');   // drop the "Catalog - " widget prefix
  t = t.replace(/\s*\|\s*/g, ' — ');               // "A | B" → "A — B"
  return t || null;
}

// Parse the first "Month DD, YYYY HH:MM AM/PM TZ" start datetime → { startIso, tz } (or null).
function parseStart(html) {
  const m = String(html || '').match(/([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*([A-Za-z]{2,4})?/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  const day = parseInt(m[2], 10), year = parseInt(m[3], 10);
  let hour = parseInt(m[4], 10); const min = parseInt(m[5], 10);
  const ap = m[6].toUpperCase();
  if (ap === 'PM' && hour !== 12) hour += 12;
  if (ap === 'AM' && hour === 12) hour = 0;
  const tz = (m[7] && TZ_ABBR[m[7].toLowerCase()]) || DEFAULT_TZ;
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${year}-${pad(mon)}-${pad(day)}T${pad(hour)}:${pad(min)}`;
  let startIso; try { startIso = localToUtcIso(local, tz); } catch (_) { return null; }
  return { startIso, tz, year, mon, day, hour, min };
}

// Public Invaluable event photos (housePhotos), prefer larger "-L" renditions; dedupe; cap.
function parseImages(html) {
  const all = [...new Set((String(html || '').match(/https?:\/\/[^"'\s)]*housePhotos\/lmauctionco[^"'\s)]*/gi) || []))]
    .filter((u) => /\.(jpe?g|png|webp)$/i.test(u));
  const large = all.filter((u) => /H\d+-L/i.test(u));   // "-L" = large rendition
  const ordered = [...large, ...all.filter((u) => !large.includes(u))];
  return ordered.slice(0, MAX_IMAGES).map((url, i) => ({ url, position: i, is_cover: i === 0 }));
}

// Parse one catalog page → { payload, images } or null (not a usable upcoming auction).
function parseDetail(html, catalogUrl, tzHint) {
  if (!html) return null;
  const title = titleFromHtml(html);
  if (!title) return null;
  const st = parseStart(html);
  if (!st) return null;                               // need a real start (and thus end) for expiration
  const tz = st.tz || tzHint || DEFAULT_TZ;
  // Live in-person Houston auction: give it a reliable same-day end (23:59 local) for expiration.
  const pad = (n) => String(n).padStart(2, '0');
  const endLocal = `${st.year}-${pad(st.mon)}-${pad(st.day)}T23:59`;
  let endIso; try { endIso = localToUtcIso(endLocal, tz); } catch (_) { return null; }
  const images = parseImages(html);
  return {
    payload: {
      title,
      description: null,
      sale_type: 'auction',
      event_format: 'live',                           // in-person Houston auction (online bidding via host)
      start_at: st.startIso,
      end_at: endIso,
      timezone: tz,
      city: 'Houston',
      state: 'TX',
      organizer_name: 'Lewis & Maese',                // required attribution (host_company gate)
      external_url: catalogUrl,                        // ORIGINAL L&M catalog page
      bidding_url: catalogUrl,
    },
    images,
  };
}

module.exports = {
  key: 'lmauction',
  capabilities: { incremental: false, deletions: false, images: true },
  fieldMap: IDENTITY_FIELD_MAP,

  parseUpcomingLinks, parseDetail, titleFromHtml, parseStart, parseImages, refFromPath,  // for unit tests

  async *fetch({ config, limit, signal } = {}) {
    config = config || {};
    const tz = config.timezone || DEFAULT_TZ;
    const cap = Math.min(limit != null ? limit : (config.cap || DEFAULT_CAP), config.cap || DEFAULT_CAP);
    const fetchOpts = { timeoutMs: 30000, maxBytes: 8 * 1024 * 1024, signal };

    let listing; try { listing = await getText(UPCOMING_URL, fetchOpts); } catch (_) { return; }
    if (!listing) return;
    const paths = parseUpcomingLinks(listing);

    let n = 0;
    for (const path of paths) {
      if (n >= cap) return;
      const catalogUrl = BASE + path;
      await sleep(CRAWL_DELAY_MS);
      let html; try { html = await getText(catalogUrl, fetchOpts); } catch (_) { continue; }
      const mapped = parseDetail(html, catalogUrl, tz);
      if (!mapped) continue;
      // Defense-in-depth: skip already-ended auctions (publicationGate also blocks expired).
      if (mapped.payload.end_at && new Date(mapped.payload.end_at).getTime() < Date.now()) continue;
      yield {
        sourceEventId: refFromPath(path),
        sourceUrl: catalogUrl,
        sourceUpdatedAt: null,
        payload: mapped.payload,
        images: mapped.images,
      };
      n++;
    }
  },

  describe() {
    return { name: 'Lewis & Maese Auction Co. (Houston, TX auction house)',
      docs: 'www.lmauctionco.com — OWNER-AUTHORIZED original-host auctions; public upcoming listing + catalog pages; Invaluable housePhotos images re-hosted to Cloudinary with provenance.' };
  },
};
