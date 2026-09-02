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
const { blockDemoSideEffects } = require('../middleware/demoGuard');
const orgsService = require('../services/organizationsService');
const eventsService = require('../services/eventsService');
const { asyncRoute, svcErr } = require('../utils/apiError');
const multer = require('multer');
const cloudinaryService = require('../services/cloudinaryService');
const requireOrgCapability = require('../middleware/requireOrgCapability');
const resolveActingOrg = require('../middleware/resolveActingOrg');
const capabilityService = require('../services/capabilityService');
const profileSchema = require('../lib/professionalProfileSchema');
const followerCampaignService = require('../services/followerCampaignService');
const db = require('../db');

router.use(authMiddleware); // all org routes require a logged-in user (req.user.id)
router.use(resolveActingOrg); // sets req.actingOrg (header-selected or primary org fallback)

// Reuse the shared Cloudinary pipeline, scoped to any logged-in org user
// (/api/uploads/image is seller/admin-gated; organizers upload here instead).
const uploadImg = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Only image files are allowed.'), { status: 400 }));
  },
});

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function serializeOrg(o) {
  if (!o) return null;
  return {
    id: o.id, slug: o.slug, name: o.name, type: o.type, status: o.status,
    plan_tier: o.plan_tier, verification_status: o.verification_status,
    contact_email: o.contact_email, contact_phone: o.contact_phone,
    website_url: o.website_url, logo_url: o.logo_url, city: o.city, state: o.state,
    description: o.description || '', cover_image_url: o.cover_image_url || null,
    profile_data: o.profile_data || {},
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
    websiteUrl: 'website_url', logoUrl: 'logo_url', city: 'city', state: 'state',
    shortDescription: 'description', coverUrl: 'cover_image_url' };
  const out = {};
  for (const k of Object.keys(M)) if (hasOwn(b, k)) out[M[k]] = b[k];
  return out;
}
// The org's professional type keys (capabilities that are professional types).
async function orgProfessionalTypes(orgId) {
  if (!orgId) return [];
  try {
    const caps = await capabilityService.getEffectiveCapabilities(orgId);
    return profileSchema.professionalTypesFrom(Array.from(caps));
  } catch (e) { return []; }
}

// GET /api/org/profile-schema — the reusable Professional Profile field schema (drives the editor).
router.get('/profile-schema', asyncRoute(async (req, res) => {
  res.json({ success: true, sections: profileSchema.SECTIONS, professional_types: profileSchema.PROFESSIONAL_TYPES });
}));

// GET /api/org/profile — the caller's organization (or null if not onboarded yet) + professional
// types, completeness, and an owner PREVIEW view model (identical shape to the public view).
router.get('/profile', asyncRoute(async (req, res) => {
  const org = req.actingOrg;
  if (!org) return res.json({ success: true, organization: null, professional_types: [], completeness: 0, preview: null });
  const types = await orgProfessionalTypes(org.id);
  const s = serializeOrg(org);
  res.json({
    success: true,
    organization: s,
    professional_types: types,
    completeness: profileSchema.completeness(s, s.profile_data, types),
    preview: profileSchema.buildProfileView(s, types),
  });
}));

