'use strict';

/**
 * canonical — the CanonicalEvent shape, sanitizer primitives, end_at derivation, and content hashing
 * for the Event Import Framework normalizer (§5.4, §8 of docs/event-import-framework-plan.md).
 *
 * Pure logic (no DB, no network). Reuses src/lib/timezoneUtils.js for DST-correct wall-time math.
 * The single most important rule here: an imported event MUST have a reliable end_at — end_at IS NULL
 * would mean "never expires". deriveEndAt() always computes one; if it cannot, the record is rejected
 * downstream (validate.js) and never published.
 */

const crypto = require('crypto');
const { DEFAULT_TZ, localToUtcIso, utcIsoToLocalInput } = require('../../../lib/timezoneUtils');

// The canonical field set the normalizer targets (mirrors events + 100_event_import_fields columns).
// Provenance (source_event_id/source_url) is attached by the pipeline, not the normalizer.
const CANONICAL_FIELDS = [
  'title', 'subtitle', 'description', 'sale_type', 'event_format',
  'start_at', 'end_at', 'timezone',
  'venue_name', 'address', 'city', 'state', 'zip', 'lat', 'lng',
  'organizer_name', 'organizer_logo_url', 'organizer_website_url',
  'contact_name', 'contact_phone', 'contact_email',
  'registration_url', 'bidding_url', 'external_url',
  'sale_hours', 'closing_schedule', 'preview_start', 'preview_end', 'pickup_start', 'pickup_end', 'end_date',
  'shipping_available', 'local_pickup_available', 'buyer_premium_bps',
  'payment_methods', 'terms_text', 'category_slug', 'categories', 'tags',
  'images',
];

