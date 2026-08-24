'use strict';

/**
 * /api/admin/sales — internal Sales & Marketing Toolbox prospect pipeline. ADMIN ONLY.
 *
 * All routes are gated by auth + role('admin'). Prospect records, notes, lead scores, and assignments
 * are internal sales data and are NEVER exposed on any public/unauthenticated surface.
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const svc = require('../services/salesProspectService');

router.use(auth, role(['admin']));

// Funnel + inventory stats for the dashboard.
router.get('/stats', async (req, res, next) => {
  try { return res.json({ success: true, data: await svc.stats() }); }
  catch (err) { next(err); }
});

// Reference metadata for the UI (status/tier vocab) — keeps the client in sync with the server.
router.get('/meta', (req, res) => {
  res.json({
    success: true,
    data: {
      contact_status: svc.CONTACT_STATUS,
      contact_status_label: svc.CONTACT_STATUS_LABEL,
      tier_label: svc.TIER_LABEL,
      website_status: svc.WEBSITE_STATUS,
      tristate: svc.TRISTATE,
      activity_types: svc.ACTIVITY_TYPES,
    },
  });
});

// Filtered prospect list (geographic + pipeline filters via query string).
router.get('/prospects', async (req, res, next) => {
  try { return res.json({ success: true, data: await svc.listProspects(req.query) }); }
  catch (err) { next(err); }
});

// Single prospect + its activity timeline.
router.get('/prospects/:id', async (req, res, next) => {
  try {
    const p = await svc.getProspect(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Prospect not found' });
    const notes = await svc.listNotes(req.params.id);
    return res.json({ success: true, data: { ...p, notes } });
  } catch (err) { next(err); }
});

// Create a prospect (tier + lead score derived server-side).
router.post('/prospects', idempotency, async (req, res, next) => {
  try { return res.status(201).json({ success: true, data: await svc.createProspect(req.body, req.user.id) }); }
  catch (err) { if (err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});

// Update a prospect (re-scores; a status change is auto-logged to the timeline).
router.patch('/prospects/:id', async (req, res, next) => {
  try { return res.json({ success: true, data: await svc.updateProspect(req.params.id, req.body, req.user.id) }); }
  catch (err) { if (err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});

// Log a contact attempt / note against a prospect.
router.post('/prospects/:id/notes', async (req, res, next) => {
  try {
    const p = await svc.getProspect(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Prospect not found' });
    const note = await svc.addNote(req.params.id, req.user.id, req.body.activity_type, req.body.body);
    return res.status(201).json({ success: true, data: note });
  } catch (err) { next(err); }
});

module.exports = router;
