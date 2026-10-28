'use strict';

/**
 * storefrontPhotoService — bulk photographs for a Professional Seller's storefront items (migration 207).
 *
 * Matching (documented on the seller's Inventory page), only against THIS seller's own draft / published / paused items:
 *   1. "SKU.jpg"                      → the item with that SKU (its first new photo)
 *   2. "SKU_2.jpg", "SKU-2.jpg", "SKU (2).jpg" → the same item, in number order
 *   3. inside a ZIP, a folder named after the SKU: "SKU/front.jpg", "SKU/back.jpg" → that item, in file-name order
 * A file that matches no item is reported and NOT uploaded. No photo is ever invented, substituted or generated, and an
 * item with no photo stays visibly "No photo".
 *
 * Safety: the file's own bytes must be a JPEG, PNG, GIF, WebP or HEIC image (the name and the browser's type are not
 * trusted; SVG and everything else are refused); each photo ≤ 10 MB; a ZIP is read with the bounded zipReader. The
 * original file is stored unchanged through the existing photo storage (cloudinaryService), which also serves the
 * web-sized versions. The same photo (same checksum) is attached to an item only once, so a repeated upload is harmless.
 */

const crypto = require('crypto');
const db = require('../db');
const items = require('./marketplaceItemService');
const zip = require('../lib/zipReader');
const { isProfessional } = require('./sellerTypeRules');
const { withTransaction } = require('../utils/withTransaction');

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const ZIP_LIMITS = { maxEntries: 300, maxEntryBytes: MAX_PHOTO_BYTES, maxTotalBytes: 400 * 1024 * 1024, maxRatio: 200 };

/** The image type from the file's own first bytes, or null. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 6).toString('latin1') === 'GIF87a' || buf.slice(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(buf.slice(8, 12).toString('latin1'))) return 'heic';
  return null;
}

const IGNORED = (name) => /(^|\/)(__MACOSX|\.)/.test(name) || /(^|\/)(Thumbs\.db|desktop\.ini)$/i.test(name);
const baseName = (name) => String(name || '').split(/[\\/]/).pop();
const folderName = (name) => { const parts = String(name || '').split(/[\\/]/).filter(Boolean); return parts.length > 1 ? parts[parts.length - 2] : null; };
const stem = (name) => baseName(name).replace(/\.[A-Za-z0-9]{1,5}$/, '');
const safeName = (name) => baseName(name).replace(/[\u0000-\u001f\u007f]+/g, '').slice(0, 255);

/**
 * Which item a file belongs to: { key, order } (key = lower-case SKU) or null. `skus` is a Map(lowerSku → item).
 */
function matchFile(name, skus) {
  const raw = String(name || '');
  if (raw.length > 255) return null;                         // never examine an absurdly long name
  const s = stem(raw).trim();
  if (!s || s.length > 70) {                                 // a SKU is at most 64 characters (+ a photo number)
    const folder = folderName(raw);
    return folder && folder.length <= 64 && skus.has(folder.trim().toLowerCase()) ? { key: folder.trim().toLowerCase(), order: 1000 } : null;
  }
  if (skus.has(s.toLowerCase())) return { key: s.toLowerCase(), order: 1 };
  const numbered = splitNumbered(s);
  if (numbered && skus.has(numbered.prefix.toLowerCase())) return { key: numbered.prefix.toLowerCase(), order: numbered.n };
  const folder = folderName(raw);
  if (folder && folder.length <= 64 && skus.has(folder.trim().toLowerCase())) return { key: folder.trim().toLowerCase(), order: 1000 };
  return null;
}
// "SKU_2", "SKU-2", "SKU 2", "SKU (2)", "SKU_(2)" → { prefix: "SKU", n: 2 }. Plain string scanning (no backtracking).
function splitNumbered(s) {
  let end = s.length; let paren = false;
  if (s[end - 1] === ')') { paren = true; end--; }
  let i = end;
  while (i > 0 && i > end - 3 && s[i - 1] >= '0' && s[i - 1] <= '9') i--;
  if (i === end || (i > 0 && s[i - 1] >= '0' && s[i - 1] <= '9')) return null;   // no number, or more than 3 digits
  const n = parseInt(s.slice(i, end), 10);
  let j = i;
  if (paren) { if (s[j - 1] !== '(') return null; j--; }
  let k = j;
  while (k > 0 && s[k - 1] === ' ') k--;
  if (k > 0 && '_- '.includes(s[k - 1])) k--;
  else if (!paren && k === j) return null;                    // "SKU2" is not a numbered photo of "SKU"
  while (k > 0 && s[k - 1] === ' ') k--;
  const prefix = s.slice(0, k);
  return prefix ? { prefix, n } : null;
}

