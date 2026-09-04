'use strict';

/**
 * Admin marketing-campaign workflow (Local Event Alert). Mounted at /api/admin/marketing-campaigns.
 * RBAC: requirePermission('members.view') (admins pass as super admin). READ + PREVIEW + safe TEST SEND +
 * READINESS only. There is NO production audience send here — A7 remains gated. The test send goes only to
 * explicitly-entered internal addresses (super-admin only) and never consumes the subscriber audience.
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const rbac = require('../lib/rbac');
const localAlert = require('../services/localEventAlertService');
const qa = require('../services/marketingEmailQaService');
const sender = require('../services/marketingSendService');
const readiness = require('../services/a7ReadinessService');
const marketingToken = require('../lib/marketingEmailToken');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
router.use(express.json());
router.use(auth, requirePermission('members.view'));

// Preview unsubscribe URL for rendering (a sample token so previews show a working footer).
function sampleUnsub() {
  return `${APP_BASE}/api/public/marketing-email/unsubscribe?token=${marketingToken.sign({ email: 'preview@example.com', campaign: 'local_event_alert' })}`;
}

// GET audience preview for an event: ?kind=auction|estate_sale|partner_event&id=<uuid|slug>&radius=25
router.get('/audience', async (req, res, next) => {
  try {
    const { kind, id } = req.query;
    if (!kind || !id) return res.status(400).json({ success: false, message: 'kind and id are required' });
    const out = await localAlert.buildAudience({ kind, idOrSlug: id, radiusMiles: req.query.radius ? Number(req.query.radius) : null });
    if (!out.ok) return res.status(404).json({ success: false, message: 'Event is not eligible (stale/closed/not public).' });
    res.json({ success: true, event: out.event, strategy: out.strategy, potential: out.potential, eligible: out.eligible,
      note: 'Preview only. Email radius is independent of the paid 30-mile advertising rule. No email is sent.' });
  } catch (e) { next(e); }
});

// POST render — returns the rendered marketing email for an event (no send).
router.post('/render', async (req, res, next) => {
  try {
    const { kind, id } = req.body || {};
    if (!kind || !id) return res.status(400).json({ success: false, message: 'kind and id are required' });
    const event = await localAlert.resolveEvent(kind, id);
    if (!event) return res.status(404).json({ success: false, message: 'Event is not eligible (stale/closed/not public).' });
    const rendered = localAlert.renderAlert(event, { unsubscribeUrl: sampleUnsub(), preferencesUrl: `${APP_BASE}/account.html` });
    res.json({ success: true, event, rendered });
  } catch (e) { next(e); }
});

// POST qa — run A2 email QA on a resolved event + rendered email.
router.post('/qa', async (req, res, next) => {
  try {
    const { kind, id, radius } = req.body || {};
    const event = await localAlert.resolveEvent(kind, id);
    if (!event) return res.status(404).json({ success: false, message: 'Event is not eligible.' });
    const audienceResult = await localAlert.buildAudience({ kind, idOrSlug: id, radiusMiles: radius ? Number(radius) : null });
    const rendered = localAlert.renderAlert(event, { unsubscribeUrl: sampleUnsub() });
    const verdict = qa.qaCampaign({ event, rendered, audienceResult, campaignClass: 'LOCAL_EVENT_ALERT' });
    res.json({ success: true, qa: verdict });
  } catch (e) { next(e); }
});

// POST test-send — SAFE internal test to explicit addresses. Super-admin only. No audience consumption.
router.post('/test-send', async (req, res, next) => {
  try {
    if (!rbac.isSuperAdmin(req.user)) return res.status(403).json({ success: false, message: 'Test send requires Super Admin.' });
    const { kind, id, to } = req.body || {};
    const addresses = Array.isArray(to) ? to : (typeof to === 'string' ? to.split(',').map((s) => s.trim()).filter(Boolean) : []);
    if (!addresses.length) return res.status(400).json({ success: false, message: 'Enter at least one internal test address.' });
    const event = await localAlert.resolveEvent(kind, id);
    if (!event) return res.status(404).json({ success: false, message: 'Event is not eligible.' });
    const rendered = localAlert.renderAlert(event, { unsubscribeUrl: sampleUnsub() });
    const result = await sender.testSend({
      campaignClass: 'LOCAL_EVENT_ALERT', eventKind: event.kind, eventRef: event.slug || event.id,
      rendered, toAddresses: addresses, sentBy: req.user.id,
    });
    if (!result.ok) return res.status(400).json({ success: false, message: 'Test send rejected: ' + result.reason });
    res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

// GET readiness — the authoritative A7 email readiness gate (READY != ENABLED).
router.get('/readiness', async (req, res, next) => {
  try { res.json({ success: true, readiness: await readiness.evaluate() }); }
  catch (e) { next(e); }
});

module.exports = router;
