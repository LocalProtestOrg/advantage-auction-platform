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
const { withTransaction } = require('../utils/withTransaction');
const { generateUniqueSlug } = require('../utils/slug');

const { svcErr } = orgs;

const STATUSES = ['draft', 'submitted', 'published', 'rejected', 'archived'];
const ACTIVE_STATES = ['submitted', 'published'];      // count toward max_active_events
const EDITABLE_STATES = new Set(['draft', 'rejected']); // owner may edit / change images

// camelCase input → column, for create/update allowlists
const FIELD_MAP = {
  title: 'title', description: 'description', marketSlug: 'market_slug', categorySlug: 'category_slug',
  venueName: 'venue_name', address: 'address', city: 'city', state: 'state', zip: 'zip',
  lat: 'lat', lng: 'lng', startAt: 'start_at', endAt: 'end_at', timezone: 'timezone', externalUrl: 'external_url',
};

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

  return withTransaction(async (client) => {
    await orgs.assertOwner(userId, org.id, client);
    const slug = await generateUniqueSlug('events', title, client);
    const { rows } = await client.query(
      `INSERT INTO events
         (slug, organization_id, source, market_slug, category_slug, title, description,
          venue_name, address, city, state, zip, lat, lng, start_at, end_at, timezone, external_url, status)
       VALUES ($1,$2,'organization',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'draft')
       RETURNING *`,
      [slug, org.id, input.marketSlug, input.categorySlug || null, title, input.description || null,
       input.venueName || null, input.address || null, input.city || null, input.state || null, input.zip || null,
       num(input.lat), num(input.lng), input.startAt, input.endAt || null,
       input.timezone || 'America/New_York', input.externalUrl || null]);
    const ev = rows[0];
    await audit(client, 'event.created', ev.id, userId, { title: ev.title, market: ev.market_slug });
    return ev;
  });
}

/** Owner edit — allowed only in draft/rejected. */
async function updateDraft(userId, eventId, input = {}) {
  return withTransaction(async (client) => {
    const ev = await loadOwnedEvent(client, eventId, userId);
    if (!EDITABLE_STATES.has(ev.status)) {
      throw svcErr(409, 'EVENT_NOT_EDITABLE', `Only draft or rejected events can be edited (current: ${ev.status}).`);
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
}

/** Owner submit (draft|rejected → submitted). Enforces the active-event plan limit here. */
async function submit(userId, eventId) {
  return withTransaction(async (client) => {
    const ev = await loadOwnedEvent(client, eventId, userId);
    if (!['draft', 'rejected'].includes(ev.status)) {
      throw svcErr(409, 'INVALID_TRANSITION', `Cannot submit from ${ev.status}.`);
    }
    const plan = await getPlanForOrg(client, ev.organization_id);
    const active = await countActiveEvents(ev.organization_id, client);
    if (active >= plan.max_active_events) {
      throw svcErr(422, 'ACTIVE_EVENT_LIMIT',
        `Your plan allows ${plan.max_active_events} active events. Archive one to submit another.`);
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
function adminReject(adminId, eventId, reason) {
  if (!reason || !String(reason).trim()) throw svcErr(400, 'REASON_REQUIRED', 'A rejection reason is required.');
  return applyAdminTransition(adminId, eventId, { action: 'reject', from: ['submitted'], to: 'rejected', type: 'event.rejected', review: true, reason });
}
function adminReturnToDraft(adminId, eventId, reason) {
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
  deriveOrganizerBadge,
  getById, listForOrg, listImages, countActiveEvents,
  createDraft, updateDraft, submit, archiveByOwner,
  addImage, removeImage,
  adminPublish, adminReject, adminReturnToDraft, adminArchive,
  assertCanFeature,
};
