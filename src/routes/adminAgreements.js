'use strict';

/**
 * Admin Agreements API — mounted at /api/admin/agreements.
 * Phase A: template authoring (immutable versions) + preview, and per-seller
 * terms + identity management. Admin-only. No seller-facing send/sign here.
 * Reuses the established auth + role(['admin']) + idempotency middleware.
 */
const express = require('express');
const router  = express.Router();

const auth        = require('../middleware/authMiddleware');
const role        = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');

const templateService = require('../services/agreementTemplateService');
const termsService    = require('../services/sellerTermsService');
const identityService = require('../services/sellerIdentityService');
const { resolveAndRender } = require('../services/agreementVariableService');

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// Every route in this router requires an authenticated admin.
router.use(auth, role(['admin']));

// ── Templates ──────────────────────────────────────────────────────────────
router.get('/templates', async (req, res, next) => {
  try { return res.json({ success: true, data: await templateService.listTemplates() }); }
  catch (err) { next(err); }
});

router.post('/templates', idempotency, async (req, res, next) => {
  try {
    const { agreement_type, name, description } = req.body || {};
    if (!templateService.AGREEMENT_TYPES.includes(agreement_type)) {
      return res.status(400).json({ success: false, message: `agreement_type must be one of: ${templateService.AGREEMENT_TYPES.join(', ')}` });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const tpl = await templateService.createTemplate({ agreement_type, name: name.trim(), description, created_by: req.user.id });
    return res.status(201).json({ success: true, data: tpl });
  } catch (err) { next(err); }
});

router.get('/templates/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid template id' });
    const tpl = await templateService.getTemplate(req.params.id);
    if (!tpl) return res.status(404).json({ success: false, message: 'Template not found' });
    return res.json({ success: true, data: tpl });
  } catch (err) { next(err); }
});

router.post('/templates/:id/versions', idempotency, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid template id' });
    const { body_markdown, variable_schema, effective_terms_defaults } = req.body || {};
    if (!body_markdown || typeof body_markdown !== 'string' || !body_markdown.trim()) {
      return res.status(400).json({ success: false, message: 'body_markdown is required' });
    }
    if (variable_schema !== undefined && !Array.isArray(variable_schema)) {
      return res.status(400).json({ success: false, message: 'variable_schema must be an array' });
    }
    const version = await templateService.publishVersion(req.params.id, {
      body_markdown, variable_schema, effective_terms_defaults, created_by: req.user.id,
    });
    if (!version) return res.status(404).json({ success: false, message: 'Template not found' });
    return res.status(201).json({ success: true, data: version });
  } catch (err) { next(err); }
});

router.patch('/templates/:id', idempotency, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid template id' });
    if (typeof req.body?.is_active !== 'boolean') {
      return res.status(400).json({ success: false, message: 'is_active (boolean) is required' });
    }
    const tpl = await templateService.setActive(req.params.id, req.body.is_active, req.user.id);
    if (!tpl) return res.status(404).json({ success: false, message: 'Template not found' });
    return res.json({ success: true, data: tpl });
  } catch (err) { next(err); }
});

// Preview: resolve + render the template's current version. Optional
// sellerProfileId pulls that seller's terms/identity; `variables` are overrides.
// Never persists.
router.post('/templates/:id/preview', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid template id' });
    const tpl = await templateService.getTemplate(req.params.id);
    if (!tpl || !tpl.current_version) {
      return res.status(404).json({ success: false, message: 'Template (or its current version) not found' });
    }
    const { variables, sellerProfileId } = req.body || {};
    let sellerTerms = {}, sellerIdentity = {};
    if (sellerProfileId) {
      if (!isUuid(sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid sellerProfileId' });
      sellerTerms = (await termsService.getCurrentTerms(sellerProfileId)) || {};
      sellerIdentity = (await identityService.getIdentity(sellerProfileId)) || {};
    }
    const out = resolveAndRender({
      bodyMarkdown: tpl.current_version.body_markdown,
      variableSchema: tpl.current_version.variable_schema,
      termsDefaults: tpl.current_version.effective_terms_defaults,
      sellerTerms, sellerIdentity, overrides: variables || {},
    });
    return res.json({ success: true, data: out });
  } catch (err) { next(err); }
});

// ── Per-seller terms ─────────────────────────────────────────────────────────
router.get('/sellers/:sellerProfileId/terms', async (req, res, next) => {
  try {
    if (!isUuid(req.params.sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid seller id' });
    return res.json({ success: true, data: await termsService.getCurrentTerms(req.params.sellerProfileId) });
  } catch (err) { next(err); }
});

router.get('/sellers/:sellerProfileId/terms/history', async (req, res, next) => {
  try {
    if (!isUuid(req.params.sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid seller id' });
    return res.json({ success: true, data: await termsService.getHistory(req.params.sellerProfileId) });
  } catch (err) { next(err); }
});

router.put('/sellers/:sellerProfileId/terms', idempotency, async (req, res, next) => {
  try {
    if (!isUuid(req.params.sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid seller id' });
    const patch = req.body || {};
    const allowed = {};
    for (const f of termsService.TERMS_FIELDS) if (patch[f] !== undefined) allowed[f] = patch[f];
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ success: false, message: `Provide at least one of: ${termsService.TERMS_FIELDS.join(', ')}` });
    }
    const row = await termsService.setTerms(req.params.sellerProfileId, allowed, req.user.id);
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// ── Per-seller identity ───────────────────────────────────────────────────────
router.get('/sellers/:sellerProfileId/identity', async (req, res, next) => {
  try {
    if (!isUuid(req.params.sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid seller id' });
    return res.json({ success: true, data: await identityService.getIdentity(req.params.sellerProfileId) });
  } catch (err) { next(err); }
});

router.put('/sellers/:sellerProfileId/identity', idempotency, async (req, res, next) => {
  try {
    if (!isUuid(req.params.sellerProfileId)) return res.status(400).json({ success: false, message: 'Invalid seller id' });
    const patch = req.body || {};
    const allowed = {};
    for (const f of identityService.IDENTITY_FIELDS) if (patch[f] !== undefined) allowed[f] = patch[f];
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ success: false, message: `Provide at least one of: ${identityService.IDENTITY_FIELDS.join(', ')}` });
    }
    const row = await identityService.upsertIdentity(req.params.sellerProfileId, allowed, req.user.id);
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

module.exports = router;
