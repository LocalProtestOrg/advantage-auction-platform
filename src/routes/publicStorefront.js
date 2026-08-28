'use strict';

/**
 * /api/public/storefront — PUBLIC, read-only storefront data + item detail + consultation inquiry submit.
 * Exposes only published storefront data; never private seller/customer/follower data. Inquiries are
 * rate-limited and sanitized; the submitter's PII is stored only for the owning seller's inbox.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const storefront = require('../services/storefrontService');
const items = require('../services/marketplaceItemService');

const clean = (v, n) => storefront.clean(v, n);
function ipHash(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  return crypto.createHash('sha256').update('sf:' + ip).digest('hex').slice(0, 32);
}

// Item detail (declared before /:slug so "item" is not captured as a slug).
router.get('/item/:id', async (req, res, next) => {
  try {
    const it = await items.getPublicItem(req.params.id);
    if (!it) return res.status(404).json({ success: false, message: 'Item not found.' });
    return res.json({ success: true, data: it });
  } catch (e) { next(e); }
});

// Storefront data by slug.
router.get('/:slug', async (req, res, next) => {
  try { return res.json({ success: true, data: await storefront.getPublicData(req.params.slug) }); }
  catch (e) { if (e.status === 404) return res.status(404).json({ success: false, message: e.message }); next(e); }
});

// Consultation / contact inquiry submit (rate-limited, sanitized).
router.post('/:slug/inquiry', express.json(), async (req, res, next) => {
  try {
    const sp = await storefront.resolveBySlug(req.params.slug);
    if (!sp || !sp.storefront_published) return res.status(404).json({ success: false, message: 'Storefront not found.' });
    const b = req.body || {};
    const name = clean(b.name, 120); const email = clean(b.email, 160); const phone = clean(b.phone, 40);
    const message = clean(b.message, 2000);
    if (!name || (!email && !phone)) return res.status(400).json({ success: false, message: 'Name and a phone or email are required.' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ success: false, message: 'Please enter a valid email.' });
    const iph = ipHash(req);
    // Rate limit: max 5 inquiries per IP-hash per hour, max 3 to the same seller per day.
    const recent = (await db.query("SELECT count(*)::int n FROM seller_inquiries WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'", [iph])).rows[0].n;
    if (recent >= 5) return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
    const perSeller = (await db.query("SELECT count(*)::int n FROM seller_inquiries WHERE ip_hash = $1 AND seller_id = $2 AND created_at > now() - interval '1 day'", [iph, sp.id])).rows[0].n;
    if (perSeller >= 3) return res.status(429).json({ success: false, message: 'You have already contacted this company recently.' });
    await db.query(
      `INSERT INTO seller_inquiries (seller_id, name, email, phone, city, service, preferred_contact, message, source_slug, ip_hash, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [sp.id, name, email, phone, clean(b.city, 120), clean(b.service, 120), clean(b.preferred_contact, 40), message, sp.storefront_slug, iph, !!sp.is_demo]);
    return res.status(201).json({ success: true, message: 'Your request was sent. The company will contact you directly.' });
  } catch (e) { next(e); }
});

module.exports = router;