async function sellerOf(actor) {
  const seller = await items.sellerForUser(actor);
  if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  if (!isProfessional(seller.seller_type)) throw err(403, 'NOT_PROFESSIONAL', 'Storefront photos are for Professional Sellers.');
  return seller;
}
const actorUserId = (actor) => (actor && typeof actor === 'object' ? actor.userId : actor) || null;

// This seller's items that can take photos, keyed by lower-case SKU.
async function photoTargets(sellerId) {
  const { rows } = await db.query(
    `SELECT id, inventory_number, title, status, images FROM marketplace_items
      WHERE seller_id = $1 AND inventory_number IS NOT NULL AND status IN ('draft','active','paused')`, [sellerId]);
  return new Map(rows.map((r) => [r.inventory_number.toLowerCase(), r]));
}

// Store one photo on one item (already matched and checked). Returns an outcome row.
async function attach(seller, actor, item, file, source, uploader) {
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const dup = (await db.query('SELECT 1 FROM storefront_item_photos WHERE item_id = $1 AND sha256 = $2', [item.id, sha])).rowCount;
  if (dup) return { file: file.name, outcome: 'skipped', code: 'ALREADY_ATTACHED', message: 'This photo is already on the item.', sku: item.inventory_number, item_id: item.id };
  const current = Array.isArray(item.images) ? item.images.length : 0;
  if (current >= items.MAX_PHOTOS) return { file: file.name, outcome: 'skipped', code: 'ITEM_FULL', message: `The item already has ${items.MAX_PHOTOS} photos.`, sku: item.inventory_number, item_id: item.id };
  const up = await uploader(file.buffer);                     // the original file, unchanged
  if (!up || typeof up.secure_url !== 'string' || !/^https:\/\//i.test(up.secure_url)) throw err(502, 'PHOTO_STORAGE_FAILED', 'The photo could not be stored. Please try again.');
  try {
    const res = await withTransaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO storefront_item_photos (item_id, seller_id, uploaded_by, url, public_id, sha256, original_filename, bytes, width, height, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (item_id, sha256) DO NOTHING RETURNING id`,
        [item.id, seller.id, actorUserId(actor), up.secure_url, up.public_id || null, sha, file.name, file.buffer.length, up.width || null, up.height || null, source]);
      if (!ins.rows.length) return { duplicate: true };
      const r = await items.appendPhotos(item.id, seller.id, [up.secure_url], client);
      if (!r.added) throw err(409, 'ITEM_FULL', `The item already has ${items.MAX_PHOTOS} photos.`);
      item.images = r.item.images;
      return { duplicate: false };
    });
    if (res.duplicate) { cleanup(up); return { file: file.name, outcome: 'skipped', code: 'ALREADY_ATTACHED', message: 'This photo is already on the item.', sku: item.inventory_number, item_id: item.id }; }
    return { file: file.name, outcome: 'attached', sku: item.inventory_number, item_id: item.id };
  } catch (e) {
    cleanup(up);
    if (e && e.status && e.status < 500) return { file: file.name, outcome: 'skipped', code: e.code, message: e.message, sku: item.inventory_number, item_id: item.id };
    throw e;
  }
}
function cleanup(up) {
  if (up && up.public_id) require('./cloudinaryService').destroy(up.public_id).catch(() => {});
}

const defaultUploader = (buffer) => require('./cloudinaryService').uploadBuffer(buffer, { folder: 'storefront-items' });

/**
 * Bulk photos matched by SKU. `files` = [{ name, buffer }] (separate uploads) or the entries of one ZIP (`zipBuffer`).
 * Returns { attached, skipped, unmatched, rejected, results: [...] } — one result per file.
 */
async function uploadMatched(actor, { files = [], zipBuffer = null, uploader = defaultUploader }) {
  const seller = await sellerOf(actor);
  const source = zipBuffer ? 'zip' : 'upload';
  let list = files.map((f) => ({ name: String(f.name || ''), buffer: f.buffer }));
  if (zipBuffer) {
    const entries = zip.listEntries(zipBuffer, ZIP_LIMITS);
    list = [];
    for (const e of entries) {
      if (IGNORED(e.name)) continue;
      if (e.size > MAX_PHOTO_BYTES) { list.push({ name: e.name, tooLarge: true }); continue; }
      list.push({ name: e.name, entry: e });
    }
  }
  const skus = await photoTargets(seller.id);
  const results = []; const plan = [];
  for (const f of list) {
    const name = safeName(f.name);
    if (f.tooLarge) { results.push({ file: name, outcome: 'rejected', code: 'PHOTO_TOO_LARGE', message: 'Larger than 10 MB.' }); continue; }
    const m = matchFile(f.name, skus);
    if (!m) { results.push({ file: name, outcome: 'unmatched', code: 'NO_MATCHING_SKU', message: `No draft, published or paused item has the SKU "${stem(f.name).slice(0, 64)}".` }); continue; }
    plan.push({ ...f, name, match: m });
  }
  // Within an item: numbered order, then file name; files are processed one at a time (bounded memory).
  plan.sort((a, b) => (a.match.key < b.match.key ? -1 : a.match.key > b.match.key ? 1 : (a.match.order - b.match.order) || a.name.localeCompare(b.name, undefined, { numeric: true })));
  for (const p of plan) {
    let buffer = p.buffer;
    try { if (p.entry) buffer = zip.readEntry(zipBuffer, p.entry, ZIP_LIMITS); }
    catch (e) { results.push({ file: p.name, outcome: 'rejected', code: e.code || 'ZIP_INVALID', message: e.message }); continue; }
    if (!Buffer.isBuffer(buffer) || !buffer.length) { results.push({ file: p.name, outcome: 'rejected', code: 'PHOTO_EMPTY', message: 'The file is empty.' }); continue; }
    if (buffer.length > MAX_PHOTO_BYTES) { results.push({ file: p.name, outcome: 'rejected', code: 'PHOTO_TOO_LARGE', message: 'Larger than 10 MB.' }); continue; }
    if (!sniffImage(buffer)) { results.push({ file: p.name, outcome: 'rejected', code: 'NOT_A_PHOTO', message: 'Not a JPEG, PNG, GIF, WebP or HEIC photo.' }); continue; }
    const item = skus.get(p.match.key);
    results.push(await attach(seller, actor, item, { name: p.name, buffer }, source, uploader));
  }
  const count = (o) => results.filter((r) => r.outcome === o).length;
  return { attached: count('attached'), skipped: count('skipped'), unmatched: count('unmatched'), rejected: count('rejected'), results };
}

/** Photos for ONE item chosen by the seller (for items without a SKU, or a quick add from the inventory list). */
async function uploadToItem(actor, itemId, files = [], uploader = defaultUploader) {
  const seller = await sellerOf(actor);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(itemId || ''))) throw err(404, 'NOT_FOUND', 'Listing not found.');
  const item = (await db.query(`SELECT id, inventory_number, title, status, images FROM marketplace_items WHERE id = $1 AND seller_id = $2`, [itemId, seller.id])).rows[0];
  if (!item) throw err(404, 'NOT_FOUND', 'Listing not found.');
  if (!['draft', 'active', 'paused'].includes(item.status)) throw err(409, 'ITEM_SOLD', 'Photos can be added to draft, published or paused items only.');
  const results = [];
  for (const f of files) {
    const name = safeName(f.name);
    if (!Buffer.isBuffer(f.buffer) || !f.buffer.length) { results.push({ file: name, outcome: 'rejected', code: 'PHOTO_EMPTY', message: 'The file is empty.' }); continue; }
    if (f.buffer.length > MAX_PHOTO_BYTES) { results.push({ file: name, outcome: 'rejected', code: 'PHOTO_TOO_LARGE', message: 'Larger than 10 MB.' }); continue; }
    if (!sniffImage(f.buffer)) { results.push({ file: name, outcome: 'rejected', code: 'NOT_A_PHOTO', message: 'Not a JPEG, PNG, GIF, WebP or HEIC photo.' }); continue; }
    results.push(await attach(seller, actor, item, { name, buffer: f.buffer }, 'upload', uploader));
  }
  const count = (o) => results.filter((r) => r.outcome === o).length;
  return { attached: count('attached'), skipped: count('skipped'), rejected: count('rejected'), results };
}

module.exports = { uploadMatched, uploadToItem, matchFile, splitNumbered, sniffImage, MAX_PHOTO_BYTES, ZIP_LIMITS };
