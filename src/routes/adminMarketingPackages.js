'use strict';

/**
 * /api/admin/marketing-packages — Super-Admin management of the Marketing Package platform: package
 * versions, confidential economic policy, capacity config, purchases, obligations + proof, substitutions,
 * and channel readiness. Super-Admin-only (role='admin') because it exposes CONFIDENTIAL economics —
 * mirrors adminAgreements RBAC. Never exposes policy to lesser roles.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const registry = require('../services/packageRegistryService');
const econ = require('../services/economicPolicyService');
const obligations = require('../services/marketingObligationEngine');
const channelReadiness = require('../services/channelReadinessService');
const configService = require('../services/configService');

router.use(auth, role(['admin']));   // Super Admin only (confidential economics)

// ── Package versions ──
router.get('/versions', async (req, res, next) => {
  try { const out = {}; for (const k of registry.PACKAGE_KEYS) out[k] = await registry.listVersions(k); return res.json({ success: true, data: out }); }
  catch (err) { next(err); }
});
router.post('/versions', async (req, res, next) => {
  try { const row = await registry.createVersion(req.body || {}, req.user.id); return res.status(201).json({ success: true, data: row }); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ success: false, message: err.message, code: err.code }); next(err); }
});
router.post('/versions/:id/activate', async (req, res, next) => {
  try { return res.json({ success: true, data: await registry.setActive(req.params.id, true, req.user.id) }); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});
router.post('/versions/:id/retire', async (req, res, next) => {
  try { return res.json({ success: true, data: await registry.setActive(req.params.id, false, req.user.id) }); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});

// ── Economic policy (CONFIDENTIAL — Super Admin only) ──
router.get('/economic-policies', async (req, res, next) => {
  try { return res.json({ success: true, data: await econ.list() }); } catch (err) { next(err); }
});
router.post('/economic-policies', async (req, res, next) => {
  try { const row = await econ.createPolicy(req.body || {}, req.user.id); return res.status(201).json({ success: true, data: row }); }
  catch (err) { if (err && err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});

// ── Capacity config (operational seeds; editable without deploy) ──
const CAPACITY_KEYS = [
  'marketing.pkg.shared_email.target_auctions', 'marketing.pkg.shared_email.normal_max',
  'marketing.pkg.shared_email.editions_per_market_week', 'marketing.pkg.dedicated_email.max_per_market_week',
  'marketing.pkg.dedicated_email.global_max_per_day', 'marketing.pkg.dedicated_email.overlap_spacing_hours',
  'marketing.pkg.dedicated_email.audience_floor', 'marketing.pkg.homepage.hero_days',
  'marketing.pkg.homepage.module_days', 'marketing.pkg.quote_lock_minutes', 'marketing.pkg.version_activation_lead_hours',
];
router.get('/capacity', async (req, res, next) => {
  try { const out = {}; for (const k of CAPACITY_KEYS) out[k] = await configService.get(null, k); return res.json({ success: true, data: out }); }
  catch (err) { next(err); }
});
router.put('/capacity', async (req, res, next) => {
  try {
    const b = req.body || {}; const key = String(b.key || '');
    if (CAPACITY_KEYS.indexOf(key) === -1) return res.status(400).json({ success: false, message: 'Not an editable capacity key' });
    const n = Math.trunc(Number(b.value)); if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, message: 'value must be a non-negative integer' });
    await configService.setPlatformConfig(key, n);
    return res.json({ success: true, data: { key, value: n } });
  } catch (err) { next(err); }
});

// ── Channel readiness matrix ──
router.get('/channel-readiness', async (req, res, next) => {
  try { return res.json({ success: true, data: await channelReadiness.matrix() }); } catch (err) { next(err); }
});

// ── Purchases + obligations + proof (full, incl. confidential economics — admin only) ──
router.get('/purchases', async (req, res, next) => {
  try {
    const rows = (await db.query(`SELECT * FROM marketing_package_purchases ORDER BY purchased_at DESC LIMIT 200`)).rows;
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});
router.get('/purchases/:id', async (req, res, next) => {
  try {
    const p = (await db.query(`SELECT * FROM marketing_package_purchases WHERE id = $1`, [req.params.id])).rows[0];
    if (!p) return res.status(404).json({ success: false, message: 'Not found' });
    const obs = await obligations.listForPurchase('package', p.id);
    const completion = await obligations.evaluateCompletion('package', p.id);
    const reservations = (await db.query(`SELECT * FROM marketing_homepage_reservations WHERE obligation_id = ANY($1::uuid[])`, [obs.map((o) => o.id)])).rows;
    return res.json({ success: true, data: { purchase: p, obligations: obs, completion, homepage_reservations: reservations } });
  } catch (err) { next(err); }
});

// ── Obligation transitions / substitution (admin ops) ──
router.post('/obligations/:id/transition', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await obligations.transition(req.params.id, b.state, { proof: b.proof, notes: b.notes, campaignId: b.campaign_id }, req.user.id);
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});
router.post('/obligations/:id/substitute', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await obligations.substitute(req.params.id, b.replacement || {}, { reason: b.reason }, req.user.id);
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

module.exports = router;
