'use strict';

/**
 * localEventAlertService — the first-party LOCAL EVENT ALERT capability. Given an eligible, currently-
 * public auction or event, it produces (a) a factual event object, (b) an authoritative geographic
 * audience specification (reusing Phase 4D), and (c) a rendered marketing email (single or digest).
 *
 * Safety: only rows that pass the canonical marketplaceVisibility predicates are ever used — a stale,
 * closed, archived, hidden, or demo row is rejected. Only already-public facts are inserted; distance,
 * availability, values, scarcity, and popularity are NEVER invented. Email radius is INDEPENDENT of the
 * paid 30-mile advertising rule. This module NEVER sends.
 */
const db = require('../db');
const { activeNativeAuctionSql, activeEventSql } = require('../lib/marketplaceVisibility');
const audience = require('./audienceEligibilityService');
const marketingConfig = require('./marketingConfigService');
const tmpl = require('./marketingEmailTemplate');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');

function fmtDate(v) {
  if (!v) return null;
  try { return new Date(v).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
  catch (_) { return null; }
}
function dateLine(start, end) {
  const s = fmtDate(start); const e = fmtDate(end);
  if (s && e && s !== e) return `${s} – ${e}`;
  return s || e || null;
}

/**
 * Resolve an eligible, currently-public event to a factual alert object, or null if not eligible.
 * @param {string} kind 'auction' (native) | 'estate_sale' | 'partner_event'
 * @param {string} idOrSlug auction UUID (native) or event slug (events)
 */
async function resolveEvent(kind, idOrSlug, runner) {
  const r = runner || db;
  if (kind === 'auction') {
    const { rows } = await r.query(
      `SELECT a.id, a.title, a.city, a.address_state AS state, a.zip, a.lat, a.lng,
              a.start_time, a.end_time, COALESCE(a.cover_image_url, a.banner_image_url) AS image_url
         FROM auctions a
        WHERE a.id = $1 AND ${activeNativeAuctionSql('a')}`, [idOrSlug]);
    const a = rows[0];
    if (!a) return null;
    return {
      kind: 'auction', id: a.id, title: a.title, city: a.city, state: a.state, zip: a.zip,
      lat: a.lat, lng: a.lng, date_line: dateLine(a.start_time, a.end_time),
      image_url: a.image_url, url: `${APP_BASE}/auction-view.html?auctionId=${encodeURIComponent(a.id)}`,
    };
  }
  // Events (estate sales + partner events)
  const { rows } = await r.query(
    `SELECT e.id, e.slug, e.title, e.city, e.state, e.zip, e.lat, e.lng, e.start_at, e.end_at, e.sale_type,
            (SELECT url FROM event_images ei WHERE ei.event_id = e.id ORDER BY is_cover DESC, position ASC LIMIT 1) AS image_url
       FROM events e
      WHERE e.slug = $1 AND ${activeEventSql('e')}`, [idOrSlug]);
  const e = rows[0];
  if (!e) return null;
  const evKind = e.sale_type === 'auction' ? 'partner_event' : 'estate_sale';
  return {
    kind: evKind, id: e.id, slug: e.slug, title: e.title, city: e.city, state: e.state, zip: e.zip,
    lat: e.lat, lng: e.lng, date_line: dateLine(e.start_at, e.end_at),
    image_url: e.image_url, url: `${APP_BASE}/event.html?slug=${encodeURIComponent(e.slug)}`,
  };
}

async function allowedRadii() {
  const raw = await marketingConfig.raw('marketing.email.radius_allowed', [10, 25, 30, 50, 100]);
  return Array.isArray(raw) ? raw : [10, 25, 30, 50, 100];
}
async function defaultRadius() {
  return marketingConfig.getInt('marketing.email.local_alert_default_radius_miles', 50);
}

/**
 * Build the authoritative audience specification + preview counts for a Local Event Alert around an event.
 * Returns { event, strategy, potential, eligible, spec }. Never a raw address list.
 */
async function buildAudience({ kind, idOrSlug, radiusMiles = null, strategy = null }, runner) {
  const r = runner || db;
  const event = await resolveEvent(kind, idOrSlug, r);
  if (!event) return { ok: false, reason: 'event_not_eligible' };

  let geoStrategy = strategy;
  if (!geoStrategy) {
    if (event.lat == null || event.lng == null) {
      // No coordinates → fall back to state-level targeting (radius impossible without a point).
      geoStrategy = event.state ? { state: event.state } : { kind: 'nationwide' };
    } else {
      const radius = radiusMiles || (await defaultRadius());
      const allowed = await allowedRadii();
      const chosen = allowed.includes(Number(radius)) ? Number(radius) : (await defaultRadius());
      geoStrategy = { kind: 'radius', lat: Number(event.lat), lng: Number(event.lng), radius_miles: chosen };
    }
  }

  const preview = await audience.previewAudience({
    lat: geoStrategy.lat, lng: geoStrategy.lng, radiusMiles: geoStrategy.radius_miles,
    state: geoStrategy.state, city: geoStrategy.city,
  }, r);
  const spec = await audience.buildAudienceSpec({ marketingClass: 'local_event_alert', geoStrategy }, r);
  return { ok: true, event, strategy: geoStrategy, potential: preview.potential, eligible: preview.eligible, spec };
}

/** Render a single Local Event Alert email (no send). opts: { unsubscribeUrl, preferencesUrl, fullCircle } */
function renderAlert(event, opts = {}) {
  return tmpl.buildLocalEventAlert(event, opts);
}
/** Render a Local Event Digest email (no send). */
function renderDigest(events, opts = {}) {
  return tmpl.buildLocalEventDigest(events, opts);
}

module.exports = { resolveEvent, buildAudience, renderAlert, renderDigest, allowedRadii, defaultRadius, dateLine };
