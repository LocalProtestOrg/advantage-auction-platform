'use strict';

/**
 * eventsService — the Events product (Phase 1) built on the Organization layer.
 *
 * Owns: event creation/editing by owners, the 5-state lifecycle state machine
 * (draft → submitted → published | rejected → archived), server-side plan-limit
 * enforcement (max_active_events at submit, max_event_images on upload, can_feature
 * primitive), slug generation, organizer-badge derivation, and audit logging of every
 * transition. Imports/recurrence/geo/monetization behavior are DEFERRED (columns exist).
 *
 * No changes to auctions/bids/payments/seller_profiles/users. Additive only.
 */

const db = require('../db');
const auditService = require('./auditService');
const orgs = require('./organizationsService');
const eventGeo = require('./eventGeocodingService');
const { withTransaction } = require('../utils/withTransaction');
const { generateUniqueSlug } = require('../utils/slug');

const { svcErr } = orgs;

const STATUSES = ['draft', 'submitted', 'published', 'rejected', 'archived'];
const ACTIVE_STATES = ['submitted', 'published'];      // count toward max_active_events
const EDITABLE_STATES = new Set(['draft', 'rejected']); // owner may edit / change images

// Professional companies publish their events directly (no review queue) — the member who creates the
// event takes it straight to published. Homeowner estate sales (a paid, reviewed product) are excluded
// upstream in submit(); individual/non-professional organizers still go through review.
const AUTO_PUBLISH_ORG_TYPES = new Set([
  'auction_company', 'auction_house', 'estate_sale_company', 'professional_liquidator',
  'consignment_company', 'moving_company', 'cleanout_company', 'clean_out_company',
]);

// camelCase input → column, for create/update allowlists.
// NOTE: lat/lng are intentionally NOT client-settable. Public coordinates are a server-derived privacy
// OFFSET of the geocoded address (two-tier model, migration 102); a caller can never write the public
// marker (or an exact point) directly. Address changes trigger a re-geocode post-commit.
const FIELD_MAP = {
  title: 'title', description: 'description', marketSlug: 'market_slug', categorySlug: 'category_slug',
  venueName: 'venue_name', address: 'address', city: 'city', state: 'state', zip: 'zip',
  startAt: 'start_at', endAt: 'end_at', timezone: 'timezone', externalUrl: 'external_url',
};
// Address fields whose change warrants a re-geocode.
const GEO_FIELDS = new Set(['address', 'city', 'state', 'zip']);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const num = (v) => (v === '' || v == null ? null : (Number.isFinite(+v) ? +v : null));

function audit(client, eventType, eventId, actorId, metadata) {
  return auditService.logEvent(client, { eventType, entityType: 'event', entityId: eventId, actorId, metadata });
}

/** Public trust badge, derived once from source + the org's verification status. */
function deriveOrganizerBadge(event, org) {
  if (!event) return null;
  if (event.source === 'imported') return 'Imported Listing';
  if (event.source === 'admin') return 'Advantage';
  if (org && org.verification_status === 'verified') return 'Verified Organizer';
  return 'Community Organizer';
}

/**
 * Customer-facing event TYPE label (never how the event entered the system). Replaces the internal
 * "Imported Listing" badge on public surfaces. Derived from sale_type + event_format with a safe,
 * non-misleading fallback of "Sale Event".
 */
function eventTypeLabel(event) {
  const e = event || {};
  const st = String(e.sale_type || '').toLowerCase();
  const fmt = String(e.event_format || '').toLowerCase();
  if (st === 'auction') return fmt === 'online' ? 'Online Auction' : (fmt === 'live' ? 'Live Auction' : 'Auction');
  if (st === 'estate_sale') return 'Estate Sale';
  if (fmt === 'online') return 'Online Sale';
  return 'Sale Event';
}

async function getPlanForOrg(runner, orgId) {
  const { rows } = await runner.query(
    `SELECT p.plan_tier, p.max_event_images, p.max_active_events, p.can_feature_events
       FROM organizations o JOIN organization_plans p ON p.plan_tier = o.plan_tier
      WHERE o.id = $1`, [orgId]);
  if (!rows.length) throw svcErr(404, 'ORG_NOT_FOUND', 'Organization not found.');
  return rows[0];
}

