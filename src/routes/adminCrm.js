'use strict';

/**
 * /api/admin/crm — the Partner CRM operational surface (Phase 3C.1). Admin-only.
 * Nationwide Organization management: list/filter, detail (profile + reps + timeline + health),
 * activity logging (any channel — tracking-first), CRM stage/next-action, multi-rep assignment,
 * health recompute, and recruitment/activation target lists.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const db = require('../db');
const activity = require('../services/crmActivityService');
const reps = require('../services/crmRepService');
const crm = require('../services/crmService');
const health = require('../services/healthScoreService');
const { asyncRoute, svcErr } = require('../utils/apiError');

router.use(authMiddleware, roleMiddleware(['admin']));

// List organizations with CRM filters (ranked by health).
router.get('/organizations', asyncRoute(async (req, res) => {
  const { state, lifecycle, crm_stage, q } = req.query;
  const p = []; const w = [];
  if (state) { p.push(state.toUpperCase()); w.push('state = $' + p.length); }
  if (lifecycle) { p.push(lifecycle); w.push('lifecycle_state = $' + p.length); }
  if (crm_stage) { p.push(crm_stage); w.push('crm_stage = $' + p.length); }
  if (q) { p.push('%' + q + '%'); w.push('name ILIKE $' + p.length); }
  p.push(Math.min(parseInt(req.query.limit, 10) || 100, 500));
  const { rows } = await db.query(
    `SELECT id, name, city, state, lifecycle_state, crm_stage, health_score, last_contacted_at, next_action_at
       FROM organizations ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
      ORDER BY health_score DESC NULLS LAST, name ASC LIMIT $${p.length}`, p);
  res.json({ success: true, organizations: rows });
}));

// Organization CRM detail: profile + reps + unified timeline + live health breakdown.
router.get('/organizations/:id', asyncRoute(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM organizations WHERE id = $1', [req.params.id]);
  if (!rows.length) throw svcErr(404, 'ORG_NOT_FOUND', 'Organization not found.');
  const o = rows[0];
  const [timeline, repList, hs] = await Promise.all([activity.timeline(o.id, 50), reps.list(o.id), health.compute(o.id)]);
  res.json({ success: true,
    organization: {
      id: o.id, name: o.name, slug: o.slug, city: o.city, state: o.state,
      lifecycle_state: o.lifecycle_state, crm_stage: o.crm_stage, health_score: o.health_score,
      next_action_at: o.next_action_at, last_contacted_at: o.last_contacted_at,
      website_url: o.website_url, description: o.description, contact_email: o.contact_email, contact_phone: o.contact_phone,
    },
    reps: repList, timeline, health: hs });
}));

// Log activity — any channel (tracking-first). No automated sending here.
router.post('/organizations/:id/activity', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const a = await activity.log(req.params.id, {
    activityType: b.activityType || 'note', channel: b.channel || null, direction: b.direction || 'internal',
    actorId: req.user.id, subject: b.subject || null, body: b.body || null, occurredAt: b.occurredAt || null,
  });
  res.status(201).json({ success: true, activity: a });
}));

// CRM stage + next action.
router.put('/organizations/:id/crm', asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (b.crm_stage) await crm.setStage(req.params.id, b.crm_stage, req.user.id);
  if (Object.prototype.hasOwnProperty.call(b, 'next_action_at')) await crm.setNextAction(req.params.id, b.next_action_at);
  res.json({ success: true });
}));

// Multi-rep assignment.
router.get('/organizations/:id/reps', asyncRoute(async (req, res) => { res.json({ success: true, reps: await reps.list(req.params.id) }); }));
router.post('/organizations/:id/reps', asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.userId) throw svcErr(400, 'USER_REQUIRED', 'userId is required.');
  const rep = await reps.assign(req.params.id, b.userId, { role: b.role || 'rep', isPrimary: !!b.isPrimary, assignedBy: req.user.id });
  res.status(201).json({ success: true, rep });
}));
router.delete('/organizations/:id/reps/:userId', asyncRoute(async (req, res) => { await reps.remove(req.params.id, req.params.userId); res.json({ success: true }); }));

// Health recompute (cache).
router.post('/organizations/:id/health/recompute', asyncRoute(async (req, res) => {
  res.json({ success: true, health: await health.recompute(req.params.id) });
}));

// Recruitment/activation target lists.
router.get('/targets/:kind', asyncRoute(async (req, res) => {
  res.json({ success: true, targets: await crm.targets(req.params.kind, { state: req.query.state, limit: req.query.limit ? parseInt(req.query.limit, 10) : 50 }) });
}));

module.exports = router;