// POST /api/org/profile — onboard (create) if none, else update. Persists core columns +
// description + cover + validated profile_data (JSONB). Merges profile_data over existing.
router.post('/profile', asyncRoute(async (req, res) => {
  const b = req.body || {};
  let org = req.actingOrg;
  const created = !org;
  if (!org) org = await orgsService.onboardOrganization(req.user.id, b);
  const updates = mapOrgUpdate(b);
  if (hasOwn(b, 'profileData')) {
    const existing = (org.profile_data && typeof org.profile_data === 'object') ? org.profile_data : {};
    updates.profile_data = Object.assign({}, existing, profileSchema.sanitizeProfileData(b.profileData));
  }
  if (Object.keys(updates).length) org = await orgsService.updateProfile(req.user.id, org.id, updates);
  // Free Business Listing welcome — sent ONCE, only on the first-create transition (dedup is inherent:
  // `created` is true only when this POST onboarded a brand-new org). Best-effort; never blocks the save.
  if (created) {
    (async () => {
      try {
        const u = (await db.query('SELECT email FROM users WHERE id = $1', [req.user.id])).rows[0];
        if (u && u.email) {
          const m = require('../services/businessListingEmails').buildWelcomeEmail({ companyName: org.name, claimed: false });
          await require('../services/emailService').sendEmail({ to: u.email, ...m });
        }
      } catch (e) { console.error('[org] welcome email (create) best-effort failed:', e.message); }
    })();
  }
  const types = await orgProfessionalTypes(org.id);
  const s = serializeOrg(org);
  res.status(created ? 201 : 200).json({
    success: true, organization: s, professional_types: types,
    completeness: profileSchema.completeness(s, s.profile_data, types),
  });
}));

// POST /api/org/submit-listing — the owner submits their Free Business Listing for admin review.
// Sets profile_data.review_status='submitted' + a REQUESTED professional type (advisory; admin is
// authoritative and grants the actual capability at approval). Best-effort: confirmation email + owner
// operational SMS. Publication requires admin APPROVE & PUBLISH (never self-serve).
router.post('/submit-listing', asyncRoute(async (req, res) => {
  const review = require('../services/businessListingReviewService');
  const out = await review.submitForReview(req.user.id, { requestedType: (req.body || {}).business_type || (req.body || {}).requested_type });
  // Best-effort notifications (never block the submission outcome).
  (async () => {
    try {
      const u = (await db.query('SELECT email FROM users WHERE id = $1', [req.user.id])).rows[0];
      if (u && u.email) {
        const m = require('../services/businessListingEmails').buildSubmittedEmail({ companyName: out.name });
        await require('../services/emailService').sendEmail({ to: u.email, ...m });
      }
      require('../services/ownerAlertService').notifyOwnerBusinessListingSubmitted({
        companyName: out.name, businessType: out.requested_type, ownerEmail: u && u.email,
      }).catch(() => {});
    } catch (e) { console.error('[org] submit-listing notify best-effort failed:', e.message); }
  })();
  res.json({ success: true, review_status: out.review_status, requested_type: out.requested_type });
}));

