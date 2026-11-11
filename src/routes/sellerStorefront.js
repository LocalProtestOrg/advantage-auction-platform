'use strict';

/**
 * /api/seller-storefront — Professional Seller storefront management + Marketplace inventory +
 * auction→marketplace conversion. Authenticated seller only; the company is ALWAYS derived server-side from the
 * session by the seller checkpoint (owner, or an active staff member with the needed role) — never a client-supplied id.
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const db = require('../db');
const storefront = require('../services/storefrontService');
const items = require('../services/marketplaceItemService');
const { asyncRoute } = require('../utils/apiError');
// Changes pass through the seller checkpoint (seller company resolved from the session). Reads keep their existing
// "no seller profile → empty list" behaviour for pages shown to every member.
const seller = require('../middleware/requireSellerPermission');
const { optionalSellerPermission: sellerRead } = require('../middleware/requireSellerPermission');

router.use(auth);
// Staff never receive the private pickup street address (or internal ids) in any item response.
const shape = (req, row) => (req.sellerCtx && req.sellerCtx.staff ? items.staffItemView(row) : row);
const fail = (res, e, next) => { if (e.status) return res.status(e.status).json({ success: false, code: e.code, message: e.message, missing: e.missing || undefined, agreement_id: e.agreement_id || undefined }); next(e); };

// ── Storefront config ──────────────────────────────────────────────────────────
router.get('/config', sellerRead('company.inventory.view'), asyncRoute(async (req, res) => {
  const ctx = req.sellerCtx;
  // Staff see only what their inventory work needs: the company name, whether a default pickup location is confirmed, and
  // its city/state. Storefront settings, the full private address and inquiries stay with the owner.
  if (ctx && ctx.staff) return res.json({ success: true, data: await storefront.getStaffConfig(ctx) });
  return res.json({ success: true, data: await storefront.getOwnerConfig(req.user.id) });
}));
router.put('/config', seller('company.storefront.manage'), async (req, res, next) => {
  try { return res.json({ success: true, data: await storefront.updateConfig(req.user.id, req.body || {}) }); }
  catch (e) { fail(res, e, next); }
});

// ── Store Terms & Conditions and Shipping & Pickup Policy (owner; migration 203). The seller's own words: each kind is
// saved as a draft, previewed and published independently; published versions are never rewritten.
const policies = require('../services/sellerPolicyService');
router.get('/policies', seller('company.storefront.manage'), async (req, res, next) => {
  try { return res.json({ success: true, data: await policies.forOwner(req.sellerCtx) }); } catch (e) { fail(res, e, next); }
});
router.put('/policies/:kind', seller('company.storefront.manage'), async (req, res, next) => {
  try { return res.json({ success: true, data: await policies.saveDraft(req.sellerCtx, req.params.kind, (req.body || {}).body) }); } catch (e) { fail(res, e, next); }
});
router.post('/policies/:kind/publish', seller('company.storefront.manage'), async (req, res, next) => {
  try { return res.json({ success: true, data: await policies.publish(req.sellerCtx, req.params.kind) }); } catch (e) { fail(res, e, next); }
});

// ── My Website Widget (owner; roadmap §7.5): the seller's own embed code and storefront link. Automatic: every
// Professional Seller has one, tied to their seller id; nothing to request or create.
router.get('/widget', seller('company.storefront.manage'), async (req, res, next) => {
  try { return res.json({ success: true, data: await require('../services/storefrontWidgetService').forOwner(req.sellerCtx) }); } catch (e) { fail(res, e, next); }
});

// Store-wide shipping default for NEW items (owner). Saving it never changes an existing listing.
router.put('/shipping-defaults', seller('company.storefront.manage'), async (req, res, next) => {
  try { return res.json({ success: true, data: await storefront.setShippingDefaults(req.user.id, req.body || {}) }); }
  catch (e) { fail(res, e, next); }
});

// Default storefront pickup location — confirmed once; items use it automatically (PRIVATE, owner-only).
router.put('/pickup-location', seller('company.storefront.manage'), async (req, res, next) => {
  try { return res.json({ success: true, data: await storefront.setDefaultPickupLocation(req.user.id, req.body || {}) }); }
  catch (e) { fail(res, e, next); }
});

// ── Marketplace inventory (direct listings) ────────────────────────────────────
router.get('/items', sellerRead('company.inventory.view'), asyncRoute(async (req, res) => {
  const s = req.sellerCtx && await items.sellerForUser(req.sellerCtx);
  if (!s) return res.json({ success: true, data: [] });
  const list = await items.listForSeller(s.id, undefined, { streetAddress: !req.sellerCtx.staff, q: req.query.q || null });
  // Where each item can be seen right now (the same rules as the public pages and the website widget).
  const sp = ((await db.query('SELECT id, seller_type, is_demo, storefront_published, storefront FROM seller_profiles WHERE id = $1', [s.id])) || {}).rows?.[0] || null;
  const widgetSvc = require('../services/storefrontWidgetService');
  const storefrontOpen = storefront.isPublicStorefront(sp) && !widgetSvc.shopHidden(sp);
  if (!Array.isArray(list)) return res.json({ success: true, data: list });
  return res.json({ success: true, data: list.map((m) => {
    const onSite = m.status === 'active' && m.moderation_status !== 'taken_down';
    const photoCount = Array.isArray(m.images) ? m.images.length : 0;
    return { ...m, photo_count: photoCount, visibility: { advantage_bid: onSite, widget: onSite && storefrontOpen && (!!(sp && sp.is_demo) || !m.is_demo) } };
  }), storefront_open: storefrontOpen });
}));
// Smart Catalog Tools for a storefront item (owner request 2026-11-03): the SAME photo description service the auction lot
// builders use (aiDescriptionService.generateDescriptionFromImage; one service, no second tool). Suggestions only: the
// seller reviews and edits them in the form before saving a draft or publishing; nothing is saved here. Only the title,
// description and a category from the storefront taxonomy are returned (never a maker, age, provenance or value). When the
// service is unavailable the seller is told so (no sample text is ever substituted).
const smartLimiter = require('express-rate-limit')({ windowMs: 60 * 1000, max: 20, standardHeaders: false, legacyHeaders: false,
  keyGenerator: (req) => 'smart:' + ((req.user && req.user.id) || req.ip),
  handler: (req, res) => res.status(429).json({ success: false, code: 'TOO_MANY', message: 'Please wait a moment before asking for more suggestions.' }) });
router.post('/items/smart-catalog', seller('company.inventory.edit'), smartLimiter, express.json({ limit: '8kb' }), async (req, res, next) => {
  try {
    const imageUrl = String((req.body && req.body.image_url) || '');
    if (!/^https:\/\/[^\s]+$/i.test(imageUrl) || imageUrl.length > 1000) {
      return res.status(422).json({ success: false, code: 'PHOTO_REQUIRED', message: 'Add a photo of the item first.' });
    }
    const svc = require('../services/aiDescriptionService');
    let out;
    try { out = await svc.generateDescriptionFromImage(imageUrl); }
    catch (e) {
      if (e instanceof svc.AIUnavailableError) return res.status(503).json({ success: false, code: 'SMART_TOOLS_UNAVAILABLE', message: 'Smart Catalog Tools are temporarily unavailable. Please try again shortly, or write the details yourself.' });
      throw e;
    }
    const cats = require('../constants/lotCategories');
    const key = cats.normalizeToCategoryKey(out.category) || null;
    const cat = key ? cats.CATEGORIES.find((c) => c.key === key) : null;
    return res.json({ success: true, data: { title: String(out.title || '').slice(0, 200), description: String(out.description || '').slice(0, 4000),
      category_key: key, category_label: cat ? cat.label : null } });
  } catch (e) { fail(res, e, next); }
});

router.post('/items', seller('company.inventory.edit'), async (req, res, next) => {
  try { return res.status(201).json({ success: true, data: shape(req, await items.createDirectListing(req.sellerCtx, req.body || {})) }); }
  catch (e) { fail(res, e, next); }
});
router.patch('/items/:id', seller('company.inventory.edit'), async (req, res, next) => {
  try { return res.json({ success: true, data: shape(req, await items.updateItem(req.params.id, req.sellerCtx, req.body || {})) }); }
  catch (e) { fail(res, e, next); }
});

// ── Bulk import, photos and the inventory workspace (migration 207; /seller-inventory.html) ─────────────────────
// Upload limits are enforced while the request is read (multer), before any parsing: one spreadsheet ≤ 5 MB; up to
// 10 photos ≤ 10 MB each per request; one photo ZIP ≤ 60 MB. Files stay in memory only (never written to disk).
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const imports = require('../services/storefrontImportService');
const photos = require('../services/storefrontPhotoService');
const MB = 1024 * 1024;
const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * MB, files: 1, fields: 5, fieldSize: 64 * 1024 } }).single('file');
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: photos.MAX_PHOTO_BYTES, files: 10, fields: 2 } }).array('photos', 10);
const zipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * MB, files: 1, fields: 2 } }).single('zip');
const UPLOAD_ERRORS = {
  LIMIT_FILE_SIZE: [413, 'FILE_TOO_LARGE', 'That file is too large. Spreadsheets: 5 MB. Photos: 10 MB each. Photo ZIP files: 60 MB (split larger sets).'],
  LIMIT_FILE_COUNT: [413, 'TOO_MANY_FILES', 'Too many files at once. Upload up to 10 photos at a time (the page does this for you).'],
  LIMIT_UNEXPECTED_FILE: [400, 'UNEXPECTED_FILE', 'Unexpected file field.'],
};
const withUpload = (mw) => (req, res, next) => mw(req, res, (e) => {
  if (!e) return next();
  const m = UPLOAD_ERRORS[e.code] || [400, 'UPLOAD_FAILED', 'The upload could not be read. Please try again.'];
  return res.status(m[0]).json({ success: false, code: m[1], message: m[2] });
});
// Generous for real work (hundreds of photos in batches of 10), but bounded per signed-in person.
const uploadLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'u:' + ((req.user && req.user.id) || 'anon'), validate: { keyGeneratorIpFallback: false },
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many uploads in a short time. Please wait a few minutes and continue.' } });
const send = (fn, status = 200) => async (req, res, next) => { try { return res.status(status).json({ success: true, data: await fn(req) }); } catch (e) { fail(res, e, next); } };

// ── Storefront hero image and logo (owner): direct upload to the persistent image store, or remove. The logo is the
// seller's existing logo record (seller_profiles.logo_url); the hero is the storefront config's hero_image.
const branding = require('../services/storefrontBrandingService');
const brandingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: photos.MAX_PHOTO_BYTES, files: 1, fields: 2 } }).single('image');
router.post('/branding/:kind', seller('company.storefront.manage'), uploadLimiter, withUpload(brandingUpload),
  send((req) => branding.upload(req.sellerCtx, req.user.id, req.params.kind, req.file), 201));
router.delete('/branding/:kind', seller('company.storefront.manage'), send((req) => branding.remove(req.sellerCtx, req.user.id, req.params.kind)));

router.get('/imports/template.csv', sellerRead('company.inventory.view'), (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="advantage-bid-inventory-template.csv"').send(imports.templateCsv());
});
router.get('/imports', seller('company.inventory.view'), send((req) => imports.listBatches(req.sellerCtx)));
// Optional JSON form fields of a multipart request ("columns", "photo_match", "assign").
const jsonField = (req, name) => {
  const raw = req.body && req.body[name];
  if (raw == null || raw === '') return null;
  try { return JSON.parse(String(raw)); } catch (_) { const e = new Error('The choices could not be read. Please try again.'); e.status = 422; e.code = 'MAPPING_INVALID'; throw e; }
};
router.post('/imports/preview', seller('company.inventory.edit'), uploadLimiter, withUpload(sheetUpload), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, code: 'NO_FILE', message: 'Choose a CSV or Excel (.xlsx) file to upload.' });
    return res.json({ success: true, data: await imports.preview(req.sellerCtx, { buffer: req.file.buffer, filename: req.file.originalname,
      columns: jsonField(req, 'columns'), photoMatch: jsonField(req, 'photo_match'), duplicateMode: req.body && req.body.duplicate_mode }) });
  } catch (e) { fail(res, e, next); }
});
router.get('/imports/:id', seller('company.inventory.view'), send((req) => imports.getBatch(req.sellerCtx, req.params.id)));
router.get('/imports/:id/review', seller('company.inventory.view'), send((req) => imports.reviewSummary(req.sellerCtx, req.params.id)));
router.put('/imports/:id/options', seller('company.inventory.edit'), send((req) => imports.updateOptions(req.sellerCtx, req.params.id,
  { photoMatch: (req.body || {}).photo_match, duplicateMode: (req.body || {}).duplicate_mode })));

// Step 3, Add or Match Photos: photos staged for one import, matched to its rows (storefrontImportPhotoService).
const importPhotos = require('../services/storefrontImportPhotoService');
const importPhotoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: photos.MAX_PHOTO_BYTES, files: 10, fields: 3, fieldSize: 64 * 1024 } }).array('photos', 10);
router.get('/imports/:id/photos', seller('company.inventory.view'), send((req) => importPhotos.listPhotos(req.sellerCtx, req.params.id)));
router.post('/imports/:id/photos', seller('company.inventory.edit'), uploadLimiter, withUpload(importPhotoUpload), async (req, res, next) => {
  try { return res.json({ success: true, data: await importPhotos.uploadToBatch(req.sellerCtx, req.params.id, { files: fileList(req), assign: jsonField(req, 'assign') }) }); }
  catch (e) { fail(res, e, next); }
});
router.post('/imports/:id/photos/zip', seller('company.inventory.edit'), uploadLimiter, withUpload(zipUpload), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, code: 'NO_FILE', message: 'Choose a ZIP file of photos.' });
    return res.json({ success: true, data: await importPhotos.uploadToBatch(req.sellerCtx, req.params.id, { zipBuffer: req.file.buffer }) });
  } catch (e) { fail(res, e, next); }
});
router.post('/imports/:id/photos/fetch-links', seller('company.inventory.edit'), uploadLimiter, send((req) => importPhotos.fetchLinks(req.sellerCtx, req.params.id)));
router.patch('/imports/:id/photos/:photoId', seller('company.inventory.edit'), async (req, res, next) => {
  try {
    if (!UUID_RE.test(String(req.params.photoId))) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Photo not found.' });
    const b = req.body || {};
    return res.json({ success: true, data: await importPhotos.updatePhoto(req.sellerCtx, req.params.id, req.params.photoId, { row: b.row, position: b.position }) });
  } catch (e) { fail(res, e, next); }
});
router.delete('/imports/:id/photos/:photoId', seller('company.inventory.edit'), async (req, res, next) => {
  try {
    if (!UUID_RE.test(String(req.params.photoId))) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Photo not found.' });
    return res.json({ success: true, data: await importPhotos.removePhoto(req.sellerCtx, req.params.id, req.params.photoId) });
  } catch (e) { fail(res, e, next); }
});

// The ONE category taxonomy (src/constants/lotCategories.js), for the inventory editor and bulk corrections.
router.get('/categories', sellerRead('company.inventory.view'), (req, res) => {
  res.json({ success: true, data: require('../constants/lotCategories').CATEGORIES });
});

// What still stands between this company's inventory and being publicly purchasable (storefrontReadinessService).
router.get('/readiness', sellerRead('company.inventory.view'), asyncRoute(async (req, res) => {
  if (!req.sellerCtx) return res.json({ success: true, data: null });
  return res.json({ success: true, data: await require('../services/storefrontReadinessService').forSeller(req.sellerCtx) });
}));
router.get('/imports/:id/problems.csv', seller('company.inventory.view'), async (req, res, next) => {
  try { const r = await imports.errorReportCsv(req.sellerCtx, req.params.id); res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${r.filename}"`).send(r.csv); }
  catch (e) { fail(res, e, next); }
});
router.post('/imports/:id/import', seller('company.inventory.edit'), send((req) => imports.importNext(req.sellerCtx, req.params.id)));
router.post('/imports/:id/retry', seller('company.inventory.edit'), send((req) => imports.retryFailed(req.sellerCtx, req.params.id)));
router.post('/imports/:id/cancel', seller('company.inventory.edit'), send((req) => imports.cancel(req.sellerCtx, req.params.id)));

const fileList = (req) => (req.files || []).map((f) => ({ name: f.originalname, buffer: f.buffer }));
router.post('/photos', seller('company.inventory.edit'), uploadLimiter, withUpload(photoUpload), send((req) => photos.uploadMatched(req.sellerCtx, { files: fileList(req) })));
router.post('/photos/zip', seller('company.inventory.edit'), uploadLimiter, withUpload(zipUpload), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, code: 'NO_FILE', message: 'Choose a ZIP file of photos.' });
    return res.json({ success: true, data: await photos.uploadMatched(req.sellerCtx, { zipBuffer: req.file.buffer }) });
  } catch (e) { fail(res, e, next); }
});
router.post('/items/:id/photos', seller('company.inventory.edit'), uploadLimiter, withUpload(photoUpload), send((req) => photos.uploadToItem(req.sellerCtx, req.params.id, fileList(req))));
router.put('/items/:id/photos', seller('company.inventory.edit'), async (req, res, next) => {
  try { return res.json({ success: true, data: shape(req, await items.setItemPhotos(req.params.id, req.sellerCtx, (req.body || {}).images)) }); }
  catch (e) { fail(res, e, next); }
});

// Bulk actions on the seller's own items. Each item goes through the same checks as a single edit (ownership, sold /
// in-checkout / taken-down protection, pickup location before publishing); one item's refusal never blocks the rest.
const BULK_ACTIONS = { publish: { status: 'active' }, pause: { status: 'paused' }, unpublish: { status: 'draft' }, remove: { status: 'removed' } };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.post('/items/bulk', seller('company.inventory.edit'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((x) => typeof x === 'string' && UUID_RE.test(x)))] : [];
    if (!ids.length || ids.length > 500) return res.status(422).json({ success: false, code: 'IDS_INVALID', message: 'Choose between 1 and 500 items.' });
    let patch = BULK_ACTIONS[b.action];
    if (b.action === 'set_category') {
      // A taxonomy category (the seller's own choice: final, never overwritten by automatic processing).
      const key = String(b.value == null ? '' : b.value).trim();
      if (!require('../constants/lotCategories').VALID_KEYS.has(key)) return res.status(422).json({ success: false, code: 'CATEGORY_INVALID', message: 'Choose one of the listed categories.' });
      patch = { category_key: key };
    } else if (b.action === 'set_price') {
      const cents = parseInt(b.value, 10);
      if (!(cents > 0) || cents > 100000000) return res.status(422).json({ success: false, code: 'PRICE_INVALID', message: 'Enter a Sale Price above zero (up to $1,000,000).' });
      patch = { price_cents: cents };
    } else if (b.action === 'set_quantity') {
      const q = Number(b.value);
      if (!Number.isInteger(q) || q < 0 || q > 100000) return res.status(422).json({ success: false, code: 'QUANTITY_INVALID', message: 'Enter a whole-number quantity from 0 to 100,000.' });
      patch = { quantity: q };
    }
    if (!patch) return res.status(422).json({ success: false, code: 'ACTION_INVALID', message: 'Choose publish, pause, unpublish, remove, set category, set price or set quantity.' });
    // Publishing needs the storefront agreement: one answer for the whole selection (no item changes).
    // A selection with a draft or removed item publishes a NEW listing, which also needs the current Seller Agreement
    // version (owner 2026-11-07); re-publishing paused items alone does not.
    if (b.action === 'publish') {
      const fresh = (await db.query(`SELECT 1 FROM marketplace_items WHERE id = ANY($1::uuid[]) AND seller_id = $2 AND status IN ('draft','removed') LIMIT 1`,
        [ids.filter((x) => /^[0-9a-f-]{36}$/i.test(String(x))), req.sellerCtx.sellerId])).rows.length > 0;
      await items.assertStorefrontAgreement(req.sellerCtx.sellerId, { newListing: fresh });
    }
    const results = [];
    for (const id of ids) {
      try { await items.updateItem(id, req.sellerCtx, { ...patch }); results.push({ id, ok: true }); }
      catch (e) {
        if (!(e && e.status && e.status < 500)) throw e;
        // Another company's item is reported exactly like a missing one (no hint that it exists).
        results.push(e.code === 'NOT_OWNER' || e.code === 'NOT_FOUND' ? { id, ok: false, code: 'NOT_FOUND', message: 'Listing not found.' } : { id, ok: false, code: e.code, message: e.message });
      }
    }
    return res.json({ success: true, data: { done: results.filter((r) => r.ok).length, refused: results.filter((r) => !r.ok).length, results } });
  } catch (e) { fail(res, e, next); }
});

// ── Unsold Inventory Center: eligible unsold lots + one-button conversion ───────
router.get('/unsold-lots', sellerRead('company.inventory.view'), asyncRoute(async (req, res) => {
  const s = req.sellerCtx && await items.sellerForUser(req.sellerCtx);
  if (!s) return res.json({ success: true, data: [] });
  return res.json({ success: true, data: await items.listUnsoldEligible(s.id) });
}));
router.post('/unsold-lots/:lotId/convert', seller('company.inventory.edit'), async (req, res, next) => {
  try {
    const b = req.body || {};
    // Post to the Market: a draft; the Sale Price is only what the seller sets (never an auction price).
    const r = await items.convertLotToListing(req.params.lotId, req.sellerCtx, { priceCents: b.price_cents, inventoryNumber: b.inventory_number, edits: b.edits });
    return res.status(r.created ? 201 : 200).json({ success: true, created: r.created, data: shape(req, r.item),
      needs_pickup_location: r.needs_pickup_location || undefined, needs_price: r.needs_price || undefined });
  } catch (e) { fail(res, e, next); }
});
// Bulk convert (explicit list of lot ids; each idempotent + independently guarded).
router.post('/unsold-lots/convert-batch', seller('company.inventory.edit'), async (req, res, next) => {
  try {
    const ids = Array.isArray((req.body || {}).lot_ids) ? req.body.lot_ids.slice(0, 100) : [];
    const out = { converted: 0, skipped: 0, errors: [] };
    for (const id of ids) {
      try { const r = await items.convertLotToListing(id, req.sellerCtx, {}); if (r.created) out.converted++; else out.skipped++; }
      catch (e) { out.errors.push({ lot_id: id, code: e.code || 'ERR' }); }
    }
    return res.json({ success: true, data: out });
  } catch (e) { fail(res, e, next); }
});

// ── Seller inquiry inbox (own inquiries only) ──────────────────────────────────
router.get('/inquiries', sellerRead('company.storefront.manage'), asyncRoute(async (req, res) => {
  const s = req.sellerCtx && await items.sellerForUser(req.sellerCtx);
  if (!s) return res.json({ success: true, data: [] });
  const { rows } = await db.query(
    `SELECT q.id, q.name, q.email, q.phone, q.city, q.service, q.preferred_contact, q.message, q.status, q.seller_notes, q.created_at,
            q.marketplace_item_id AS item_id, mi.title AS item_title
       FROM seller_inquiries q LEFT JOIN marketplace_items mi ON mi.id = q.marketplace_item_id AND mi.seller_id = q.seller_id
      WHERE q.seller_id = $1 ORDER BY q.created_at DESC LIMIT 200`, [s.id]);
  return res.json({ success: true, data: rows });
}));
router.patch('/inquiries/:id', seller('company.storefront.manage'), asyncRoute(async (req, res) => {
  const s = await items.sellerForUser(req.sellerCtx);
  if (!s) return res.status(403).json({ success: false, message: 'No seller profile.' });
  const b = req.body || {};
  const status = ['new', 'contacted', 'closed'].includes(b.status) ? b.status : null;
  const { rows } = await db.query(
    `UPDATE seller_inquiries SET status = COALESCE($3, status), seller_notes = COALESCE($4, seller_notes), updated_at = now()
      WHERE id = $1 AND seller_id = $2 RETURNING id, status, seller_notes`,
    [req.params.id, s.id, status, b.seller_notes != null ? String(b.seller_notes).slice(0, 2000) : null]);
  if (!rows.length) return res.status(404).json({ success: false, message: 'Inquiry not found.' });
  return res.json({ success: true, data: rows[0] });
}));

module.exports = router;