// ── sanitizer primitives ───────────────────────────────────────────────────────
// Strip control characters (Unicode Cc class) then collapse whitespace.
const collapse = (s) => String(s == null ? '' : s).replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
function text(s, max) { const t = collapse(s); return max && t.length > max ? t.slice(0, max) : t; }
function plainText(s, max) { return text(String(s == null ? '' : s).replace(/<[^>]*>/g, ' '), max); } // strip HTML tags
function url(s) { const t = collapse(s); return /^https?:\/\/[^\s]+$/i.test(t) ? t : null; }
function email(s) { const t = collapse(s).toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) ? t : null; }
function phone(s) { const d = String(s == null ? '' : s).replace(/[^0-9+]/g, ''); return d.replace(/[^0-9]/g, '').length >= 7 ? d.slice(0, 20) : null; }
function boolOrNull(v) { if (v === true || v === false) return v; const t = collapse(v).toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(t)) return true; if (['false', 'no', 'n', '0'].includes(t)) return false; return null; }
function intOrNull(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function floatInRange(v, lo, hi) { const n = parseFloat(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; }
function stringArray(v, max) { const a = Array.isArray(v) ? v : (v == null || v === '' ? [] : String(v).split(/[;,|]/));
  return a.map((x) => text(x, 80)).filter(Boolean).slice(0, max || 25); }
function isoOrNull(v) { if (!v) return null; try { const d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); } catch (e) { return null; } }
function localDateOrNull(v) { const t = collapse(v); return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null; }

// Normalized URL for dedup hashing: lowercase host, strip utm_*/fbclid/gclid, drop fragment + trailing slash.
function normalizeUrlForHash(u) {
  const t = collapse(u); if (!/^https?:\/\//i.test(t)) return t.toLowerCase();
  try {
    const x = new URL(t); x.hash = ''; x.host = x.host.toLowerCase();
    [...x.searchParams.keys()].forEach((k) => { if (/^utm_/i.test(k) || ['fbclid', 'gclid'].includes(k.toLowerCase())) x.searchParams.delete(k); });
    return x.toString().replace(/\/$/, '').toLowerCase();
  } catch (e) { return t.toLowerCase(); }
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex');

// ── end_at derivation (the never-expire guard) ─────────────────────────────────
function endOfLocalDay(iso, tz) {
  const local = utcIsoToLocalInput(iso, tz); if (!local) return null;   // "YYYY-MM-DDTHH:mm" in tz
  return localToUtcIso(local.split('T')[0] + 'T23:59', tz);             // 23:59 local that day → UTC ISO
}

/**
 * Always derive a reliable end_at, in this precedence:
 *   1. explicit end_at from the source (>= start)
 *   2. auction final close time (closing_schedule.final_close, >= start)
 *   3. explicit multi-day end date (end_date, local) → 23:59 local that day
 *   4. single-day → end of the local start day
 * Returns an ISO string, or null when nothing is computable (→ rejected_quality downstream).
 */
function deriveEndAt(c) {
  const tz = c.timezone || DEFAULT_TZ;
  const start = isoOrNull(c.start_at);
  if (!start) return null;

  const explicit = isoOrNull(c.end_at);
  if (explicit && explicit >= start) return explicit;

  const cs = c.closing_schedule || {};
  const close = isoOrNull(cs.final_close || cs.finalClose || cs.last_close);
  if (close && close >= start) return close;

  const endDate = localDateOrNull(c.end_date);
  if (endDate) { const e = localToUtcIso(endDate + 'T23:59', tz); if (e && e >= start) return e; }

  const eod = endOfLocalDay(start, tz);
  if (eod && eod >= start) return eod;
  return null;
}

// ── assemble a sanitized CanonicalEvent from a raw normalized draft ─────────────
function sanitizeCanonical(draft) {
  draft = draft || {};
  const c = {
    title: text(draft.title, 200) || null,
    subtitle: text(draft.subtitle, 200) || null,
    description: plainText(draft.description, 8000) || null,
    sale_type: ['estate_sale', 'auction', 'other'].includes(collapse(draft.sale_type).toLowerCase()) ? collapse(draft.sale_type).toLowerCase() : null,
    event_format: ['online', 'live', 'hybrid'].includes(collapse(draft.event_format).toLowerCase()) ? collapse(draft.event_format).toLowerCase() : null,
    start_at: isoOrNull(draft.start_at),
    end_at: isoOrNull(draft.end_at),
    timezone: collapse(draft.timezone) || DEFAULT_TZ,
    venue_name: text(draft.venue_name, 200) || null,
    address: text(draft.address, 300) || null,
    city: text(draft.city, 120) || null,
    state: text(draft.state, 40) || null,
    zip: text(draft.zip, 12) || null,
    lat: floatInRange(draft.lat, -90, 90),
    lng: floatInRange(draft.lng, -180, 180),
    organizer_name: text(draft.organizer_name, 200) || null,
    organizer_logo_url: url(draft.organizer_logo_url),
    organizer_website_url: url(draft.organizer_website_url),
    contact_name: text(draft.contact_name, 200) || null,
    contact_phone: phone(draft.contact_phone),
    contact_email: email(draft.contact_email),
    registration_url: url(draft.registration_url),
    bidding_url: url(draft.bidding_url),
    external_url: url(draft.external_url),
    sale_hours: (draft.sale_hours && typeof draft.sale_hours === 'object') ? draft.sale_hours : null,
    closing_schedule: (draft.closing_schedule && typeof draft.closing_schedule === 'object') ? draft.closing_schedule : null,
    preview_start: isoOrNull(draft.preview_start),
    preview_end: isoOrNull(draft.preview_end),
    pickup_start: isoOrNull(draft.pickup_start),
    pickup_end: isoOrNull(draft.pickup_end),
    end_date: localDateOrNull(draft.end_date),
    shipping_available: boolOrNull(draft.shipping_available),
    local_pickup_available: boolOrNull(draft.local_pickup_available),
    buyer_premium_bps: intOrNull(draft.buyer_premium_bps),
    payment_methods: stringArray(draft.payment_methods, 15),
    terms_text: plainText(draft.terms_text, 8000) || null,
    category_slug: collapse(draft.category_slug).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || null,
    categories: stringArray(draft.categories, 15),
    tags: stringArray(draft.tags, 25),
    images: Array.isArray(draft.images)
      ? draft.images.map((im, i) => ({ url: url(im && im.url), position: intOrNull(im && im.position) != null ? intOrNull(im.position) : i, caption: text(im && im.caption, 300) || null }))
        .filter((im) => im.url).slice(0, 40)
      : [],
  };
  c.end_at = deriveEndAt(c);   // ALWAYS derive — never leave a nullable "never expires"
  return c;
}

// Stable content hash over the volatility-free canonical (excludes derived/queue fields).
function contentHash(c) {
  const stable = {};
  for (const k of ['title', 'subtitle', 'description', 'sale_type', 'event_format', 'start_at', 'end_at',
    'timezone', 'venue_name', 'address', 'city', 'state', 'zip', 'lat', 'lng', 'organizer_name',
    'organizer_website_url', 'registration_url', 'bidding_url', 'external_url', 'terms_text',
    'category_slug', 'buyer_premium_bps']) stable[k] = c[k] == null ? null : c[k];
  return sha256(JSON.stringify(stable));
}
function imagesHash(c) { return sha256(JSON.stringify((c.images || []).map((im) => im.url))); }

module.exports = {
  CANONICAL_FIELDS, DEFAULT_TZ,
  text, plainText, url, email, phone, boolOrNull, intOrNull, floatInRange, stringArray, isoOrNull, localDateOrNull,
  normalizeUrlForHash, sha256, endOfLocalDay, deriveEndAt, sanitizeCanonical, contentHash, imagesHash,
};
