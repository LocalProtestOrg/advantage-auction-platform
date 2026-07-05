'use strict';

/**
 * /api/legal — per-tenant, versioned legal documents + acceptance ledger (Constitution §8/§12).
 * Public read of the current published version (with platform fallback); authenticated acceptance;
 * admin management of documents/versions.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const legalService = require('../services/legalService');
const { asyncRoute, svcErr } = require('../utils/apiError');

// Authenticated: record acceptance of a version.
router.post('/accept', authMiddleware, asyncRoute(async (req, res) => {
  const { versionId, organizationId } = req.body || {};
  if (!versionId) throw svcErr(400, 'VERSION_REQUIRED', 'versionId is required.');
  const acceptance = await legalService.accept(req.user.id, versionId, organizationId || null, req.ip);
  res.status(201).json({ success: true, acceptance });
}));

// Admin: create/upsert a document, add a version, publish a version.
router.post('/documents', authMiddleware, roleMiddleware(['admin']), asyncRoute(async (req, res) => {
  const { organizationId, docType, title } = req.body || {};
  const document = await legalService.upsertDocument(organizationId || null, docType, title);
  res.status(201).json({ success: true, document });
}));
router.post('/documents/:id/versions', authMiddleware, roleMiddleware(['admin']), asyncRoute(async (req, res) => {
  const version = await legalService.addVersion(req.params.id, (req.body || {}).content);
  res.status(201).json({ success: true, version });
}));
router.post('/versions/:id/publish', authMiddleware, roleMiddleware(['admin']), asyncRoute(async (req, res) => {
  const version = await legalService.publishVersion(req.params.id);
  res.json({ success: true, version });
}));

// Public: current published version for a doc type (optional ?org=<uuid>; platform fallback).
router.get('/:docType', asyncRoute(async (req, res) => {
  const v = await legalService.getPublished(req.query.org || null, req.params.docType);
  if (!v) throw svcErr(404, 'NOT_PUBLISHED', 'No published document for this type.');
  res.json({ success: true, document: {
    doc_type: v.doc_type, title: v.title, version: v.version, version_id: v.id, content: v.content, published_at: v.published_at,
  } });
}));

module.exports = router;
