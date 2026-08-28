'use strict';

/**
 * /api/seller-storefront — Professional Seller storefront management + Marketplace inventory +
 * auction→marketplace conversion. Authenticated seller only; ownership is ALWAYS derived server-side
 * from req.user.id (never a client-supplied seller id).
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const db = require('../db');
const storefront = require('../services/storefrontService');
const items = require('../services/marketplaceItemService');
const { asyncRoute } = require('../utils/apiError');

router.use(auth);
const fail = (res, e, next) => { if (e.status) return res.status(e.status).json({ success: false, code: e.code, message: e.message }); next(e); };

// ── Storefront config ──────────────────────────────────────────────────────────
router.get('/config', asyncRoute(async (req, res) => res.json({ success: true, data: await storefront.getOwnerConfig(req.user.id) })));
router.put('/config', async (req, res, next) => {
  try { return res.json({ success: true, data: await storefront.updateConfig(req.user.id, req.body || {}) }); }
  catch (e) { fail(res, e, next); }
});

// ── Marketplace inventory (direct listings) ────────────────────────────────────
router.get('/items', asyncRoute(async (req, res) => {
  const s = await items.sellerForUser(req.user.id);
  if (!s) return res.json({ success: true, data: [] });
  return res.json({ success: true, data: await items.listForSeller(s.id) });
}));
router.post('/items', async (req, res, next) => {
  try { return res.status(201).json({ success: true, data: await items.createDirectListing(req.user.id, req.body || {}) }); }
  catch (e) { fail(res, e, next); }
});
router.patch('/items/:id', async (req, res, next) => {
  try { return res.json({ success: true, data: await items.updateItem(req.params.id, req.user.id, req.body || {}) }); }
  catch (e) { fail(res, e, next); }
});

// ── Unsold Inventory Center: eligible unsold lots + one-button conversion ───────
router.get('/unsold-lots', asyncRoute(async (req, res) => {
  const s = await items.sellerForUser(req.user.id);
  if (!s) return res.json({ success: true, data: [] });
  return res.json({ success: true, data: await items.listUnsoldEligible(s.id) });
}));
router.post('/unsold-lots/:lotId/convert', async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await items.convertLotToListing(req.params.lotId, req.user.id, { priceCents: b.price_cents, edits: b.edits });
    return res.status(r.created ? 201 : 200).json({ success: true, created: r.created, data: r.item });
  } catch (e) { fail(res, e, next); }
});
// Bulk convert (explicit list of lot ids; each idempotent + independently guarded).
router.post('/unsold-lots/convert-batch', async (req, res, next) => {
  try {
    const ids = Array.isArray((req.body || {}).lot_ids) ? req.body.lot_ids.slice(0, 100) : [];
    const out = { converted: 0, skipped: 0, errors: [] };
    for (const id of ids) {
      try { const r = await items.convertLotToListing(id, req.user.id, {}); if (r.created) out.converted++; else out.skipped++; }
      catch (e) { out.errors.push({ lot_id: id, code: e.code || 'ERR' }); }
    }
    return res.json({ success: true, data: out });
  } catch (e) { fail(res, e, next); }
});

// ── Seller inquiry inbox (own inquiries only) ──────────────────────────────────
router.get('/inquiries', asyncRoute(async (req, res) => {
  const s = await items.sellerForUser(req.user.id);
  if (!s) return res.json({ success: true, data: [] });
  const { rows } = await db.query(
    'SELECT id, name, email, phone, city, service, preferred_contact, message, status, seller_notes, created_at FROM seller_inquiries WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 200', [s.id]);
  return res.json({ success: true, data: rows });
}));
router.patch('/inquiries/:id', asyncRoute(async (req, res) => {
  const s = await items.sellerForUser(req.user.id);
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
