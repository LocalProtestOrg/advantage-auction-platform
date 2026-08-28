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
const requirePermission = require('../middleware/requirePermission');
const idempotency = require('../middleware/idempotency');
const svc = require('../services/salesProspectService');
const outreach = require('../services/salesOutreachService');

// The acting staff context (id + super-admin flag) is resolved by requirePermission → req.staff.
// Identity/authorization for outreach is derived from this + the prospect's assignment, NEVER from body.
function actingStaff(req) { return { id: req.user.id, is_super_admin: !!(req.staff && req.staff.is_super_admin) }; }

// Sales & Marketing is permission-gated (not admin-only) so Marketing/Sales staff can use it while
// Super Admins retain access via the rbac bypass. Reads need sales.view; writes need
// sales.manage_prospects (see per-route guards below). Non-staff (buyer/seller) and other staff roles
// are denied server-side regardless of the UI.
router.use(auth, requirePermission('sales.view'));

// Funnel + inventory stats for the dashboard.
router.get('/stats', async (req, res, next) => {
  try { return res.json({ success: true, data: await svc.stats() }); }
  catch (err) { next(err); }
});

// Reference metadata for the UI (status/tier/priority vocab) — keeps the client in sync with the server.
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
      business_types: svc.BUSINESS_TYPES,
      business_type_label: svc.BUSINESS_TYPE_LABEL,
      lead_priority: svc.LEAD_PRIORITY,
      lead_priority_label: svc.LEAD_PRIORITY_LABEL,
      opportunity_type_label: svc.OPPORTUNITY_TYPE_LABEL,
    },
  });
});

// Sales reps available for lead assignment (staff only — never non-staff members).
router.get('/reps', async (req, res, next) => {
  try { return res.json({ success: true, data: await svc.listReps() }); }
  catch (err) { next(err); }
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
router.post('/prospects', requirePermission('sales.manage_prospects'), idempotency, async (req, res, next) => {
  try { return res.status(201).json({ success: true, data: await svc.createProspect(req.body, req.user.id) }); }
  catch (err) { if (err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});

// Update a prospect (re-scores; a status change is auto-logged to the timeline).
router.patch('/prospects/:id', requirePermission('sales.manage_prospects'), async (req, res, next) => {
  try { return res.json({ success: true, data: await svc.updateProspect(req.params.id, req.body, req.user.id) }); }
  catch (err) { if (err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});

// Log a contact attempt / note against a prospect.
router.post('/prospects/:id/notes', requirePermission('sales.manage_prospects'), async (req, res, next) => {
  try {
    const p = await svc.getProspect(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Prospect not found' });
    const note = await svc.addNote(req.params.id, req.user.id, req.body.activity_type, req.body.body);
    return res.status(201).json({ success: true, data: note });
  } catch (err) { next(err); }
});

// Quick "Contacted" action — records contacted status + timestamp + the acting rep; keeps history.
router.post('/prospects/:id/contacted', requirePermission('sales.manage_prospects'), async (req, res, next) => {
  try { return res.json({ success: true, data: await svc.markContacted(req.params.id, req.user.id, (req.body || {}).note) }); }
  catch (err) { if (err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});

// Bulk import/refresh — writes ONLY research columns; never overwrites CRM activity. Dedup-aware.
router.post('/import', requirePermission('sales.manage_prospects'), async (req, res, next) => {
  try {
    const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
    if (!records.length) return res.status(400).json({ success: false, message: 'records[] required' });
    if (records.length > 2000) return res.status(400).json({ success: false, message: 'max 2000 records per import' });
    const summary = await svc.importProspects(records, { source: (req.body.source || 'manual_import'), actorId: req.user.id });
    return res.json({ success: true, data: summary });
  } catch (err) { if (err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});

// ── Representative-based prospect outreach ─────────────────────────────────────────────────────────
const okErr = (res, err, next) => { if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message }); next(err); };

// Outreach template catalog (for the composer dropdown).
router.get('/outreach/templates', (req, res) => res.json({ success: true, data: require('../services/salesOutreachTemplates').catalog() }));

// Composer view-model for a prospect: assigned-rep identity (or what's required), recipient, suggested template.
router.get('/prospects/:id/outreach', async (req, res, next) => {
  try { return res.json({ success: true, data: await outreach.buildComposer(req.params.id, actingStaff(req)) }); }
  catch (err) { okErr(res, err, next); }
});

// Render a specific template for the composer (rep may then edit before sending).
router.get('/prospects/:id/outreach/template/:key', async (req, res, next) => {
  try {
    const r = await outreach.renderForComposer(req.params.id, req.params.key, actingStaff(req));
    if (r instanceof Error) return res.status(r.status || 400).json({ success: false, message: r.message });
    return res.json({ success: true, data: r });
  } catch (err) { okErr(res, err, next); }
});

// Outreach email history for a prospect (aggregate CRM record; internal only).
router.get('/prospects/:id/outreach/history', async (req, res, next) => {
  try { return res.json({ success: true, data: await outreach.listOutreachForProspect(req.params.id) }); }
  catch (err) { next(err); }
});

// Send one representative outreach email. Requires sales.send_email. Identity/recipient are server-derived.
router.post('/prospects/:id/email', requirePermission('sales.send_email'), idempotency, async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await outreach.sendOutreach({
      prospectId: req.params.id, actingStaff: actingStaff(req),
      templateKey: b.template_key, subject: b.subject, message: b.message, followUpDays: b.follow_up_days,
    });
    return res.json({ success: true, data: r });
  } catch (err) { okErr(res, err, next); }
});

// Rep outreach identities — Admin (sales.manage_reps) only.
router.get('/reps/profiles', requirePermission('sales.manage_reps'), async (req, res, next) => {
  try { return res.json({ success: true, data: await outreach.listRepProfiles() }); }
  catch (err) { next(err); }
});
router.post('/reps/:userId/profile', requirePermission('sales.manage_reps'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await outreach.upsertRepProfile({ userId: req.params.userId, displayName: b.display_name, outreachEmail: b.outreach_email, enabled: b.outreach_enabled }, req.user.id);
    return res.json({ success: true, data: r });
  } catch (err) { okErr(res, err, next); }
});

module.exports = router;
