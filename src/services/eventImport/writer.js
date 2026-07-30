'use strict';

/**
 * writer — the imported-event writer (§4, §7 of the plan). Its own service path: createImported /
 * updateImported / publishImported. It NEVER calls eventsService.createDraft/submit/addImage and never
 * reads organization_plans, so imports do NOT consume seller plan quotas (§4). Every write is
 * transactional (the caller passes a pg client inside withTransaction). Railway is the source of truth;
 * no native BD record is ever created.
 */

const crypto = require('crypto');
const { generateUniqueSlug } = require('../../utils/slug');
const { writeAuditLog } = require('../../lib/auditLog');

const sha256 = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex');
const jsonb = (v) => (v == null ? null : JSON.stringify(v));

// Build the events column→value map from the resolved import context. Only columns that exist after
// migrations 099/100 are referenced. Provenance lives in event_sources, not here.
function buildEventRow(ctx) {
  const c = ctx.canonical || {};
  const geo = ctx.geo || {};
  const market = ctx.market || {};
  const attribution = ctx.attribution || {};
  return {
    slug: ctx.slug,
    organization_id: ctx.orgId,
    source: 'imported',
    status: 'draft',
    market_slug: market.marketSlug || null,
    market_resolved_via: market.via || null,
    category_slug: c.category_slug || null,
    title: c.title, subtitle: c.subtitle || null, description: c.description || null,
    venue_name: c.venue_name || null, address: c.address || null,
    city: c.city || null, state: c.state || null, zip: c.zip || null,
    lat: geo.lat != null ? geo.lat : null, lng: geo.lng != null ? geo.lng : null,
    timezone: c.timezone || 'America/New_York',
    start_at: c.start_at, end_at: c.end_at,
    external_url: c.external_url || null,
    sale_type: c.sale_type || null, event_format: c.event_format || null,
    organizer_name: c.organizer_name || null, organizer_logo_url: c.organizer_logo_url || null, organizer_website_url: c.organizer_website_url || null,
    contact_name: c.contact_name || null, contact_phone: c.contact_phone || null, contact_email: c.contact_email || null,
    registration_url: c.registration_url || null, bidding_url: c.bidding_url || null,
    sale_hours: jsonb(c.sale_hours), closing_schedule: jsonb(c.closing_schedule),
    preview_start: c.preview_start || null, preview_end: c.preview_end || null,
    pickup_start: c.pickup_start || null, pickup_end: c.pickup_end || null,
    shipping_available: c.shipping_available, local_pickup_available: c.local_pickup_available,
    buyer_premium_bps: c.buyer_premium_bps != null ? c.buyer_premium_bps : null,
    payment_methods: c.payment_methods && c.payment_methods.length ? c.payment_methods : null,
    terms_text: c.terms_text || null,
    tags: c.tags && c.tags.length ? c.tags : null,
    categories: c.categories && c.categories.length ? c.categories : null,
    content_hash: ctx.contentHash || null,
    source_last_updated_at: (ctx.provenance && ctx.provenance.sourceUpdatedAt) || null,
    geocoding_status: geo.geocoding_status || null, geocoding_source: geo.geocoding_source || null,
    location_fingerprint: geo.location_fingerprint || null, geocoded_at: geo.geocoded_at || null,
    attribution_source: attribution.source || null, attribution_url: attribution.url || null,
  };
}

// Fields the writer is allowed to UPDATE on an existing imported event (never slug/organization_id/source/status).
const UPDATABLE = Object.keys(buildEventRow({ canonical: {}, orgId: null })).filter(
  (k) => !['slug', 'organization_id', 'source', 'status'].includes(k));

async function insertImages(client, eventId, images) {
  for (let i = 0; i < (images || []).length; i++) {
    const im = images[i];
    await client.query(
      `INSERT INTO event_images (event_id, url, position, is_cover, source_url, content_hash, alt_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (event_id, position) DO NOTHING`,
      [eventId, im.url, im.position != null ? im.position : i, (im.position != null ? im.position : i) === 0, im.url, sha256(im.url), im.caption || null]);
  }
}

async function writeProvenance(client, eventId, ctx) {
  const p = ctx.provenance || {};
  await client.query(
    `INSERT INTO event_sources
       (event_id, source_id, source_event_id, source_url, source_url_hash, source_updated_at,
        content_hash, images_hash, sync_status, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)
     ON CONFLICT (source_id, source_event_id)
       DO UPDATE SET event_id = EXCLUDED.event_id, source_url = EXCLUDED.source_url,
         source_url_hash = EXCLUDED.source_url_hash, source_updated_at = EXCLUDED.source_updated_at,
         content_hash = EXCLUDED.content_hash, images_hash = EXCLUDED.images_hash,
         sync_status = 'active', last_synced_at = now(), raw_payload = EXCLUDED.raw_payload`,
    [eventId, p.sourceId, String(p.sourceEventId), p.sourceUrl || null,
     p.sourceUrl ? sha256(p.sourceUrl) : null, p.sourceUpdatedAt || null,
     ctx.contentHash || null, ctx.imagesHash || null, jsonb(p.rawPayload)]);
}

async function audit(client, action, eventId, ctx, extra) {
  try {
    await writeAuditLog({
      client, event_type: action, entity_type: 'event', entity_id: eventId,
      actor_id: (ctx && ctx.actorId) || null,
      metadata: Object.assign({ actor: 'event_importer', source_id: ctx && ctx.provenance && ctx.provenance.sourceId }, extra || {}),
    });
  } catch (e) { /* audit is best-effort within the tx; never block the write */ }
}

/** Create a NEW imported event (draft). Returns the new event id. */
async function createImported(client, ctx) {
  ctx.slug = await generateUniqueSlug('events', ctx.canonical.title || 'event', client);
  const row = buildEventRow(ctx);
  const cols = Object.keys(row);
  const vals = cols.map((k) => row[k]);
  const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
  const { rows } = await client.query(`INSERT INTO events (${cols.join(',')}) VALUES (${ph}) RETURNING id`, vals);
  const eventId = rows[0].id;
  await insertImages(client, eventId, ctx.canonical.images);
  await writeProvenance(client, eventId, ctx);
  await audit(client, 'event.imported.created', eventId, ctx, { market: (ctx.market || {}).marketSlug });
  return eventId;
}

/** Update an existing imported event in place (content changed). Re-syncs images only when changed. */
async function updateImported(client, eventId, ctx) {
  const row = buildEventRow(ctx);
  const sets = []; const vals = [];
  for (const k of UPDATABLE) { vals.push(row[k]); sets.push(`${k} = $${vals.length}`); }
  vals.push(eventId);
  await client.query(`UPDATE events SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
  if (ctx.imagesChanged) {
    await client.query('DELETE FROM event_images WHERE event_id = $1', [eventId]);
    await insertImages(client, eventId, ctx.canonical.images);
  }
  await writeProvenance(client, eventId, ctx);
  await audit(client, 'event.imported.updated', eventId, ctx, { imagesChanged: !!ctx.imagesChanged });
  return eventId;
}

/** Publish an imported event: draft → published. Bypasses plan quotas (never reads organization_plans). */
async function publishImported(client, eventId, ctx) {
  const { rows } = await client.query(
    `UPDATE events SET status = 'published', published_at = now(), updated_at = now()
      WHERE id = $1 AND source = 'imported' AND status = 'draft'
      RETURNING id`, [eventId]);
  if (rows[0]) await audit(client, 'event.published', eventId, ctx || {}, { via: 'import' });
  return rows.length > 0;
}

module.exports = { createImported, updateImported, publishImported, buildEventRow, UPDATABLE };