async function countActiveEvents(orgId, runner) {
  const { rows } = await (runner || db).query(
    `SELECT count(*)::int c FROM events WHERE organization_id = $1 AND status = ANY($2)`,
    [orgId, ACTIVE_STATES]);
  return rows[0].c;
}

async function getById(eventId) {
  const { rows } = await db.query('SELECT * FROM events WHERE id = $1', [eventId]);
  return rows[0] || null;
}

async function listForOrg(orgId) {
  const { rows } = await db.query(
    'SELECT * FROM events WHERE organization_id = $1 ORDER BY created_at DESC', [orgId]);
  return rows;
}

async function listImages(eventId) {
  const { rows } = await db.query(
    'SELECT * FROM event_images WHERE event_id = $1 ORDER BY position ASC, created_at ASC', [eventId]);
  return rows;
}

/** Load an event and assert the user owns its organization (throws 404/403). */
async function loadOwnedEvent(client, eventId, userId) {
  const { rows } = await client.query('SELECT * FROM events WHERE id = $1', [eventId]);
  if (!rows.length) throw svcErr(404, 'EVENT_NOT_FOUND', 'Event not found.');
  const ev = rows[0];
  await orgs.assertOwner(userId, ev.organization_id, client);
  return ev;
}

/** Create a draft event owned by `org`. Drafts are unlimited (they are not "active"). */
async function createDraft(userId, org, input = {}) {
  const title = (input.title || '').trim();
  if (!title) throw svcErr(400, 'EVENT_TITLE_REQUIRED', 'Event title is required.');
  if (!input.marketSlug) throw svcErr(400, 'EVENT_MARKET_REQUIRED', 'A market is required.');
  if (!input.startAt) throw svcErr(400, 'EVENT_START_REQUIRED', 'A start date/time is required.');

  const ev = await withTransaction(async (client) => {
    await orgs.assertOwner(userId, org.id, client);
    const slug = await generateUniqueSlug('events', title, client);
    // sale_type is server-decided (never asked of the customer). Only the Estate Sale Promotion flow
    // passes saleType='estate_sale'; organizer-created events leave it NULL as before.
    const saleType = input.saleType === 'estate_sale' ? 'estate_sale' : (input.saleType === 'auction' ? 'auction' : null);
    const { rows } = await client.query(
      `INSERT INTO events
         (slug, organization_id, source, market_slug, category_slug, title, description,
          venue_name, address, city, state, zip, start_at, end_at, timezone, external_url, sale_type, status)
       VALUES ($1,$2,'organization',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'draft')
       RETURNING *`,
      [slug, org.id, input.marketSlug, input.categorySlug || null, title, input.description || null,
       input.venueName || null, input.address || null, input.city || null, input.state || null, input.zip || null,
       input.startAt, input.endAt || null,
       input.timezone || 'America/New_York', input.externalUrl || null, saleType]);
    const created = rows[0];
    await audit(client, 'event.created', created.id, userId, { title: created.title, market: created.market_slug });
    return created;
  });
  // Future automatic geocoding (Part 5): geocode the address server-side, storing the precise point in
  // internal_lat/lng and the privacy OFFSET in public lat/lng. Fire-and-forget, post-commit — never
  // blocks or fails the save (a provider outage just leaves a retryable status).
  eventGeo.geocodeEventSafe(ev.id).catch(() => {});
  return ev;
}

