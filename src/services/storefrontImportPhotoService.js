'use strict';

/**
 * storefrontImportPhotoService — step 3 of the marketplace importer, "Add or Match Photos" (migration 209).
 *
 * Photos are staged for ONE import batch and matched to its spreadsheet rows before any item exists; each new draft
 * receives its row's photos, in the seller's order, when it is created (attachRowPhotos). Matching, in order:
 *   1. The seller's manual choice for a file (assign: { fileName → row }).
 *   2. A file name written in the row's Photo_1..Photo_15 cells ("126721_2.jpg"): that row, in that column's position.
 *   3. The chosen matching reference (Inventory Number, the original auction lot number, or another column):
 *      "REF.jpg", "REF_2.jpg" / "REF-2.jpg" / "REF (2).jpg", or a ZIP folder named REF ("REF/front.jpg").
 * A file that matches no row, or more than one row (ambiguous), is reported and NOT stored; the seller can assign it.
 * The same photo (same checksum) is staged once per batch (duplicates are reported and skipped).
 * Photo links in the spreadsheet are fetched by fetchLinks through the network guard (src/services/eventImport/netGuard):
 * public addresses only, connection pinned to the checked address, same-site redirects only, a size cap and a timeout.
 *
 * Every file's own bytes must be a JPEG, PNG, GIF, WebP or HEIC image (names and declared types are not trusted; SVG and
 * everything else are refused); each photo ≤ 10 MB. Originals are stored unchanged through the existing photo storage.
 * No photo is ever invented, edited or substituted. Everything is scoped to the batch's own seller.
 */

const crypto = require('crypto');
const db = require('../db');
const items = require('./marketplaceItemService');
const zip = require('../lib/zipReader');
const imports = require('./storefrontImportService');
const { sniffImage, matchFile, MAX_PHOTO_BYTES, ZIP_LIMITS } = require('./storefrontPhotoService');
const { withTransaction } = require('../utils/withTransaction');

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const actorUserId = (actor) => (actor && typeof actor === 'object' ? actor.userId : actor) || null;
const IGNORED = (name) => /(^|\/)(__MACOSX|\.)/.test(name) || /(^|\/)(Thumbs\.db|desktop\.ini)$/i.test(name);
const baseName = (name) => String(name || '').split(/[\\/]/).pop();
const safeName = (name) => baseName(name).replace(/[\u0000-\u001f\u007f]+/g, '').slice(0, 255);
const MAX_PER_ROW = items.MAX_PHOTOS;     // 24, the same limit as any item
const LINKS_PER_CALL = 10;

const defaultUploader = (buffer) => require('./cloudinaryService').uploadBuffer(buffer, { folder: 'storefront-items' });
function cleanup(up) { if (up && up.public_id) require('./cloudinaryService').destroy(up.public_id).catch(() => {}); }

async function ownOpenBatch(actor, batchId) {
  const seller = await imports.sellerOf(actor);
  const b = await imports.loadOwnBatch(seller.id, batchId);
  if (b.status === 'cancelled') throw err(409, 'IMPORT_CANCELLED', 'This import was cancelled.');
  if (b.status === 'completed' || b.status === 'completed_with_errors') throw err(409, 'IMPORT_FINISHED', 'This import is finished. Add more photos from your inventory.');
  return { seller, b };
}
const importable = (r) => r.action === 'create' || r.action === 'update';

// Lookups built from the batch's rows.
function indexes(b) {
  const byFile = new Map();    // lower file name → [{ row, position }]
  const byRef = new Map();     // lower matching reference → [row]
  const rows = new Map();
  for (const r of (b.rows || [])) {
    if (!importable(r)) continue;
    rows.set(r.row, r);
    const v = r.values || {};
    (v.photo_refs || []).forEach((p, i) => {
      if (p.type !== 'file') return;
      const k = p.value.toLowerCase();
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k).push({ row: r.row, position: i });
    });
    if (v.match_ref) { const k = String(v.match_ref).toLowerCase(); if (!byRef.has(k)) byRef.set(k, []); byRef.get(k).push(r.row); }
  }
  return { byFile, byRef, rows };
}

