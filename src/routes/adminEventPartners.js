'use strict';

/**
 * /api/admin/event-partners — the Phase 1 administrator surface for the Event Partner programme.
 *
 * What an administrator can do here: register a company, mint an authorization link (and copy it —
 * NOTHING is emailed in Phase 1), record an authorization that happened offline, create and validate
 * the company's import source, start/pause/resume collection, revoke permission, attribute events to a
 * proven host, and read first-party performance.
 *
 * What is deliberately absent: any "send" control. There is no outreach endpoint, no campaign action
 * and no message composer, because Phase 1 sends nothing to anybody.
 *
 * Every raw token this API returns is shown exactly once and is never recoverable afterwards.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const { asyncRoute, svcErr } = require('../utils/apiError');

const authorization = require('../services/eventPartners/authorizationService');
const partnerSource = require('../services/eventPartners/partnerSourceService');
const hostAttribution = require('../services/eventPartners/hostAttributionService');
const performance = require('../services/eventPartners/performanceStatsService');
const claimSecurity = require('../services/organizationClaimSecurityService');
const configService = require('../services/configService');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');

router.use(auth);
router.use(requirePermission('event_partners.view'));

/** Writes need the stronger permission. Reads are satisfied by the router-level check above. */
const manage = requirePermission('event_partners.manage');

const actor = (req) => req.user && req.user.id;

// ── Dashboard ──────────────────────────────────────────────────────────────────────────────────

// GET / — the partner list with authorization, source, event and claim state at a glance.
router.get('/', asyncRoute(async (req, res) => {
  const rows = await authorization.list({
    status: req.query.status, q: req.query.q,
    limit: req.query.limit, offset: req.query.offset,
  });
  const gates = {
    enabled: (await configService.get(null, 'event_partners.enabled')) === true,
    collection_enabled: (await configService.get(null, 'event_partners.collection_enabled')) === true,
    outreach_enabled: (await configService.get(null, 'event_partners.outreach_enabled')) === true,
    performance_min_metric: await performance.threshold(),
  };
  res.json({ success: true, data: rows, gates, states: authorization.STATES });
}));

// GET /:id — one partner in full: authorization, source, validation, performance, audit trail.
router.get('/:id', asyncRoute(async (req, res) => {
  const detail = await partnerSource.inspect(req.params.id);
  const perf = await performance.evaluateForAuthorization(req.params.id, {});
  const history = await authorization.auditHistory(req.params.id);
  res.json({ success: true, data: Object.assign({}, detail, { performance: perf, audit: history }) });
}));

// ── Registry ───────────────────────────────────────────────────────────────────────────────────

// POST / — register a company we intend to invite. Grants nothing; starts at 'prospective'.
router.post('/', manage, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const row = await authorization.createInvitation({
    organizationId: b.organization_id, companyName: b.company_name,
    domain: b.domain || b.website_url, sourceUrl: b.source_url,
    invitedEmail: b.invited_email, notes: b.notes, actorId: actor(req),
  });
  res.status(201).json({ success: true, data: row });
}));

// POST /:id/token — mint the one-click authorization link. Returned ONCE; nothing is sent.
router.post('/:id/token', manage, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const t = await authorization.issueAuthorizationToken(req.params.id, {
    actorId: actor(req), recipientEmail: b.recipient_email, ttlDays: b.ttl_days,
  });
  res.status(201).json({
    success: true,
    data: {
      // The only time this value exists outside the recipient's hands. It is stored only as a hash.
      authorization_url: `${APP_BASE}/authorize-event-promotion.html?token=${encodeURIComponent(t.token)}`,
      expires_at: t.expiresAt,
      token_id: t.tokenId,
      delivery: 'none — Phase 1 sends no email; copy this link and deliver it yourself',
    },
  });
}));

// POST /:id/authorize-offline — record an authorization given by other means. Evidence required.
router.post('/:id/authorize-offline', manage, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const row = await authorization.recordOfflineAuthorization(req.params.id, {
    method: b.method, evidence: b.evidence, documentUrl: b.document_url,
    contactName: b.contact_name, actorId: actor(req),
  });
  res.json({ success: true, data: row });
}));

// POST /:id/decline — the company said no.
router.post('/:id/decline', manage, asyncRoute(async (req, res) => {
  const row = await authorization.decline(req.params.id, { reason: (req.body || {}).reason, actorId: actor(req) });
  res.json({ success: true, data: row });
}));

// POST /:id/revoke — withdraw permission. Terminal; always disables the attached source.
router.post('/:id/revoke', manage, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const row = await authorization.revoke(req.params.id, {
    reason: b.reason, via: b.via || 'admin', actorId: actor(req),
  });
  res.json({ success: true, data: row });
}));

// ── Per-company import source ──────────────────────────────────────────────────────────────────