/** Owner edit — allowed only in draft/rejected. */
async function updateDraft(userId, eventId, input = {}) {
  const ev = await withTransaction(async (client) => {
    const current = await loadOwnedEvent(client, eventId, userId);
    if (!EDITABLE_STATES.has(current.status)) {
      throw svcErr(409, 'EVENT_NOT_EDITABLE', `Only draft or rejected events can be edited (current: ${current.status}).`);
    }
    const sets = []; const vals = [];
    for (const key of Object.keys(FIELD_MAP)) {
      if (hasOwn(input, key)) {
        const col = FIELD_MAP[key];
        vals.push(col === 'lat' || col === 'lng' ? num(input[key]) : input[key]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    if (!sets.length) throw svcErr(400, 'NO_FIELDS', 'No updatable fields provided.');
    vals.push(eventId);
    const { rows } = await client.query(
      `UPDATE events SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
    await audit(client, 'event.updated', eventId, userId, { fields: sets.map((s) => s.split(' = ')[0]) });
    return rows[0];
  });
  // Re-geocode (offset-safe) only when an address field actually changed.
  if (Object.keys(input).some((k) => GEO_FIELDS.has(FIELD_MAP[k] || k))) {
    eventGeo.geocodeEventSafe(eventId, { force: true }).catch(() => {});
  }
  return ev;
}

/** Owner submit (draft|rejected → submitted). Enforces the active-event plan limit here. */
async function submit(userId, eventId) {
  return withTransaction(async (client) => {
    const ev = await loadOwnedEvent(client, eventId, userId);
    // Estate sales are a paid, one-time Estate Sale Promotion product — they are submitted ONLY through
    // estateSalePromotionService (which consumes the promotion). The free events capability must never
    // publish an estate sale for free, so this organizer path refuses them.
    if (ev.sale_type === 'estate_sale') {
      throw svcErr(403, 'ESTATE_SALE_PROMOTION_REQUIRED', 'Estate sales are submitted through the Estate Sale Promotion.');
    }
    if (!['draft', 'rejected'].includes(ev.status)) {
      throw svcErr(409, 'INVALID_TRANSITION', `Cannot submit from ${ev.status}.`);
    }
    const plan = await getPlanForOrg(client, ev.organization_id);
    const active = await countActiveEvents(ev.organization_id, client);
    if (active >= plan.max_active_events) {
      throw svcErr(422, 'ACTIVE_EVENT_LIMIT',
        `Your plan allows ${plan.max_active_events} active events. Archive one to submit another.`);
    }
    // Professional companies skip the review queue: their events go member → published directly.
    const { rows: orgRow } = await client.query('SELECT type FROM organizations WHERE id=$1', [ev.organization_id]);
    const orgType = orgRow[0] && orgRow[0].type;
    if (AUTO_PUBLISH_ORG_TYPES.has(orgType)) {
      const { rows } = await client.query(
        `UPDATE events SET status='published', submitted_at=now(), published_at=now(), review_reason=NULL, updated_at=now()
          WHERE id=$1 RETURNING *`, [eventId]);
      await audit(client, 'event.published', eventId, userId, { auto: true, reason: 'professional_company_auto_publish', org_type: orgType });
      return rows[0];
    }
    const { rows } = await client.query(
      `UPDATE events SET status='submitted', submitted_at=now(), review_reason=NULL, updated_at=now()
        WHERE id=$1 RETURNING *`, [eventId]);
    await audit(client, 'event.submitted', eventId, userId, {});
    return rows[0];
  });
}

/** Owner archive (draft|rejected → archived). Archiving submitted/published is an admin action. */
async function archiveByOwner(userId, eventId) {
  return withTransaction(async (client) => {
    const ev = await loadOwnedEvent(client, eventId, userId);
    if (!EDITABLE_STATES.has(ev.status)) {
      throw svcErr(409, 'INVALID_TRANSITION', `Only draft or rejected events can be archived by the organizer (current: ${ev.status}).`);
    }
    const { rows } = await client.query(
      `UPDATE events SET status='archived', updated_at=now() WHERE id=$1 RETURNING *`, [eventId]);
    await audit(client, 'event.archived', eventId, userId, { by: 'owner', from: ev.status });
    return rows[0];
  });
}

/** Add an image (Cloudinary URL). Enforces max_event_images; first image becomes the cover. */
async function addImage(userId, eventId, url, { isCover = false } = {}) {
  if (!url) throw svcErr(400, 'IMAGE_URL_REQUIRED', 'An image URL is required.');
  return withTransaction(async (client) => {
    const ev = await loadOwnedEvent(client, eventId, userId);
    if (!EDITABLE_STATES.has(ev.status)) {
      throw svcErr(409, 'EVENT_NOT_EDITABLE', 'Images can only be changed on draft or rejected events.');
    }
    const plan = await getPlanForOrg(client, ev.organization_id);
    const { rows: cnt } = await client.query('SELECT count(*)::int c FROM event_images WHERE event_id=$1', [eventId]);
    if (cnt[0].c >= plan.max_event_images) {
      throw svcErr(422, 'IMAGE_LIMIT', `Your plan allows ${plan.max_event_images} images per event.`);
    }
    const position = cnt[0].c;
    const cover = position === 0 ? true : !!isCover;
    const { rows } = await client.query(
      `INSERT INTO event_images (event_id, url, position, is_cover) VALUES ($1,$2,$3,$4) RETURNING *`,
      [eventId, url, position, cover]);
    await audit(client, 'event.image_added', eventId, userId, { image_id: rows[0].id, position });
    return rows[0];
  });
}

async function removeImage(userId, eventId, imageId) {
  return withTransaction(async (client) => {
    await loadOwnedEvent(client, eventId, userId);
    const { rowCount } = await client.query(
      'DELETE FROM event_images WHERE id=$1 AND event_id=$2', [imageId, eventId]);
    if (!rowCount) throw svcErr(404, 'IMAGE_NOT_FOUND', 'Image not found.');
    await audit(client, 'event.image_removed', eventId, userId, { image_id: imageId });
    return { removed: true };
  });
}

// ── Admin moderation transitions (authorization enforced at the route via roleMiddleware) ──
async function applyAdminTransition(adminId, eventId, opts) {
  return withTransaction(async (client) => {
    const { rows: er } = await client.query('SELECT * FROM events WHERE id=$1', [eventId]);
    if (!er.length) throw svcErr(404, 'EVENT_NOT_FOUND', 'Event not found.');
    const ev = er[0];
    if (!opts.from.includes(ev.status)) {
      throw svcErr(409, 'INVALID_TRANSITION', `Cannot ${opts.action} from ${ev.status}.`);
    }
    const vals = [eventId, adminId, opts.to]; // $1 id, $2 reviewed_by, $3 status
    let set = 'status=$3, reviewed_by=$2, updated_at=now()';
    if (opts.setPublished) set += ', published_at=now()';
    if (opts.review) { vals.push(opts.reason || null); set += `, review_reason=$${vals.length}`; }
    const { rows } = await client.query(`UPDATE events SET ${set} WHERE id=$1 RETURNING *`, vals);
    await audit(client, opts.type, eventId, adminId, { from: ev.status, to: opts.to, reason: opts.reason || undefined });
    return rows[0];
  });
}

/** Approve & Publish (submitted → published) — the single admin approval action. */
function adminPublish(adminId, eventId) {
  return applyAdminTransition(adminId, eventId, { action: 'publish', from: ['submitted'], to: 'published', type: 'event.published', setPublished: true });
}
async function adminReject(adminId, eventId, reason) {
  if (!reason || !String(reason).trim()) throw svcErr(400, 'REASON_REQUIRED', 'A rejection reason is required.');
  return applyAdminTransition(adminId, eventId, { action: 'reject', from: ['submitted'], to: 'rejected', type: 'event.rejected', review: true, reason });
}
async function adminReturnToDraft(adminId, eventId, reason) {
  if (!reason || !String(reason).trim()) throw svcErr(400, 'REASON_REQUIRED', 'A reason is required.');
  return applyAdminTransition(adminId, eventId, { action: 'return to draft', from: ['submitted'], to: 'draft', type: 'event.returned_to_draft', review: true, reason });
}
function adminArchive(adminId, eventId) {
  return applyAdminTransition(adminId, eventId, { action: 'archive', from: ['draft', 'submitted', 'published', 'rejected'], to: 'archived', type: 'event.archived' });
}

/** Plan primitive for future featured placements (behavior deferred in Phase 1). */
async function assertCanFeature(orgId, client) {
  const plan = await getPlanForOrg(client || db, orgId);
  if (!plan.can_feature_events) throw svcErr(422, 'FEATURE_NOT_ALLOWED', 'Your plan does not include featured events.');
}

module.exports = {
  STATUSES, ACTIVE_STATES, EDITABLE_STATES,
  deriveOrganizerBadge, eventTypeLabel,
  getById, listForOrg, listImages, countActiveEvents,
  createDraft, updateDraft, submit, archiveByOwner,
  addImage, removeImage,
  adminPublish, adminReject, adminReturnToDraft, adminArchive,
  assertCanFeature,
};