/** Which row a file belongs to: { row, position } | { ambiguous: [rows] } | null. */
function matchToRow(name, idx, assign) {
  const base = baseName(name);
  if (assign && Object.prototype.hasOwnProperty.call(assign, base)) {
    const row = Number(assign[base]);
    return idx.rows.has(row) ? { row, position: 500, manual: true } : null;
  }
  const explicit = idx.byFile.get(base.toLowerCase());
  if (explicit) {
    const rowsHit = [...new Set(explicit.map((x) => x.row))];
    if (rowsHit.length > 1) return { ambiguous: rowsHit };
    return { row: explicit[0].row, position: explicit[0].position };
  }
  // Pattern match on the reference: only unambiguous references are candidates; an ambiguous one is reported as such.
  const single = new Map(); const multi = new Map();
  for (const [k, list] of idx.byRef) (list.length === 1 ? single : multi).set(k, list);
  const m = matchFile(name, single);
  if (m) return { row: single.get(m.key)[0], position: m.order === 1 ? 100 : m.order === 1000 ? 1000 : 100 + m.order };
  const am = matchFile(name, multi);
  if (am) return { ambiguous: multi.get(am.key) };
  return null;
}

async function bumpStats(batchId, sellerId, counts) {
  const keys = Object.keys(counts).filter((k) => counts[k]);
  if (!keys.length) return;
  const b = (await db.query('SELECT photo_match FROM storefront_import_batches WHERE id = $1 AND seller_id = $2', [batchId, sellerId])).rows[0];
  if (!b) return;
  const pm = Object.assign({}, b.photo_match || {});
  pm.stats = Object.assign({}, pm.stats || {});
  for (const k of keys) pm.stats[k] = (pm.stats[k] || 0) + counts[k];
  await db.query('UPDATE storefront_import_batches SET photo_match = $3::jsonb, updated_at = now() WHERE id = $1 AND seller_id = $2', [batchId, sellerId, JSON.stringify(pm)]);
}

