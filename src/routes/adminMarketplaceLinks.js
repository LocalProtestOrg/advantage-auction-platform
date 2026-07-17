'use strict';

/**
 * /api/admin/marketplace-links — admin-only company(directory listing) <-> seller linking
 * for Marketplace Phase 2. Admin confirmation is the source of truth; the suggestion engine
 * is advisory only. Every link/unlink is audited (companySellerLink -> audit_log).
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const { asyncRoute } = require('../utils/apiError');
const db = require('../db');
const match = require('../services/marketplace/companySellerMatch');
const link = require('../services/marketplace/companySellerLink');

router.use(authMiddleware, roleMiddleware(['admin']));

// GET /organizations — marketplace listings with their current link + live-auction status.
router.get('/organizations', asyncRoute(async (req, res) => {
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.city, o.state, o.website_url,
            o.bd_metadata->>'profession_id' AS profession_id,
            o.linked_seller_profile_id, o.linked_seller_at, o.linked_seller_meta,
            sp.display_name AS linked_seller_name,
            (o.linked_seller_profile_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM auctions a
                WHERE a.seller_id = o.linked_seller_profile_id
                  AND a.state IN ('published','active') AND a.is_archived IS NOT TRUE
                  AND a.marketplace_status = 'syndicated')) AS has_live_auctions
       FROM organizations o
       LEFT JOIN seller_profiles sp ON sp.id = o.linked_seller_profile_id
      WHERE o.source = 'bd_import'
      ORDER BY (o.linked_seller_profile_id IS NOT NULL) DESC, o.name ASC`);
  res.json({ success: true, data: rows });
}));

// GET /suggestions?orgId= — advisory match suggestions (never auto-applied in Phase 2).
router.get('/suggestions', asyncRoute(async (req, res) => {
  const out = await match.suggestLinks({ orgId: req.query.orgId || undefined });
  res.json({ success: true, ...out });
}));

// GET /sellers?q= — seller lookup for the admin to pick a link target.
router.get('/sellers', asyncRoute(async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = [];
  let where = '';
  if (q) { params.push('%' + q + '%'); where = `WHERE sp.display_name ILIKE $${params.length}`; }
  const { rows } = await db.query(
    `SELECT sp.id, sp.display_name, u.email,
            (SELECT count(*)::int FROM auctions a WHERE a.seller_id = sp.id) AS auction_count
       FROM seller_profiles sp JOIN users u ON u.id = sp.user_id
       ${where}
      ORDER BY sp.display_name NULLS LAST LIMIT 50`, params);
  res.json({ success: true, data: rows });
}));

// POST /organizations/:orgId/link { sellerProfileId } — admin-confirmed link.
router.post('/organizations/:orgId/link', asyncRoute(async (req, res) => {
  const { sellerProfileId, rule, confidence, evidence } = req.body || {};
  try {
    const result = await link.linkSeller({
      orgId: req.params.orgId, sellerProfileId, actorId: req.user.id,
      rule: rule || 'admin_confirmed', confidence: confidence || 'confirmed', evidence: evidence || null,
    });
    res.json({ success: true, data: result });
  } catch (e) {
    if (e instanceof link.LinkError) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    throw e;
  }
}));

// POST /organizations/:orgId/unlink — remove the link.
router.post('/organizations/:orgId/unlink', asyncRoute(async (req, res) => {
  try {
    const result = await link.unlinkSeller({ orgId: req.params.orgId, actorId: req.user.id, reason: (req.body || {}).reason || null });
    res.json({ success: true, data: result });
  } catch (e) {
    if (e instanceof link.LinkError) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    throw e;
  }
}));

module.exports = router;
