'use strict';

/**
 * Admin behavioral-audience view. Mounted at /api/admin/audiences. RBAC: requirePermission('members.view')
 * (admins pass as super admin). READ + PLANNING + a controlled refresh only. NO mass-send (A7 gated).
 * Raw clickstream is never exposed — only audience briefs, counts, rationale, and (for known members)
 * Quick-Contact resolution. Real production counts only; nothing is invented.
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const db = require('../db');
const director = require('../services/marketingDirectorService');
const membership = require('../services/audienceMembershipService');
const signals = require('../services/behavioralSignalService');
const destinations = require('../lib/audienceDestinations');
const audiences = require('../lib/behavioralAudiences');
const { recipientEmailSql } = require('../services/recipientService');

router.use(express.json());
router.use(auth, requirePermission('members.view'));

// GET / — all audience opportunity briefs + live destination sync states.
router.get('/', async (req, res, next) => {
  try {
    const briefs = await director.allBriefs();
    const { rows: dest } = await db.query(
      `SELECT audience_key, destination_type, enabled, sync_status, synced_count, last_success_at, error
         FROM marketing_audience_destinations`);
    res.json({ success: true, audiences: briefs, destinations: dest,
      note: 'Read-only planning. No campaign is sent here. Google/Meta OFF; A7 OFF.' });
  } catch (e) { next(e); }
});

// GET /:key/members — bounded active membership with Quick-Contact resolution for KNOWN members only.
router.get('/:key/members', async (req, res, next) => {
  try {
    if (!audiences.get(req.params.key)) return res.status(404).json({ success: false, message: 'Unknown audience' });
    const rows = await membership.members(req.params.key, { limit: 100 });
    // Resolve known identity (user/contact) → user_id + deliverable email for AdminContactActions.
    for (const m of rows) {
      if (m.scope_type === 'user') {
        const u = (await db.query(`SELECT id, ${recipientEmailSql('')} AS email, full_name FROM users WHERE id = $1`, [m.scope_id])).rows[0];
        if (u) { m.user_id = u.id; m.email = u.email; m.name = u.full_name; }
      } else if (m.scope_type === 'contact') {
        const c = (await db.query('SELECT user_id, preferred_email, normalized_email, full_name FROM marketing_contacts WHERE id = $1', [m.scope_id])).rows[0];
        if (c) { m.user_id = c.user_id; m.email = c.preferred_email || c.normalized_email; m.name = c.full_name; }
      }
      // Anonymous visitors: no identity exposed (scope stays visitor).
    }
    res.json({ success: true, audience_key: req.params.key, members: rows });
  } catch (e) { next(e); }
});

// GET /:key/email-preview — proves email use re-checks permission (behavior never overrides it).
router.get('/:key/email-preview', async (req, res, next) => {
  try {
    if (!audiences.get(req.params.key)) return res.status(404).json({ success: false, message: 'Unknown audience' });
    const out = await membership.emailEligibleCount(req.params.key, { marketingClass: req.query.class || 'local_event_alert' });
    res.json({ success: true, audience_key: req.params.key, ...out,
      note: 'Eligibility computed by audienceEligibilityService (permission/suppression/bounce/frequency). A7 remains OFF.' });
  } catch (e) { next(e); }
});

// GET /:key/export-spec/:dest — provider-neutral export SPEC (readiness only; no sync, no members).
router.get('/:key/export-spec/:dest', async (req, res, next) => {
  try {
    const def = audiences.get(req.params.key);
    if (!def) return res.status(404).json({ success: false, message: 'Unknown audience' });
    const dest = destinations.get(req.params.dest);
    if (!dest) return res.status(404).json({ success: false, message: 'Unknown destination' });
    res.json({ success: true, destination: dest, spec: destinations.buildExportSpec(Object.assign({ audience_key: req.params.key }, def), req.params.dest) });
  } catch (e) { next(e); }
});

// POST /refresh — recompute derived signals from recent behavior + refresh audience membership.
// Read-compute only (no send). Bounded.
router.post('/refresh', async (req, res, next) => {
  try {
    const sig = await signals.refreshRecent({ sinceHours: 24 * 14, limit: 1000 });
    const aud = await membership.refreshAll();
    res.json({ success: true, signals: sig, audiences: aud });
  } catch (e) { next(e); }
});

module.exports = router;
