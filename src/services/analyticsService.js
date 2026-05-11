'use strict';

/**
 * Analytics Service — lightweight telemetry ingestion
 *
 * Design rules:
 *   - insertEvent() NEVER throws and NEVER rejects. Analytics failures are
 *     always silent so callers (routes, widgets) are never affected.
 *   - All inputs are sanitized before storage: PII fields stripped,
 *     lengths capped, types validated.
 *   - IP addresses are one-way hashed (16-char SHA-256 prefix) — never stored raw.
 *   - Fire-and-forget: callers do not await insertEvent(). The HTTP response
 *     is sent before the DB write completes.
 */

const crypto = require('crypto');
const db     = require('../db');

// ── Known event types ──────────────────────────────────────────────────────────
// New types are allowed (stored as-is) — this set is used for metrics only.
const KNOWN_EVENT_TYPES = new Set([
  'widget_impression',
  'widget_click',
  'auction_view',
  'featured_auction_click',
  'seller_cta_click',
  'radius_search',
  'shipping_filter_toggle',
  'city_page_visit',
  'seller_onboarding_start',
  'seller_onboarding_complete',
]);

const UUID_RE            = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_METADATA_BYTES = 4096;
const MAX_URL_LEN        = 2048;
const MAX_TEXT_LEN       = 256;
const SAFE_DEVICE_TYPES  = new Set(['desktop', 'mobile', 'tablet']);

// Keys that must never appear in stored metadata
const PII_KEYS = new Set([
  'email', 'password', 'token', 'card', 'card_number', 'cvv', 'ssn',
  'phone', 'address', 'zip', 'credit', 'secret', 'auth', 'jwt',
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

function hashIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  // Take the first non-loopback IP from comma-separated x-forwarded-for
  const raw = ip.split(',')[0].trim();
  if (!raw || raw === '127.0.0.1' || raw === '::1') return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function safeText(val, maxLen) {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed.length > 0 && trimmed.length <= maxLen ? trimmed : null;
}

function safeUuid(val) {
  return typeof val === 'string' && UUID_RE.test(val) ? val.toLowerCase() : null;
}

function safeTs(val) {
  if (!val) return null;
  try {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

function sanitizeMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const safe = {};
  for (const [k, v] of Object.entries(raw)) {
    if (PII_KEYS.has(k.toLowerCase())) continue;
    if (typeof k !== 'string' || k.length > 64) continue;
    // Scalars only in top-level metadata (nested objects are fine but capped by byte limit)
    safe[k] = v;
  }
  return safe;
}

// ── insertEvent ────────────────────────────────────────────────────────────────

/**
 * insertEvent(raw, ip)
 *
 * @param {object} raw  — event payload from the HTTP request body
 * @param {string} ip   — client IP (raw, will be hashed)
 *
 * Returns a Promise that always resolves (never rejects).
 * Intended to be called without await from route handlers.
 */
async function insertEvent(raw, ip) {
  try {
    if (!raw || typeof raw !== 'object') return;

    const eventType = safeText(raw.event_type, 64);
    if (!eventType) return;

    const sessionId  = safeText(raw.session_id, 64);
    const deviceType = SAFE_DEVICE_TYPES.has(raw.device_type) ? raw.device_type : null;
    const pageUrl    = safeText(raw.page_url, MAX_URL_LEN);
    const referrer   = safeText(raw.referrer, MAX_URL_LEN);
    const widgetName = safeText(raw.widget_name, 64);
    const auctionId  = safeUuid(raw.auction_id);
    const sellerId   = safeUuid(raw.seller_id);
    const city       = safeText(raw.city, 128);
    const stateCode  = safeText(raw.state_code, 2);
    const clientTs   = safeTs(raw.client_ts);
    const metadata   = sanitizeMetadata(raw.metadata);

    const metaJson = JSON.stringify(metadata);
    if (metaJson.length > MAX_METADATA_BYTES) return;

    await db.query(
      `INSERT INTO analytics_events
         (event_type, session_id, device_type, page_url, referrer,
          widget_name, auction_id, seller_id, city, state_code,
          metadata, client_ts, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        eventType, sessionId, deviceType, pageUrl, referrer,
        widgetName, auctionId, sellerId, city, stateCode,
        metaJson, clientTs, hashIp(ip),
      ]
    );
  } catch (err) {
    // Analytics errors are never propagated — they must not affect callers
    if (process.env.NODE_ENV === 'development') {
      process.stderr.write('[analytics] insertEvent error: ' + err.message + '\n');
    }
  }
}

/**
 * insertBatch(events, ip)
 *
 * Insert up to 20 events from a single batch request.
 * Each event is processed independently — one bad event does not block others.
 */
async function insertBatch(events, ip) {
  if (!Array.isArray(events)) return;
  const batch = events.slice(0, 20);
  await Promise.allSettled(batch.map(evt => insertEvent(evt, ip)));
}

module.exports = { insertEvent, insertBatch, KNOWN_EVENT_TYPES };