async function stage(seller, actor, b, row, position, file, source, sourceUrl, uploader) {
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const dup = (await db.query('SELECT row_number FROM storefront_import_photos WHERE batch_id = $1 AND sha256 = $2', [b.id, sha])).rows[0];
  if (dup) return { file: file.name, outcome: 'duplicate', code: 'DUPLICATE_PHOTO', message: `The same photo is already matched${dup.row_number ? ' to row ' + dup.row_number : ''}.`, row: dup.row_number };
  const n = (await db.query("SELECT count(*)::int AS n FROM storefront_import_photos WHERE batch_id = $1 AND row_number = $2 AND status = 'staged'", [b.id, row])).rows[0].n;
  if (n >= MAX_PER_ROW) return { file: file.name, outcome: 'skipped', code: 'ROW_FULL', message: `Row ${row} already has ${MAX_PER_ROW} photos.`, row };
  const up = await uploader(file.buffer);                       // the original file, unchanged
  if (!up || typeof up.secure_url !== 'string' || !/^https:\/\//i.test(up.secure_url)) throw err(502, 'PHOTO_STORAGE_FAILED', 'The photo could not be stored. Please try again.');
  const ins = await db.query(
    `INSERT INTO storefront_import_photos (batch_id, seller_id, uploaded_by, row_number, position, url, public_id, sha256, original_filename, source, source_url, bytes, width, height)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (batch_id, sha256) DO NOTHING RETURNING id`,
    [b.id, seller.id, actorUserId(actor), row, position, up.secure_url, up.public_id || null, sha, file.name, source, sourceUrl || null, file.buffer.length, up.width || null, up.height || null]);
  if (!ins.rows.length) { cleanup(up); return { file: file.name, outcome: 'duplicate', code: 'DUPLICATE_PHOTO', message: 'The same photo is already matched.' }; }
  return { file: file.name, outcome: 'matched', row, photo_id: ins.rows[0].id, url: up.secure_url };
}

/**
 * Upload photo files (up to 10 per call) or one ZIP for a batch, matched to its rows. assign: { fileName: row } for files
 * the seller matched by hand. Returns { matched, unmatched, ambiguous, duplicate, rejected, results }.
 */
async function uploadToBatch(actor, batchId, { files = [], zipBuffer = null, assign = null, uploader = defaultUploader } = {}) {
  const { seller, b } = await ownOpenBatch(actor, batchId);
  const source = zipBuffer ? 'zip' : 'upload';
  let list = files.map((f) => ({ name: String(f.name || ''), buffer: f.buffer }));
  if (zipBuffer) {
    list = [];
    for (const e of zip.listEntries(zipBuffer, ZIP_LIMITS)) {
      if (IGNORED(e.name) || /\/$/.test(e.name)) continue;
      if (e.size > MAX_PHOTO_BYTES) { list.push({ name: e.name, tooLarge: true }); continue; }
      list.push({ name: e.name, entry: e });
    }
  }
  const idx = indexes(b);
  const results = [];
  for (const f of list) {
    const name = safeName(f.name);
    if (f.tooLarge) { results.push({ file: name, outcome: 'rejected', code: 'PHOTO_TOO_LARGE', message: 'Larger than 10 MB.' }); continue; }
    const m = matchToRow(f.name, idx, assign);
    if (!m) { results.push({ file: name, outcome: 'unmatched', code: 'NO_MATCHING_ROW', message: 'No spreadsheet row names this photo or matches its file name.' }); continue; }
    if (m.ambiguous) { results.push({ file: name, outcome: 'ambiguous', code: 'AMBIGUOUS', message: `This photo could belong to rows ${m.ambiguous.slice(0, 5).join(', ')}. Choose the row.`, rows: m.ambiguous.slice(0, 20) }); continue; }
    let buffer = f.buffer;
    try { if (f.entry) buffer = zip.readEntry(zipBuffer, f.entry, ZIP_LIMITS); }
    catch (e) { results.push({ file: name, outcome: 'rejected', code: e.code || 'ZIP_INVALID', message: e.message }); continue; }
    if (!Buffer.isBuffer(buffer) || !buffer.length) { results.push({ file: name, outcome: 'rejected', code: 'PHOTO_EMPTY', message: 'The file is empty.' }); continue; }
    if (buffer.length > MAX_PHOTO_BYTES) { results.push({ file: name, outcome: 'rejected', code: 'PHOTO_TOO_LARGE', message: 'Larger than 10 MB.' }); continue; }
    if (!sniffImage(buffer)) { results.push({ file: name, outcome: 'rejected', code: 'NOT_A_PHOTO', message: 'Not a JPEG, PNG, GIF, WebP or HEIC photo.' }); continue; }
    results.push(await stage(seller, actor, b, m.row, m.position, { name, buffer }, source, null, uploader));
  }
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const out = { matched: count('matched'), unmatched: count('unmatched'), ambiguous: count('ambiguous'), duplicate: count('duplicate'), rejected: count('rejected'), skipped: count('skipped'), results };
  await bumpStats(b.id, seller.id, { unmatched: out.unmatched, ambiguous: out.ambiguous, duplicate: out.duplicate, rejected: out.rejected });
  return out;
}

// Photo links still to fetch for a batch: [{ row, position, url }].
async function pendingLinks(b) {
  const done = new Set((await db.query("SELECT source_url FROM storefront_import_photos WHERE batch_id = $1 AND source = 'url'", [b.id])).rows.map((r) => r.source_url));
  const tried = new Set(((b.photo_match && b.photo_match.link_failures) || []).map((f) => f.url));
  const out = [];
  for (const r of (b.rows || [])) {
    if (!importable(r)) continue;
    ((r.values && r.values.photo_refs) || []).forEach((p, i) => { if (p.type === 'url' && !done.has(p.value) && !tried.has(p.value)) out.push({ row: r.row, position: i, url: p.value }); });
  }
  return out;
}

/**
 * Fetch the next photo links named in the spreadsheet (LINKS_PER_CALL per call; the page calls until done). Each link is
 * read through the network guard as raw bytes, must be an image by its own bytes, and is stored unchanged.
 */
async function fetchLinks(actor, batchId, { fetcher = null, uploader = defaultUploader, limit = LINKS_PER_CALL } = {}) {
  const { seller, b } = await ownOpenBatch(actor, batchId);
  const todo = (await pendingLinks(b)).slice(0, Math.min(limit, LINKS_PER_CALL));
  const netGuard = require('./eventImport/netGuard');
  const get = fetcher || ((url) => netGuard.safeFetch(url, { binary: true, accept: 'image/avif,image/webp,image/jpeg,image/png,image/gif,image/*;q=0.8', maxBytes: MAX_PHOTO_BYTES, timeoutMs: 20000 }));
  const results = []; const failures = [];
  for (const t of todo) {
    let r;
    try { r = await get(t.url); } catch (e) { r = { ok: false, reason: 'network' }; }
    const fail = (code, message) => { failures.push({ url: t.url, row: t.row, code, message }); results.push({ file: t.url, outcome: 'failed', code, message, row: t.row }); };
    if (!r || !r.ok) {
      const reason = r && r.reason;
      fail(reason === 'too_large' ? 'PHOTO_TOO_LARGE' : reason === 'private_address' || reason === 'blocked' || reason === 'offsite_redirect' || reason === 'protocol_not_allowed' || reason === 'port_not_allowed' || reason === 'credentials_in_url' ? 'LINK_NOT_PERMITTED' : 'LINK_FAILED',
        reason === 'too_large' ? 'The photo at this link is larger than 10 MB.'
          : ['private_address', 'blocked', 'offsite_redirect', 'protocol_not_allowed', 'port_not_allowed', 'credentials_in_url'].includes(reason) ? 'This link is not a permitted public photo address.'
            : `The photo could not be downloaded${r && typeof r.status === 'number' ? ' (the site answered ' + r.status + ')' : ''}.`);
      continue;
    }
    const buf = Buffer.isBuffer(r.body) ? r.body : null;
    if (!buf || !buf.length) { fail('PHOTO_EMPTY', 'The link returned no photo.'); continue; }
    if (!sniffImage(buf)) { fail('NOT_A_PHOTO', 'The link did not return a JPEG, PNG, GIF, WebP or HEIC photo.'); continue; }
    let name = 'photo'; try { name = safeName(decodeURIComponent(new URL(t.url).pathname.split('/').pop() || 'photo')) || 'photo'; } catch (_) { /* keep default */ }
    results.push(await stage(seller, actor, b, t.row, t.position, { name, buffer: buf }, 'url', t.url, uploader));
  }
  if (failures.length) {
    const cur = (await db.query('SELECT photo_match FROM storefront_import_batches WHERE id = $1 AND seller_id = $2', [b.id, seller.id])).rows[0];
    const pm = Object.assign({}, (cur && cur.photo_match) || {});
    pm.link_failures = ((pm.link_failures || []).concat(failures)).slice(-2000);
    await db.query('UPDATE storefront_import_batches SET photo_match = $3::jsonb, updated_at = now() WHERE id = $1 AND seller_id = $2', [b.id, seller.id, JSON.stringify(pm)]);
  }
  const remaining = (await pendingLinks(await imports.loadOwnBatch(seller.id, b.id))).length;
  return { fetched: results.filter((x) => x.outcome === 'matched').length, failed: failures.length, remaining, done: remaining === 0, results };
}

/** Staged photos of a batch and, per row, which named photos are still missing. */
async function listPhotos(actor, batchId) {
  const seller = await imports.sellerOf(actor);
  const b = await imports.loadOwnBatch(seller.id, batchId);
  const photos = (await db.query(
    `SELECT id, row_number, position, url, original_filename, source, source_url FROM storefront_import_photos
      WHERE batch_id = $1 AND seller_id = $2 AND status = 'staged' ORDER BY row_number NULLS LAST, position, created_at`, [b.id, seller.id])).rows;
  const byRow = new Map();
  for (const p of photos) { if (!byRow.has(p.row_number)) byRow.set(p.row_number, []); byRow.get(p.row_number).push(p); }
  const failures = new Map(((b.photo_match && b.photo_match.link_failures) || []).map((f) => [f.url, f]));
  const rows = (b.rows || []).filter(importable).map((r) => {
    const v = r.values || {};
    const mine = byRow.get(r.row) || [];
    const names = new Set(mine.map((p) => String(p.original_filename || '').toLowerCase()));
    const urls = new Set(mine.map((p) => p.source_url).filter(Boolean));
    const missing = (v.photo_refs || []).filter((p) => (p.type === 'file' ? !names.has(p.value.toLowerCase()) : !urls.has(p.value)))
      .map((p) => ({ type: p.type, value: p.value, problem: p.type === 'url' && failures.get(p.value) ? failures.get(p.value).message : null }));
    return { row: r.row, title: v.title || null, inventory_number: v.inventory_number || null, match_ref: v.match_ref || null,
      photos: mine.map((p) => ({ id: p.id, url: p.url, file: p.original_filename, source: p.source })), missing };
  });
  return { batch_id: b.id, photo_match: { reference: b.photo_match && b.photo_match.reference, column: b.photo_match && b.photo_match.column },
    counts: await photoCounts(seller.id, b), rows };
}

/** Counts for the review summary: matched (staged), unmatched/ambiguous/duplicate (uploads), missing (named, not found). */
async function photoCounts(sellerId, b) {
  const matched = (await db.query("SELECT count(*)::int AS n FROM storefront_import_photos WHERE batch_id = $1 AND seller_id = $2 AND status IN ('staged','attached')", [b.id, sellerId])).rows[0].n;
  const stats = (b.photo_match && b.photo_match.stats) || {};
  const staged = (await db.query('SELECT row_number, lower(original_filename) AS f, source_url FROM storefront_import_photos WHERE batch_id = $1', [b.id])).rows;
  const haveFile = new Set(staged.map((s) => s.row_number + ':' + s.f));
  const haveUrl = new Set(staged.map((s) => s.source_url).filter(Boolean));
  let missing = 0;
  for (const r of (b.rows || [])) {
    if (!importable(r)) continue;
    for (const p of (r.values && r.values.photo_refs) || []) {
      if (p.type === 'file' && !haveFile.has(r.row + ':' + p.value.toLowerCase())) missing++;
      if (p.type === 'url' && !haveUrl.has(p.value)) missing++;
    }
  }
  return { matched, unmatched: (stats.unmatched || 0) + (stats.rejected || 0), ambiguous: stats.ambiguous || 0, duplicate: stats.duplicate || 0, missing };
}

/** Move a staged photo to another row and/or position (position 0 = the primary photo). */
async function updatePhoto(actor, batchId, photoId, { row, position }) {
  const { seller, b } = await ownOpenBatch(actor, batchId);
  const idx = indexes(b);
  return withTransaction(async (client) => {
    const p = (await client.query('SELECT * FROM storefront_import_photos WHERE id = $1 AND batch_id = $2 AND seller_id = $3 FOR UPDATE', [photoId, b.id, seller.id])).rows[0];
    if (!p || p.status !== 'staged') throw err(404, 'NOT_FOUND', 'Photo not found.');
    const targetRow = row != null ? Number(row) : p.row_number;
    if (!idx.rows.has(targetRow)) throw err(422, 'ROW_INVALID', 'Choose a spreadsheet row that will be imported.');
    // Re-number the target row's photos so the new position is exact.
    const rowPhotos = (await client.query("SELECT id FROM storefront_import_photos WHERE batch_id = $1 AND row_number = $2 AND status = 'staged' AND id <> $3 ORDER BY position, created_at", [b.id, targetRow, p.id])).rows.map((r) => r.id);
    if (rowPhotos.length >= MAX_PER_ROW) throw err(409, 'ROW_FULL', `Row ${targetRow} already has ${MAX_PER_ROW} photos.`);
    const at = Math.max(0, Math.min(rowPhotos.length, position != null ? Number(position) || 0 : rowPhotos.length));
    rowPhotos.splice(at, 0, p.id);
    for (let i = 0; i < rowPhotos.length; i++) {
      await client.query('UPDATE storefront_import_photos SET row_number = $2, position = $3, updated_at = now() WHERE id = $1', [rowPhotos[i], targetRow, i]);
    }
    return { id: p.id, row: targetRow, position: at };
  });
}

/** Remove a staged photo (and its stored copy). */
async function removePhoto(actor, batchId, photoId) {
  const { seller, b } = await ownOpenBatch(actor, batchId);
  const p = (await db.query("UPDATE storefront_import_photos SET status = 'discarded', updated_at = now() WHERE id = $1 AND batch_id = $2 AND seller_id = $3 AND status = 'staged' RETURNING public_id", [photoId, b.id, seller.id])).rows[0];
  if (!p) throw err(404, 'NOT_FOUND', 'Photo not found.');
  cleanup({ public_id: p.public_id });
  await db.query("DELETE FROM storefront_import_photos WHERE id = $1 AND status = 'discarded'", [photoId]);
  return { removed: true };
}

/** Discard every staged photo of these batches (a replaced or cancelled preview). Internal. */
async function discardBatches(sellerId, batchIds) {
  if (!batchIds || !batchIds.length) return;
  const { rows } = await db.query("DELETE FROM storefront_import_photos WHERE seller_id = $1 AND batch_id = ANY($2::uuid[]) AND status = 'staged' RETURNING public_id", [sellerId, batchIds]);
  for (const r of rows) cleanup({ public_id: r.public_id });
}

/**
 * Attach a row's staged photos to the draft created (or updated) from it, in order. Idempotent: a photo already on the
 * item is never added twice (same checksum), so a retried import is harmless. Returns { attached }.
 */
async function attachRowPhotos(seller, actor, batchId, rowNumber, itemId) {
  const staged = (await db.query(
    `SELECT * FROM storefront_import_photos WHERE batch_id = $1 AND seller_id = $2 AND row_number = $3 AND status = 'staged' ORDER BY position, created_at`,
    [batchId, seller.id, rowNumber])).rows;
  if (!staged.length) return { attached: 0 };
  return withTransaction(async (client) => {
    const urls = [];
    for (const p of staged) {
      const ins = await client.query(
        `INSERT INTO storefront_item_photos (item_id, seller_id, uploaded_by, url, public_id, sha256, original_filename, bytes, width, height, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (item_id, sha256) DO NOTHING RETURNING id`,
        [itemId, seller.id, actorUserId(actor), p.url, p.public_id, p.sha256, p.original_filename, p.bytes, p.width, p.height, p.source === 'url' ? 'url' : p.source]);
      if (ins.rows.length) urls.push(p.url);
    }
    let attached = 0;
    if (urls.length) attached = (await items.appendPhotos(itemId, seller.id, urls, client)).added;
    await client.query("UPDATE storefront_import_photos SET status = 'attached', item_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])", [staged.map((p) => p.id), itemId]);
    return { attached };
  });
}

module.exports = { uploadToBatch, fetchLinks, listPhotos, photoCounts, updatePhoto, removePhoto, discardBatches, attachRowPhotos, matchToRow, indexes, LINKS_PER_CALL };
