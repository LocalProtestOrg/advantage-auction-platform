'use strict';

/**
 * /api/org/claim — a user finds and claims their business's inactive Organization shell (Phase 3B).
 * Search returns public-safe fields ONLY (name/city/state/website — never contact PII). Claiming
 * makes the user the owner (lifecycle 'claimed') and grants NO capabilities (verify/activate follow).
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../db');
const lifecycle = require('../services/organizationLifecycleService');
const { asyncRoute, svcErr } = require('../utils/apiError');

router.use(authMiddleware);

// GET /api/org/claim/search?q=&state= — claimable shells (NO email/phone exposed)
router.get('/search', asyncRoute(async (req, res) => {
  const q = (req.query.q || '').trim();
  const state = (req.query.state || '').trim().toUpperCase();
  if (q.length < 2) throw svcErr(400, 'QUERY_TOO_SHORT', 'Enter at least 2 characters.');
  const params = ['%' + q + '%'];
  let where = "lifecycle_state IN ('inactive','directory_listing') AND name ILIKE $1";
  if (state) { params.push(state); where += ' AND state = $' + params.length; }
  params.push(20);
  const { rows } = await db.query(
    `SELECT id, name, city, state, website_url FROM organizations WHERE ${where} ORDER BY name ASC LIMIT $${params.length}`, params);
  res.json({ success: true, results: rows });
}));

// POST /api/org/claim/:orgId — claim a shell (owner set; 0 capabilities until verified)
router.post('/:orgId', asyncRoute(async (req, res) => {
  const org = await lifecycle.claim(req.user.id, req.params.orgId);
  res.status(201).json({ success: true, organization: { id: org.id, slug: org.slug, name: org.name, lifecycle_state: org.lifecycle_state } });
}));

module.exports = router;
