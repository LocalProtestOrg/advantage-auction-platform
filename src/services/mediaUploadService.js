'use strict';

/**
 * mediaUploadService — reusable Advantage media-upload infrastructure (platform-wide).
 *
 * Signed direct-to-object-storage uploads: the browser requests a short-lived signature scoped
 * to a CONTEXT (folder + resource type + authorization), then uploads bytes DIRECTLY to
 * Cloudinary — the file bytes never pass through Railway. This is the single upload backbone for
 * the whole platform; Marketplace Events is the first consumer.
 *
 * The uploader CORE here is context-agnostic. Each product module registers a context supplying:
 *   { folder, resourceType, allowedFormats, maxBytes, authorize({ user, resourceId }) }
 * and the shared client component (public/widgets/shared/media-uploader.js) does the rest.
 *
 * Registered today:
 *   • event_images — Marketplace Event photos
 * Planned future contexts (register the same way, no core changes):
 *   • lot_images, marketplace_item_images (incl. post-auction unsold-lot → fixed-price listings),
 *     company_logo, profile_photo, marketing_asset, seller_document, event_video.
 */

const db = require('../db');
const orgsService = require('./organizationsService');
const cloudinaryService = require('./cloudinaryService');

const { svcErr } = orgsService;

const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'];
const IMAGE_MAX_BYTES = 15 * 1024 * 1024; // 15 MB per image

// ── Context registry ──────────────────────────────────────────────────────────
const REGISTRY = new Map();

/** Register (or replace) an upload context. Product modules call this to opt in. */
function register(key, cfg) {
  if (!key || !cfg || typeof cfg.authorize !== 'function' || !cfg.folder) {
    throw new Error('register(context) requires { folder, authorize(), ... }');
  }
  REGISTRY.set(key, Object.assign({ resourceType: 'image', allowedFormats: IMAGE_FORMATS, maxBytes: IMAGE_MAX_BYTES }, cfg));
}
function getContext(key) { return REGISTRY.get(key); }

// ── Built-in context: Marketplace Event images ───────────────────────────────
register('event_images', {
  folder: 'event-images',
  resourceType: 'image',
  allowedFormats: IMAGE_FORMATS,
  maxBytes: IMAGE_MAX_BYTES,
  // Only the event's organization owner may upload, and only while the event is editable.
  async authorize({ user, resourceId }) {
    if (!resourceId) throw svcErr(400, 'RESOURCE_REQUIRED', 'An event id is required.');
    const { rows } = await db.query('SELECT organization_id, status FROM events WHERE id = $1', [resourceId]);
    if (!rows.length) throw svcErr(404, 'EVENT_NOT_FOUND', 'Event not found.');
    await orgsService.assertOwner(user.id, rows[0].organization_id);
    if (!['draft', 'rejected'].includes(rows[0].status)) {
      throw svcErr(409, 'EVENT_NOT_EDITABLE', 'Photos can only be added to draft or rejected events.');
    }
  },
});

/**
 * Produce a signed, short-lived upload payload for a context after authorizing the caller.
 * The client uploads directly to Cloudinary with these params. The api_secret never leaves here.
 */
async function signUpload({ user, context, resourceId }) {
  const ctx = getContext(context);
  if (!ctx) throw svcErr(400, 'UNKNOWN_UPLOAD_CONTEXT', 'Unknown or unsupported upload context.');
  if (!user || !user.id) throw svcErr(401, 'AUTH_REQUIRED', 'Authentication is required.');
  await ctx.authorize({ user, resourceId });

  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = { folder: ctx.folder, timestamp }; // exactly what the client must echo
  const signature = cloudinaryService.signUpload(paramsToSign);
  const pub = cloudinaryService.publicConfig();

  return {
    cloud_name: pub.cloud_name,
    api_key: pub.api_key,
    timestamp,
    signature,
    folder: ctx.folder,
    resource_type: ctx.resourceType,
    max_bytes: ctx.maxBytes,
    allowed_formats: ctx.allowedFormats,
  };
}

module.exports = { register, getContext, signUpload, REGISTRY };
