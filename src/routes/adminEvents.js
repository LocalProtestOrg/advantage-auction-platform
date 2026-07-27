'use strict';

/**
 * /api/admin/events — event moderation (Phase 1). Admin only.
 *
 * Single approval action: Approve & Publish (submitted → published). Plus reject,
 * return-to-draft, archive. Every transition is audited by the service layer.
 * Admin-created events and admin overrides are DEFERRED (would extend eventsService).
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const db = require('../db');
const eventsService = require('../services/eventsService');
const eventGeocodingService = require('../services/eventGeocodingService');
const { asyncRoute, svcErr } = require('../utils/apiError');

router.use(authMiddleware, roleMiddleware(['admin']));

function serializeAdminEvent(r) {
  return {
    id: r.id, slug: r.slug, status: r.status, source: r.source,
    market: r.market_slug, category: r.category_slug, title: r.title,
    start_at: r.start_at, end_at: r.end_at, is_featured: r.is_featured,
    submitted_at: r.submitted_at, published_at: r.published_at, review_reason: r.review_reason,
    created_at: r.created_at,
    organization: r.org_id
      ? { id: r.org_id, name: r.org_name, slug: r.org_slug, verification_status: r.org_verif }
      : null,
  };
}

// GET /api/admin/events?status=&market=  — moderation queue (submitted first)
router.get('/', asyncRoute(async (req, res) => {
  const { status, market } = req.query;
  const params = []; const where = [];
  if (status) { params.push(status); where.push(`e.status = $${params.length}`); }
  if (market) { params.push(market); where.push(`e.market_slug = $${params.length}`); }
  params.push(200); // hard cap
  const { rows } = await db.query(
    `SELECT e.*, o.id AS org_id, o.name AS org_name, o.slug AS org_slug, o.verification_status AS org_verif
       FROM events e LEFT JOIN organizations o ON o.id = e.organization_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (e.status = 'submitted') DESC, e.submitted_at DESC NULLS LAST, e.created_at DESC
      LIMIT $${params.length}`, params);
  res.json({ success: true, events: rows.map(serializeAdminEvent) });
}));

// GET /api/admin/events/:id — full record + images + audit trail
router.get('/:id', asyncRoute(async (req, res) => {
  const { rows } = await db.query(
    `SELECT e.*, o.id AS org_id, o.name AS org_name, o.slug AS org_slug, o.verification_status AS org_verif
       FROM events e LEFT JOIN organizations o ON o.id = e.organization_id WHERE e.id = $1`,
    [req.params.id]);
  if (!rows.length) throw svcErr(404, 'EVENT_NOT_FOUND', 'Event not found.');
  const e = rows[0];
  const images = (await db.query(
    'SELECT id, url, position, is_cover FROM event_images WHERE event_id = $1 ORDER BY position ASC', [e.id])).rows;
  const audit = (await db.query(
    `SELECT event_type, actor_id, metadata, created_at FROM audit_log
      WHERE entity_type = 'event' AND entity_id = $1 ORDER BY created_at ASC`, [e.id])).rows;
  res.json({
    success: true,
    event: { ...serializeAdminEvent(e), description: e.description, venue_name: e.venue_name,
      address: e.address, city: e.city, state: e.state, zip: e.zip, lat: e.lat, lng: e.lng,
      timezone: e.timezone, external_url: e.external_url, attribution_source: e.attribution_source,
      attribution_url: e.attribution_url },
    images, audit,
  });
}));

// POST /api/admin/events/:id/publish  — Approve & Publish
router.post('/:id/publish', asyncRoute(async (req, res) => {
  const ev = await eventsService.adminPublish(req.user.id, req.params.id);
  // Enrichment only — never blocks publish. Populates the two-tier privacy coordinates
  // (public offset marker + precise internal point) for the map; degrades silently if the
  // geocoder is unconfigured. The time-based address reveal works with or without a marker.
  eventGeocodingService.geocodeEventSafe(ev.id).catch(() => {});
  res.json({ success: true, event: serializeAdminEvent(ev) });
}));

// POST /api/admin/events/:id/geocode  — admin manual re-geocode (force past a manual pin)
router.post('/:id/geocode', asyncRoute(async (req, res) => {
  const result = await eventGeocodingService.geocodeEventSafe(req.params.id, { force: true });
  res.json({ success: true, result });
}));

// POST /api/admin/events/:id/reject  (reason required)
router.post('/:id/reject', asyncRoute(async (req, res) => {
  const ev = await eventsService.adminReject(req.user.id, req.params.id, (req.body || {}).reason);
  res.json({ success: true, event: serializeAdminEvent(ev) });
}));

// POST /api/admin/events/:id/return-to-draft  (reason required)
router.post('/:id/return-to-draft', asyncRoute(async (req, res) => {
  const ev = await eventsService.adminReturnToDraft(req.user.id, req.params.id, (req.body || {}).reason);
  res.json({ success: true, event: serializeAdminEvent(ev) });
}));

// POST /api/admin/events/:id/archive
router.post('/:id/archive', asyncRoute(async (req, res) => {
  const ev = await eventsService.adminArchive(req.user.id, req.params.id);
  res.json({ success: true, event: serializeAdminEvent(ev) });
}));

module.exports = router;
