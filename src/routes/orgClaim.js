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
//
// SECURITY: a signed-in session is no longer sufficient. organizationClaimSecurityService requires a
// single-use, recipient-bound claim token OR a verified company-domain email address, and records
// every attempt. `claim_token` may arrive in the body or as ?token= (the shape a claim link uses).
router.post('/:orgId', asyncRoute(async (req, res) => {
  const claimToken = (req.body && req.body.claim_token) || req.query.token || null;
  const org = await lifecycle.claim(req.user.id, req.params.orgId, {
    claimToken,
    ip: req.headers['x-forwarded-for'] || req.ip || '',
  });
  // After the claim (migration 170): funnel event, hard attribution record, any listing outreach stopped,
  // and the listing checklist started. The one-time claim email (A1, or the existing welcome email until
  // an A1 template is approved) is sent from there, once. Best-effort; never blocks the claim response.
  (async () => {
    try {
      const a = (await db.query(
        `SELECT proof_method, claim_token_id FROM organization_claim_attempts
          WHERE organization_id = $1 AND outcome = 'granted' ORDER BY created_at DESC LIMIT 1`, [org.id])).rows[0] || {};
      await require('../services/claimedListings/claimLinkService').afterClaim({
        organizationId: org.id, userId: req.user.id, tokenId: a.claim_token_id || null, proofMethod: a.proof_method || null,
        ip: req.headers['x-forwarded-for'] || req.ip || '',
      });
    } catch (e) { console.error('[org-claim] after-claim best-effort failed:', e.message); }
  })();
  res.status(201).json({ success: true, organization: { id: org.id, slug: org.slug, name: org.name, lifecycle_state: org.lifecycle_state } });
}));

module.exports = router;
