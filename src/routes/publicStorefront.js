'use strict';

/**
 * /api/public/storefront — PUBLIC, read-only storefront data + item detail + consultation inquiry submit.
 * Exposes only published storefront data; never private seller/customer/follower data. Inquiries are
 * rate-limited and sanitized; the submitter's PII is stored only for the owning seller's inbox.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const storefront = require('../services/storefrontService');
const items = require('../services/marketplaceItemService');
// The signed-in member viewing an item page, for the seller-allowed realized sale price (§12.3) only. Stricter than
// the shared optional sign-in middleware: a member is recognised ONLY when the server confirms the session is current (state 'ok');
// a missing, invalid, expired, revoked, suspended or unverifiable session, or any error, is the public view. Read-only:
// never rejects, renews or sets a cookie, and never attaches a user to the request; this router trusts no user for anything else.
async function confirmedViewerId(req) {
  try {
    const { resolveSession, identityFrom } = require('../lib/sessionAuth');
    const resolved = resolveSession(req);
    const identity = identityFrom(resolved.decoded);
    if (!identity) return null;
    const check = await require('../lib/sessionTokens').checkSession(resolved.decoded, resolved.token);
    return check && check.state === 'ok' ? identity.id : null;
  } catch (_) { return null; }
}

const clean = (v, n) => storefront.clean(v, n);

// Item detail (declared before /:slug so "item" is not captured as a slug).
// Signed-in members may see a sold item's realized price when the seller allows it; a member's answer is never cached.
router.get('/item/:id', async (req, res, next) => {
  try {
    // A malformed id is simply not an item (never a server error).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.id || ''))) return res.status(404).json({ success: false, message: 'Item not found.' });
    const viewerUserId = await confirmedViewerId(req);
    const it = await items.getPublicItem(req.params.id, undefined, { viewerUserId });
    if (!it) return res.status(404).json({ success: false, message: 'Item not found.' });
    res.set('Vary', 'Authorization, Cookie');
    if (viewerUserId || it.realized_price_cents != null) res.set('Cache-Control', 'private, no-store');
    // A priced (unsold) item is revalidated on every request so a cached copy never outlives a sale (§12.3).
    else if (it.price_cents != null) res.set('Cache-Control', 'no-cache');
    return res.json({ success: true, data: it });
  } catch (e) { next(e); }
});

// Website widget data for ONE seller (by the seller's stable id; declared before /:slug). Public inventory only, the
// same for every visitor (no session is read). Revalidated on every request so a sold item drops out at once.
router.get('/widget/:sellerId', async (req, res, next) => {
  // Only a seller id selects a widget; anything else (e.g. /widget/policies for a storefront whose slug is "widget")
  // continues to the storefront routes below.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.sellerId || ''))) return next();
  try {
    const feed = await require('../services/storefrontWidgetService').publicFeed(req.params.sellerId);
    res.set('Cache-Control', 'no-cache');
    if (!feed) return res.status(404).json({ success: false, code: 'WIDGET_NOT_AVAILABLE', message: 'This shop is not available right now.' });
    return res.json({ success: true, data: feed });
  } catch (e) { next(e); }
});

// One item for the website widget's in-frame product view (same rules as the widget list: this seller's available items
// only). Public, the same for everyone; no session read.
router.get('/widget/:sellerId/item/:itemId', async (req, res, next) => {
  const U = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!U.test(String(req.params.sellerId || '')) || !U.test(String(req.params.itemId || ''))) return res.status(404).json({ success: false, code: 'ITEM_NOT_AVAILABLE', message: 'This item is no longer available.' });
  try {
    const it = await require('../services/storefrontWidgetService').widgetItem(req.params.sellerId, req.params.itemId.toLowerCase());
    res.set('Cache-Control', 'no-cache');
    if (!it) return res.status(404).json({ success: false, code: 'ITEM_NOT_AVAILABLE', message: 'This item is no longer available.' });
    return res.json({ success: true, data: it });
  } catch (e) { next(e); }
});

// Storefront data by slug.
router.get('/:slug', async (req, res, next) => {
  // Lists priced active items, any of which can sell at any moment: revalidated on every request (§12.3).
  try { const data = await storefront.getPublicData(req.params.slug); res.set('Cache-Control', 'no-cache'); return res.json({ success: true, data }); }
  catch (e) { if (e.status === 404) return res.status(404).json({ success: false, message: e.message }); next(e); }
});

// The storefront's published Store Terms and Shipping & Pickup Policy (the seller's own words; plain text).
router.get('/:slug/policies', async (req, res, next) => {
  try {
    const sp = await storefront.resolveBySlug(req.params.slug);
    if (!storefront.isPublicStorefront(sp)) return res.status(404).json({ success: false, message: 'Storefront not found.' });
    return res.json({ success: true, data: await require('../services/sellerPolicyService').publishedFor(sp.id) });
  } catch (e) { next(e); }
});

const inquiries = require('../services/sellerInquiryService');
function inquiryRefused(res, e, next) {
  if (e && e.status) return res.status(e.status).json({ success: false, message: e.message });
  return next(e);
}

// A question about one item, from its page (owner 2026-11-10): works whether or not the seller's storefront page is
// published. The seller and the item come from the item id only; the item must be public. Same limits and inbox as the
// storefront form; the seller is emailed that a message is waiting.
router.post('/item/:id/inquiry', express.json(), async (req, res, next) => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.id || ''))) return res.status(404).json({ success: false, message: 'Item not found.' });
    const it = await items.getPublicItem(req.params.id);
    if (!it) return res.status(404).json({ success: false, message: 'Item not found.' });
    const sp = (await db.query('SELECT sp.* FROM seller_profiles sp JOIN marketplace_items mi ON mi.seller_id = sp.id WHERE mi.id = $1', [req.params.id])).rows[0];
    if (!sp) return res.status(404).json({ success: false, message: 'Item not found.' });
    const item = { id: it.id, title: it.title };
    const r = await inquiries.record(req, { seller: sp, item, clean });
    res.status(201).json({ success: true, message: 'Your question was sent. The seller will reply to you directly.' });
    if (!r.dropped) inquiries.notifySeller({ seller: sp, item, name: r.name, message: r.message }).catch(() => {});
  } catch (e) { inquiryRefused(res, e, next); }
});

// Consultation / contact inquiry submit from the storefront page (rate-limited, sanitized).
router.post('/:slug/inquiry', express.json(), async (req, res, next) => {
  try {
    const sp = await storefront.resolveBySlug(req.params.slug);
    if (!storefront.isPublicStorefront(sp)) return res.status(404).json({ success: false, message: 'Storefront not found.' });
    const r = await inquiries.record(req, { seller: sp, item: null, clean });
    res.status(201).json({ success: true, message: 'Your message was sent. The company will contact you directly.' });
    if (!r.dropped) inquiries.notifySeller({ seller: sp, item: null, name: r.name, message: r.message }).catch(() => {});
  } catch (e) { inquiryRefused(res, e, next); }
});

module.exports = router;