// POST /:id/source — create the company's own import source (always 'draft'; collects nothing).
router.post('/:id/source', manage, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const out = await partnerSource.createForAuthorization(req.params.id, {
    kind: b.kind, connector: b.connector, feedUrl: b.feed_url, name: b.name,
    attributionName: b.attribution_name, attributionUrl: b.attribution_url,
    mediaPolicy: b.media_policy, weeklyCap: b.weekly_cap,
    termsAttestedBy: b.terms_attested_by, termsAttestedUrl: b.terms_attested_url,
    actorId: actor(req),
  });
  res.status(out.created ? 201 : 200).json({ success: true, data: out });
}));

// PATCH /:id/source — change feed/attribution/caps. A feed change forces re-validation.
router.patch('/:id/source', manage, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const out = await partnerSource.updateSource(req.params.id, {
    feedUrl: b.feed_url, name: b.name, weeklyCap: b.weekly_cap, mediaPolicy: b.media_policy,
    attributionName: b.attribution_name, attributionUrl: b.attribution_url,
    termsAttestedBy: b.terms_attested_by, termsAttestedUrl: b.terms_attested_url,
    actorId: actor(req),
  });
  res.json({ success: true, data: out });
}));

// POST /:id/source/validate — run the safety checklist (domain match, terms, robots, attribution,
// media policy, publication policy). Passing advances the partner to 'source_configured'.
router.post('/:id/source/validate', manage, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const out = await partnerSource.validateSource(req.params.id, {
    robotsChecked: b.robots_checked === true, robotsCheckedBy: b.robots_checked_by,
    notes: b.notes, actorId: actor(req),
  });
  res.json({ success: true, data: out });
}));

// POST /:id/source/activate — begin collecting. Requires validation AND the Owner's platform gate.
router.post('/:id/source/activate', manage, asyncRoute(async (req, res) => {
  const row = await partnerSource.activate(req.params.id, { actorId: actor(req) });
  res.json({ success: true, data: row });
}));

// POST /:id/pause — halt collection without withdrawing permission.
router.post('/:id/pause', manage, asyncRoute(async (req, res) => {
  const row = await partnerSource.pause(req.params.id, { reason: (req.body || {}).reason, actorId: actor(req) });
  res.json({ success: true, data: row });
}));

// POST /:id/resume — resume; re-checks the platform gate (a pause is not a way around it).
router.post('/:id/resume', manage, asyncRoute(async (req, res) => {
  const row = await partnerSource.resume(req.params.id, { actorId: actor(req) });
  res.json({ success: true, data: row });
}));

// ── Host attribution ───────────────────────────────────────────────────────────────────────────

// GET /:id/host-candidates — REPORT historical events whose organizer website is on the authorized
// domain. Nothing is applied; each candidate needs an explicit accept.
router.get('/:id/host-candidates', asyncRoute(async (req, res) => {
  const rows = await hostAttribution.proposeHistoricalMatches(req.params.id, { limit: req.query.limit });
  res.json({ success: true, data: rows, applied: false });
}));

// POST /:id/host-candidates/:eventId — accept ONE candidate. Re-derived server-side before applying.
router.post('/:id/host-candidates/:eventId', manage, asyncRoute(async (req, res) => {
  const row = await hostAttribution.acceptHistoricalMatch(req.params.id, req.params.eventId, { actorId: actor(req) });
  res.json({ success: true, data: row });
}));

// ── Performance ────────────────────────────────────────────────────────────────────────────────

// GET /:id/performance — the deterministic eligibility decision plus the true counts. Reading this
// never sends anything; Phase 1 has no caller that emails a company.
router.get('/:id/performance', asyncRoute(async (req, res) => {
  const out = await performance.evaluateForAuthorization(req.params.id, {
    since: req.query.since || undefined, until: req.query.until || undefined,
    eventId: req.query.event_id || undefined,
  });
  if (!out) throw svcErr(404, 'NOT_FOUND', 'Authorization record not found.');
  res.json({ success: true, data: out });
}));

// ── Secure claim links ─────────────────────────────────────────────────────────────────────────

// POST /claim-token — issue a single-use, recipient-bound claim link for a directory listing.
// Returned ONCE; nothing is emailed. This is how a company securely takes ownership of the listing
// that has been quietly accumulating its events.
router.post('/claim-token', manage, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.organization_id) throw svcErr(400, 'ORG_REQUIRED', 'An organization is required.');
  const t = await claimSecurity.issueClaimToken(b.organization_id, {
    invitedEmail: b.invited_email, ttlDays: b.ttl_days, reason: b.reason, actorId: actor(req),
  });
  res.status(201).json({
    success: true,
    data: {
      claim_url: `${APP_BASE}/claim-listing.html?token=${encodeURIComponent(t.token)}&org=${encodeURIComponent(t.organizationId)}`,
      expires_at: t.expiresAt,
      invited_email: t.invitedEmail,
      delivery: 'none — Phase 1 sends no email; copy this link and deliver it yourself',
      note: 'The recipient must sign in with this exact email address, and it must be verified.',
    },
  });
}));

module.exports = router;
