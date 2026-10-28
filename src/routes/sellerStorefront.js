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
const fail = (res, e, next) => { if (e.status) return res.status(e.status).json({ success: false, code: e.code, message: e.message, missing: e.missing || undefined }); next(e); };

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

router.get('/imports/template.csv', sellerRead('company.inventory.view'), (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="advantage-bid-inventory-template.csv"').send(imports.templateCsv());
});
router.get('/imports', seller('company.inventory.view'), send((req) => imports.listBatches(req.sellerCtx)));
router.post('/imports/preview', seller('company.inventory.edit'), uploadLimiter, withUpload(sheetUpload), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, code: 'NO_FILE', message: 'Choose a CSV or Excel (.xlsx) file to upload.' });
    let mapping = null;
    if (req.body && req.body.mapping) {
      try { mapping = JSON.parse(String(req.body.mapping)); } catch (_) { return res.status(422).json({ success: false, code: 'MAPPING_INVALID', message: 'The column choices could not be read.' }); }
    }
    return res.json({ success: true, data: await imports.preview(req.sellerCtx, { buffer: req.file.buffer, filename: req.file.originalname, mapping }) });
  } catch (e) { fail(res, e, next); }
});
router.get('/imports/:id', seller('company.inventory.view'), send((req) => imports.getBatch(req.sellerCtx, req.params.id)));
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
      const c = String(b.value == null ? '' : b.value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
      if (!c || c.length > 100) return res.status(422).json({ success: false, code: 'CATEGORY_INVALID', message: 'Enter a category of up to 100 characters.' });
      patch = { category: c };
    }
    if (!patch) return res.status(422).json({ success: false, code: 'ACTION_INVALID', message: 'Choose publish, pause, unpublish, remove or set category.' });
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
    const r = await items.convertLotToListing(req.params.lotId, req.sellerCtx, { priceCents: b.price_cents, edits: b.edits });
    return res.status(r.created ? 201 : 200).json({ success: true, created: r.created, data: shape(req, r.item),
      needs_pickup_location: r.needs_pickup_location || undefined });
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
    'SELECT id, name, email, phone, city, service, preferred_contact, message, status, seller_notes, created_at FROM seller_inquiries WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 200', [s.id]);
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