// GET /api/org/events — the org's events + plan usage
router.get('/events', asyncRoute(async (req, res) => {
  const org = req.actingOrg;
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
  let org = req.actingOrg;
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

// POST /api/org/events/:id/submit — draft|rejected → submitted (active-event limit + 'events' capability enforced)
router.post('/events/:id/submit', requireOrgCapability('events'), asyncRoute(async (req, res) => {
  const ev = await eventsService.submit(req.user.id, req.params.id);
  // Professional companies auto-publish on submit. When (and only when) the event actually reached
  // 'published', fire the seller's opted-in follower campaign — best-effort, never blocks the response.
  if (ev && ev.status === 'published') {
    require('../services/followerCampaignService').activateOnPublish(ev).catch(() => {});
  }
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

// ── Notify Your Followers (Professional Seller follower-email campaigns) ───────────────────────────────
// Advantage.Bid owns the member/contact database: these endpoints NEVER return follower emails, phone
// numbers, names, or recipient lists — only aggregate audience counts + the seller's own campaign metadata.

// Build a safe preview view-model (what a follower will approximately receive) from an event + message.
async function buildCampaignPreview(ev, message) {
  const cover = (await db.query(
    'SELECT url FROM event_images WHERE event_id=$1 ORDER BY is_cover DESC, position ASC LIMIT 1', [ev.id])).rows[0];
  let companyName = null;
  if (ev.organization_id) {
    const org = (await db.query('SELECT name FROM organizations WHERE id=$1', [ev.organization_id])).rows[0];
    companyName = org && org.name;
  }
  return {
    company_name: companyName || 'Your company',
    event_title: ev.title || 'Your event',
    sale_type: ev.sale_type || null,
    image_url: (cover && cover.url) || null,
    date_line: followerCampaignService.dateLine(ev.start_at, ev.timezone),
    location_line: [ev.city, ev.state].filter(Boolean).join(', ') || null,
    custom_message: message != null ? String(message).slice(0, followerCampaignService.MAX_MESSAGE_LEN) : null,
    cta_label: 'View Event',
  };
}

// GET /api/org/events/:id/follower-campaign — eligibility, audience estimate, current campaign, preview.
router.get('/events/:id/follower-campaign', asyncRoute(async (req, res) => {
  const ev = await eventsService.getById(req.params.id);
  if (!ev) throw svcErr(404, 'EVENT_NOT_FOUND', 'Event not found.');
  await orgsService.assertOwner(req.user.id, ev.organization_id);
  const seller = await followerCampaignService.resolveSellerForEvent(ev);
  const eligible = followerCampaignService.sellerCanEmailFollowers(seller);
  const campaign = await followerCampaignService.getCampaignForEvent(ev.id);
  const audience = eligible && seller ? await followerCampaignService.estimateAudience(seller.id) : 0;
  res.json({
    success: true,
    eligible,
    audience_estimate: audience,
    max_message_len: followerCampaignService.MAX_MESSAGE_LEN,
    already_published: ev.status === 'published',
    campaign,
    preview: await buildCampaignPreview(ev, (campaign && campaign.custom_message) || ''),
  });
}));

// PUT /api/org/events/:id/follower-campaign — opt in/out + custom message (before publish).
router.put('/events/:id/follower-campaign', blockDemoSideEffects, asyncRoute(async (req, res) => {
  const ev = await eventsService.getById(req.params.id);
  if (!ev) throw svcErr(404, 'EVENT_NOT_FOUND', 'Event not found.');
  await orgsService.assertOwner(req.user.id, ev.organization_id);
  const b = req.body || {};
  const campaign = await followerCampaignService.upsertScheduledCampaign({
    event: ev, userId: req.user.id, enabled: !!b.enabled, customMessage: b.message,
  });
  const seller = await followerCampaignService.resolveSellerForEvent(ev);
  const audience = seller ? await followerCampaignService.estimateAudience(seller.id) : 0;
  res.json({
    success: true,
    enabled: !!campaign,
    audience_estimate: audience,
    campaign: campaign ? followerCampaignService.serializeCampaign(campaign, null) : null,
    preview: await buildCampaignPreview(ev, b.message || ''),
  });
}));

// GET /api/org/follower-campaigns — the acting seller's campaign history (counts only).
router.get('/follower-campaigns', asyncRoute(async (req, res) => {
  const sp = (await db.query('SELECT id FROM seller_profiles WHERE user_id=$1', [req.user.id])).rows[0];
  if (!sp) return res.json({ success: true, campaigns: [] });
  const campaigns = await followerCampaignService.listCampaignsForSeller(sp.id);
  res.json({ success: true, campaigns });
}));

// POST /api/org/upload-image — upload one image to Cloudinary, return secure_url.
// The portal posts that URL to /events/:id/images (attach). Reuses cloudinaryService.
router.post('/upload-image',
  (req, res, next) => {
    uploadImg.single('image')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, message: 'File too large. Maximum 10 MB.' });
      if (err.status === 400) return res.status(400).json({ success: false, message: err.message });
      next(err);
    });
  },
  asyncRoute(async (req, res) => {
    if (!req.file) throw svcErr(400, 'NO_FILE', 'No image file provided.');
    const result = await cloudinaryService.uploadBuffer(req.file.buffer, { folder: 'event-images' });
    res.status(201).json({ success: true, secure_url: result.secure_url });
  }));

module.exports = router;
