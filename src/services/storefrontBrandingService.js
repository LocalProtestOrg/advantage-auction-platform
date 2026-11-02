'use strict';

/**
 * storefrontBrandingService — the storefront's hero image and logo, uploaded directly (Storefront Settings).
 *
 * - Hero image: the storefront config's existing `hero_image` (an image URL; sellers may still type one in).
 * - Logo: the seller's existing logo record, seller_profiles.logo_url, already shown on the storefront, auction pages and
 *   the website widget. No second logo field.
 * - Files go to the persistent image store (cloudinaryService, the same one item photos use), never to local disk. The
 *   original file is kept, so quality and proportions are untouched; pages size it with CSS (cover for the banner,
 *   contain for the logo).
 * - Validation: at most 10 MB, and the bytes must be a JPEG, PNG, GIF, WebP or HEIC photo (the item-photo check).
 * - Ownership: the company comes from the session (seller checkpoint); Professional Sellers only. The stored file's id is
 *   kept in seller_profiles.metadata.branding so a replaced or removed upload is deleted from the store (best effort).
 *   A URL the seller typed in is never deleted from anywhere.
 */

const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');
const { isProfessional } = require('./sellerTypeRules');
const { sniffImage, MAX_PHOTO_BYTES } = require('./storefrontPhotoService');

const KINDS = { hero: 'hero', logo: 'logo' };
function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const defaultUploader = (buffer, kind) => require('./cloudinaryService').uploadBuffer(buffer, { folder: 'storefront-branding' });
const defaultDestroyer = (publicId) => require('./cloudinaryService').destroy(publicId);

async function sellerFor(ctx, runner = db) {
  const sp = (await runner.query('SELECT id, seller_type, logo_url, storefront, metadata FROM seller_profiles WHERE id = $1', [ctx && ctx.sellerId])).rows[0];
  if (!sp) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  if (!isProfessional(sp.seller_type)) throw err(403, 'NOT_PROFESSIONAL', 'Storefronts are for Professional Sellers.');
  return sp;
}
function kindOf(k) { const v = KINDS[String(k || '')]; if (!v) throw err(404, 'NOT_FOUND', 'Unknown image.'); return v; }
const current = (sp, kind) => (kind === 'logo' ? sp.logo_url || null : ((sp.storefront || {}).hero_image || null));

/** Save `url` (and its stored-file id, or null for a typed URL) as the hero or logo; returns the previous stored id. */
async function save(client, sp, kind, url, publicId) {
  const branding = { ...((sp.metadata || {}).branding || {}) };
  const previous = branding[kind + '_public_id'] || null;
  if (publicId) branding[kind + '_public_id'] = publicId; else delete branding[kind + '_public_id'];
  if (kind === 'logo') {
    await client.query(`UPDATE seller_profiles SET logo_url = $2, metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{branding}', $3::jsonb) WHERE id = $1`,
      [sp.id, url, JSON.stringify(branding)]);
  } else {
    await client.query(`UPDATE seller_profiles SET storefront = CASE WHEN $2::text IS NULL THEN coalesce(storefront, '{}'::jsonb) - 'hero_image'
                                                                     ELSE jsonb_set(coalesce(storefront, '{}'::jsonb), '{hero_image}', to_jsonb($2::text)) END,
                               metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{branding}', $3::jsonb) WHERE id = $1`,
      [sp.id, url, JSON.stringify(branding)]);
  }
  return previous;
}

/** Upload a new hero image or logo for the session's company. */
async function upload(ctx, actorId, rawKind, file, { uploader = defaultUploader, destroyer = defaultDestroyer } = {}) {
  const kind = kindOf(rawKind);
  const sp = await sellerFor(ctx);
  if (!file || !file.buffer || !file.buffer.length) throw err(400, 'NO_FILE', 'Choose a photo to upload.');
  if (file.buffer.length > MAX_PHOTO_BYTES) throw err(413, 'PHOTO_TOO_LARGE', 'That photo is larger than 10 MB.');
  if (!sniffImage(file.buffer)) throw err(415, 'NOT_A_PHOTO', 'That file is not a JPEG, PNG, GIF, WebP or HEIC photo.');
  const up = await uploader(file.buffer, kind);
  if (!up || !up.secure_url) throw err(502, 'UPLOAD_FAILED', 'The photo could not be saved. Please try again.');
  const previous = await save(db, sp, kind, up.secure_url, up.public_id || null);
  if (previous && previous !== up.public_id) Promise.resolve().then(() => destroyer(previous)).catch(() => {});
  await writeAuditLog({ event_type: 'storefront_branding_uploaded', entity_type: 'seller_profile', entity_id: sp.id, actor_id: actorId || null,
    metadata: { kind, bytes: file.buffer.length, replaced: !!current(sp, kind) } });
  return { kind, url: up.secure_url, width: up.width || null, height: up.height || null };
}

/** Remove the hero image or logo (the storefront shows its fallback). */
async function remove(ctx, actorId, rawKind, { destroyer = defaultDestroyer } = {}) {
  const kind = kindOf(rawKind);
  const sp = await sellerFor(ctx);
  const had = current(sp, kind);
  const previous = await save(db, sp, kind, null, null);
  if (previous) Promise.resolve().then(() => destroyer(previous)).catch(() => {});
  if (had) await writeAuditLog({ event_type: 'storefront_branding_removed', entity_type: 'seller_profile', entity_id: sp.id, actor_id: actorId || null, metadata: { kind } });
  return { kind, url: null };
}

module.exports = { upload, remove, KINDS };
