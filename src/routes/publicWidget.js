'use strict';

/**
 * /api/public/widget — PUBLIC, CORS-open feed for the white-label company auction widget. Keyed by an
 * opaque server-issued token that resolves to exactly ONE organization; returns only that company's
 * PUBLIC, eligible auctions (never config, never private data, never another tenant's auctions). An
 * unknown/invalid key returns an empty result (never a 404), so keys can't be probed for existence.
 */

const express = require('express');
const router = express.Router();
const widget = require('../services/widgetService');
const { asyncRoute } = require('../utils/apiError');

// GET /api/public/widget/auctions?key=wgt_... — the embedded company's public auctions.
router.get('/auctions', asyncRoute(async (req, res) => {
  const org = await widget.resolveKeyToOrg(String(req.query.key || ''));
  if (!org) { res.set('Cache-Control', 'public, max-age=30'); return res.json({ success: true, company: null, current: [], upcoming: [], total: 0 }); }
  const a = await widget.listPublicAuctions(org.linked_seller_profile_id);
  res.set('Cache-Control', 'public, max-age=60');
  return res.json({ success: true, company: { name: org.name }, current: a.current, upcoming: a.upcoming, total: a.current.length + a.upcoming.length });
}));

module.exports = router;
