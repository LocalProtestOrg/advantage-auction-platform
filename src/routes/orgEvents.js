'use strict';

/**
 * /api/org — the organization portal API (Phase 1, native auth, owner-scoped).
 *
 * Onboarding is automatic: creating a first event (or POSTing a profile) creates the
 * caller's single organization with them as `owner`. Ownership is enforced in the
 * service layer (assertOwner). Responses are allowlisted. No auction/payment changes.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const orgsService = require('../services/organizationsService');
const eventsService = require('../services/eventsService');
const { asyncRoute, svcErr } = require('../utils/apiError');

router.use(authMiddleware); // all org routes require a logged-in user (req.user.id)

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function serializeOrg(o) {
  if (!o) return null;
  return {
    id: o.id, slug: o.slug, name: o.name, type: o.type, status: o.status,
    plan_tier: o.plan_tier, verification_status: o.verification_status,
    contact_email: o.contact_email, contact_phone: o.contact_phone,
    website_url: o.website_url, logo_url: o.logo_url, city: o.city, state: o.state,
    created_at: o.created_at,
  };
}
function serializeEvent(e) {
  return {
    id: e.id, slug: e.slug, status: e.status, source: e.source,
    market: e.market_slug, category: e.category_slug,
    title: e.title, description: e.description,
    venue_name: e.venue_name, address: e.address, city: e.city, state: e.state, zip: e.zip,
    lat: e.lat, lng: e.lng, start_at: e.start_at, end_at: e.end_at, timezone: e.timezone,
    external_url: e.external_url, is_featured: e.is_featured, review_reason: e.review_reason,
    submitted_at: e.submitted_at, published_at: e.published_at,
    created_at: e.created_at, updated_at: e.updated_at,
  };
}
// camelCase profile input → snake columns for updateProfile
function mapOrgUpdate(b) {
  const M = { name: 'name', type: 'type', contactEmail: 'contact_email', contactPhone: 'contact_phone',
    websiteUrl: 'website_url', logoUrl: 'logo_url', city: 'city', state: 'state' };
  const out = {};
  for (const k of Object.keys(M)) if (hasOwn(b, k)) out[M[k]] = b[k];
  return out;
}

// GET /api/org/profile — the caller's organization (or null if not onboarded yet)
router.get('/profile', asyncRoute(async (req, res) => {
  const org = await orgsService.getPrimaryOrgForUser(req.user.id);
  res.json({ success: true, organization: serializeOrg(org) });
}));

// POST /api/org/profile — onboard (create) if none, else update the profile
router.post('/profile', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const existing = await orgsService.getPrimaryOrgForUser(req.user.id);
  const org = existing
    ? await orgsService.updateProfile(req.user.id, existing.id, mapOrgUpdate(b))
    : await orgsService.onboardOrganization(req.user.id, b);
  res.status(existing ? 200 : 201).json({ success: true, organization: serializeOrg(org) });
}));

// GET /api/org/events — the org's events + plan usage
router.get('/events', asyncRoute(async (req, res) => {
  const org = await orgsService.getPrimaryOrgForUser(req.user.id);
  if (!org) return res.json({ success: true, organization: null, plan: null, usage: null, events: [] });
  const [events, plan, active] = await Promise.all([
    eventsService.listForOrg(org.id),
    orgsService.getPlan(org.plan_tier),
    eventsService.countActiveEvents(org.id),
  ]);
  res.json({
    success: true,
    organization: serializeOrg(org),
    plan: plan && { tier: plan.plan_tier, max_active_events: plan.max_active_events,
      max_event_images: plan.max_event_images, can_feature_events: plan.can_feature_events },
    usage: { active_events: active },
    events: events.map(serializeEvent),
  });
}));

// POST /api/org/events — create a draft (auto-onboards the org on first event)
router.post('/events', asyncRoute(async (req, res) => {
  const b = req.body || {};
  let org = await orgsService.getPrimaryOrgForUser(req.user.id);
  if (!org) org = await orgsService.onboardOrganization(req.user.id, b.organization || {});
  const ev = await eventsService.createDraft(req.user.id, org, b);
  res.status(201).json({ success: true, event: serializeEvent(ev), organization: serializeOrg(org) });
}));

// GET /api/org/events/:id — one owned event + its images
router.get('/events/:id', asyncRoute(async (req, res) => {
  const ev = await eventsService.getById(req.params.id);
  if (!ev) throw svcErr(404, 'EVENT_NOT_FOUND', 'Event not found.');
  await orgsService.assertOwner(req.user.id, ev.organization_id);
  const images = await eventsService.listImages(ev.id);
  res.json({
    success: true,
    event: serializeEvent(ev),
    images: images.map((i) => ({ id: i.id, url: i.url, position: i.position, is_cover: i.is_cover })),
  });
}));

// PATCH /api/org/events/:id — edit (draft/rejected only; owner enforced in service)
router.patch('/events/:id', asyncRoute(async (req, res) => {
  const ev = await eventsService.updateDraft(req.user.id, req.params.id, req.body || {});
  res.json({ success: true, event: serializeEvent(ev) });
}));

// POST /api/org/events/:id/submit — draft|rejected → submitted (active-event limit enforced)
router.post('/events/:id/submit', asyncRoute(async (req, res) => {
  const ev = await eventsService.submit(req.user.id, req.params.id);
  res.json({ success: true, event: serializeEvent(ev) });
}));

// POST /api/org/events/:id/archive — owner archive (draft/rejected only)
router.post('/events/:id/archive', asyncRoute(async (req, res) => {
  const ev = await eventsService.archiveByOwner(req.user.id, req.params.id);
  res.json({ success: true, event: serializeEvent(ev) });
}));

// POST /api/org/events/:id/images — attach an already-uploaded Cloudinary URL (limit enforced)
router.post('/events/:id/images', asyncRoute(async (req, res) => {
  const { url, isCover } = req.body || {};
  const img = await eventsService.addImage(req.user.id, req.params.id, url, { isCover: !!isCover });
  res.status(201).json({ success: true, image: { id: img.id, url: img.url, position: img.position, is_cover: img.is_cover } });
}));

// DELETE /api/org/events/:id/images/:imageId
router.delete('/events/:id/images/:imageId', asyncRoute(async (req, res) => {
  await eventsService.removeImage(req.user.id, req.params.id, req.params.imageId);
  res.json({ success: true });
}));

module.exports = router;
