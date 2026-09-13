'use strict';

/**
 * localEventAlertService — the first-party LOCAL EVENT ALERT capability. Given an eligible, currently-
 * public auction or event, it produces (a) a factual event object, (b) an authoritative geographic
 * audience specification (reusing Phase 4D), and (c) a rendered marketing email (single or digest).
 *
 * Safety: only rows that pass the canonical marketplaceVisibility predicates are ever used — a stale,
 * closed, archived, hidden, or demo row is rejected. Only already-public facts are inserted; distance,
 * availability, values, scarcity, and popularity are NEVER invented. Email radius is INDEPENDENT of the
 * paid advertising rule (separate keys, so changing one never moves the other). This module NEVER sends.
 *
 * ENTITLEMENT (migration 157). EVERYONE MAY SUBSCRIBE. NOT EVERY EVENT MAY SEND. Passing the visibility
 * predicates used to be sufficient to resolve an event and build an audience for it, which made an
 * imported estate sale as eligible as a native auction. Under the finalized Owner policy only a NATIVE
 * Advantage.Bid auction is automatically eligible; an imported auction, an Auction Partner Event, a
 * personally managed estate sale and an imported estate sale each require an explicit entitlement.
 * resolveEvent() now returns the entitlement decision alongside the facts, and buildAudience() refuses
 * outright when the subject is not entitled. Event type alone grants nothing.
 *
 * ADDRESS PRIVACY. An estate-sale alert must NEVER carry the street address — not even when the listing
 * has already released it, and not through coordinates, a map, a tracking parameter or metadata. The
 * resolver therefore never selects `address`, and publicFacts() is the single narrow allowlist of what
 * may reach a template.
 */
const db = require('../db');
const { activeNativeAuctionSql, activeEventSql } = require('../lib/marketplaceVisibility');
const audience = require('./audienceEligibilityService');
const marketingConfig = require('./marketingConfigService');
const tmpl = require('./marketingEmailTemplate');
const entitlement = require('./salesNearYouEntitlementService');

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
      // A NATIVE Advantage.Bid auction — conducted on our own software. This is the only kind that is
      // automatically entitled to the channel, and even then every other gate still applies.
      kind: 'auction', id: a.id, title: a.title, city: a.city, state: a.state, zip: a.zip,
      lat: a.lat, lng: a.lng, date_line: dateLine(a.start_time, a.end_time),
      source: 'native', isNative: true,
      image_url: a.image_url, url: `${APP_BASE}/auction-view.html?auctionId=${encodeURIComponent(a.id)}`,
    };
  }
  // Events (estate sales + partner events).
  // `e.address` is deliberately NOT selected. The street address must never travel with an alert, so it
  // is not read at all rather than read and then hoped to be dropped downstream.
  const { rows } = await r.query(
    `SELECT e.id, e.slug, e.title, e.city, e.state, e.zip, e.lat, e.lng, e.start_at, e.end_at,
            e.sale_type, e.source,
            (SELECT url FROM event_images ei WHERE ei.event_id = e.id ORDER BY is_cover DESC, position ASC LIMIT 1) AS image_url
       FROM events e
      WHERE e.slug = $1 AND ${activeEventSql('e')}`, [idOrSlug]);
  const e = rows[0];
  if (!e) return null;
  // "Auction" is never read generically: an event with sale_type 'auction' is a PARTNER event, not an
  // auction conducted on Advantage.Bid's own software.
  const evKind = e.sale_type === 'auction' ? 'partner_event' : 'estate_sale';
  return {
    kind: evKind, id: e.id, slug: e.slug, title: e.title, city: e.city, state: e.state, zip: e.zip,
    // PUBLIC offset coordinates (migration 102), used for audience selection only — never rendered.
    lat: e.lat, lng: e.lng, date_line: dateLine(e.start_at, e.end_at),
    source: e.source, isNative: false,
    image_url: e.image_url, url: `${APP_BASE}/event.html?slug=${encodeURIComponent(e.slug)}`,
  };
}

/**
 * The ONLY fields permitted to reach an email template. An estate-sale alert must never carry the
 * street address, exact private coordinates, a map of the property, or anything else that could
 * circumvent the address-publication policy — so the allowlist is explicit and coordinates are dropped
 * here even though they were needed a moment ago to select the audience.
 */
function publicFacts(event) {
  if (!event) return null;
  return {
    kind: event.kind, id: event.id, slug: event.slug,
    title: event.title,
    city: event.city, state: event.state,      // city + state only; never a street address
    date_line: event.date_line,
    image_url: event.image_url,
    url: event.url,                            // canonical Advantage.Bid listing
  };
}

/**
 * Is this subject entitled to the Sales Near You channel? Returns the decision without side effects.
 * A native Advantage.Bid auction is entitled by rule; everything else needs an explicit grant.
 */
async function checkEntitlement(event, runner) {
  if (!event) return { entitled: false, basis: 'none', reason: 'event_not_eligible', entitlement: null };
  return entitlement.resolve({
    kind: event.kind, id: event.id, source: event.source || null,
    isNative: event.kind === 'auction' && event.isNative !== false,
  }, runner);
}

async function allowedRadii() {
  const raw = await marketingConfig.raw('marketing.email.radius_allowed', [10, 25, 30, 50, 100]);
  return Array.isArray(raw) ? raw : [10, 25, 30, 50, 100];
}
async function defaultRadius() {
  // Owner decision: 30 miles for Sales Near You EMAIL notifications. Independent of paid advertising
  // targeting — a different key entirely, so changing one never moves the other.
  return marketingConfig.getInt('marketing.email.local_alert_default_radius_miles', 30);
}

/**
 * Build the authoritative audience specification + preview counts for a Local Event Alert around an event.
 * Returns { event, strategy, potential, eligible, spec }. Never a raw address list.
 */
async function buildAudience({ kind, idOrSlug, radiusMiles = null, strategy = null }, runner) {
  const r = runner || db;
  const event = await resolveEvent(kind, idOrSlug, r);
  if (!event) return { ok: false, reason: 'event_not_eligible' };

  // ENTITLEMENT GATE. Checked BEFORE any audience is built, so an unentitled event never produces a
  // recipient set, a count, or a specification that could later be mistaken for permission.
  const ent = await checkEntitlement(event, r);
  if (!ent.entitled) {
    return { ok: false, reason: ent.reason, entitled: false, basis: ent.basis, event: publicFacts(event) };
  }

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
  return {
    ok: true,
    // Only the public facts leave this service — the street address was never read, and the coordinates
    // used for selection are dropped here.
    event: publicFacts(event),
    entitled: true, basis: ent.basis, entitlement_id: ent.entitlement ? ent.entitlement.id : null,
    strategy: geoStrategy, potential: preview.potential, eligible: preview.eligible, spec,
  };
}

/** Render a single Local Event Alert email (no send). opts: { unsubscribeUrl, preferencesUrl, fullCircle } */
function renderAlert(event, opts = {}) {
  // publicFacts is applied again here so a caller that hand-built an event object still cannot leak an
  // address into a rendered email.
  return tmpl.buildLocalEventAlert(publicFacts(event), opts);
}
/** Render a Local Event Digest email (no send). */
function renderDigest(events, opts = {}) {
  return tmpl.buildLocalEventDigest((events || []).map(publicFacts), opts);
}

module.exports = {
  resolveEvent, buildAudience, renderAlert, renderDigest, allowedRadii, defaultRadius, dateLine,
  publicFacts, checkEntitlement,
};
