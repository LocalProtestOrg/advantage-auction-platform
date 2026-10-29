'use strict';

/**
 * /api/org/event-distribution — a member company promotes its events (provider-neutral discovery, 2026-10-29).
 * The seller authorizes once and gives its website; Advantage.Bid does the rest. Every message is plain language
 * and vendor-neutral. Only an owner or administrator of the acting organization can authorize, change the events
 * page, create or revoke a sending key, or withdraw.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const resolveActingOrg = require('../middleware/resolveActingOrg');
const { asyncRoute, svcErr } = require('../utils/apiError');
const db = require('../db');
const discovery = require('../services/eventDiscovery/discoveryService');
const intake = require('../services/eventDiscovery/intakeService');
const authorization = require('../services/eventPartners/authorizationService');
const statement = require('../services/eventPartners/authorizationStatement');
const { DEFAULT_UA } = require('../services/eventImport/http');

router.use(authMiddleware, resolveActingOrg, express.json({ limit: '32kb' }));

async function roleOf(req) {
  if (!req.actingOrg) throw svcErr(404, 'NO_ORG', 'Create your company profile first.');
  if (req.user.role === 'admin') return 'admin';
  const r = (await db.query(`SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [req.actingOrg.id, req.user.id])).rows[0];
  return r ? r.role : null;
}
async function requireOrgAdmin(req) {
  const role = await roleOf(req);
  if (!['owner', 'admin'].includes(role)) throw svcErr(403, 'NOT_ORG_ADMIN', 'Only an owner or administrator of your company can do this.');
  return role;
}
async function liveAuth(orgId) {
  return (await db.query(`SELECT * FROM authorized_event_sources WHERE organization_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`,
    [orgId, discovery.LIVE])).rows[0] || null;
}
const checkLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'org:' + (req.actingOrg ? req.actingOrg.id : req.user.id),
  message: { success: false, message: 'You can ask us to check your website again in a little while.' } });

// GET / — the status the seller sees, plus the statement it would accept.
router.get('/', asyncRoute(async (req, res) => {
  if (!req.actingOrg) return res.json({ success: true, data: { state: 'no_org', message: 'Create your company profile first.' } });
  const status = await discovery.sellerStatus(db, req.actingOrg.id);
  const role = await roleOf(req);
  res.json({ success: true, data: Object.assign(status, { can_manage: ['owner', 'admin'].includes(role), organization: { id: req.actingOrg.id, name: req.actingOrg.name, website_url: req.actingOrg.website_url || null },
    statement: statement.build({ companyName: req.actingOrg.name, domain: status.authorization ? status.authorization.website : '' }) }) });
}));

// POST /authorize { website, events_page_url? } — trust-ladder Path C (the member's own account).
router.post('/authorize', checkLimiter, asyncRoute(async (req, res) => {
  const role = await requireOrgAdmin(req);
  const b = req.body || {};
  if (b.accept !== true) throw svcErr(400, 'ACCEPT_REQUIRED', 'Please confirm the authorization statement.');
  const out = await discovery.authorizeMember(db, { organizationId: req.actingOrg.id, userId: req.user.id, userEmail: req.user.email, role,
    website: b.website, eventsPageUrl: b.events_page_url || null, ip: req.ip, userAgent: req.get('user-agent') });
  // Discovery starts at once when enabled; otherwise the worker picks it up when discovery is switched on.
  if (out.created && discovery.discoveryOn()) discovery.runProbe(db, out.authorization.id, { trigger: 'authorized', actorId: req.user.id }).catch(() => {});
  res.json({ success: true, data: await discovery.sellerStatus(db, req.actingOrg.id) });
}));

// POST /events-page { url } — "my events are on this page".
router.post('/events-page', checkLimiter, asyncRoute(async (req, res) => {
  const role = await requireOrgAdmin(req);
  const auth = await liveAuth(req.actingOrg.id);
  if (!auth) throw svcErr(409, 'NOT_AUTHORIZED', 'Authorize event promotion first.');
  await discovery.authorizeMember(db, { organizationId: req.actingOrg.id, userId: req.user.id, role, website: auth.authorized_domain, eventsPageUrl: (req.body || {}).url });
  if (discovery.discoveryOn()) discovery.runProbe(db, auth.id, { trigger: 'seller', actorId: req.user.id }).catch(() => {});
  res.json({ success: true, data: await discovery.sellerStatus(db, req.actingOrg.id) });
}));

// POST /check — ask for a fresh check of the website (rate limited).
router.post('/check', checkLimiter, asyncRoute(async (req, res) => {
  await requireOrgAdmin(req);
  const auth = await liveAuth(req.actingOrg.id);
  if (!auth) throw svcErr(409, 'NOT_AUTHORIZED', 'Authorize event promotion first.');
  if (!discovery.discoveryOn()) return res.json({ success: true, data: Object.assign(await discovery.sellerStatus(db, req.actingOrg.id), { queued: true }) });
  await discovery.runProbe(db, auth.id, { trigger: 'seller', actorId: req.user.id });
  res.json({ success: true, data: await discovery.sellerStatus(db, req.actingOrg.id) });
}));

// POST /sending-keys { label? } — a key for "Send us your events automatically" (shown once).
router.post('/sending-keys', asyncRoute(async (req, res) => {
  await requireOrgAdmin(req);
  const auth = await liveAuth(req.actingOrg.id);
  if (!auth) throw svcErr(409, 'NOT_AUTHORIZED', 'Authorize event promotion first.');
  const key = await intake.createKey(db, auth.id, { actorId: req.user.id, label: (req.body || {}).label });
  res.json({ success: true, data: Object.assign(key, { endpoint: (process.env.PUBLIC_BASE_URL || 'https://bid.advantage.bid') + '/api/intake/v1/events',
    note: 'Copy this key now. For your security it is shown only once.' }) });
}));

router.delete('/sending-keys/:id', asyncRoute(async (req, res) => {
  await requireOrgAdmin(req);
  const auth = await liveAuth(req.actingOrg.id);
  if (!auth) throw svcErr(409, 'NOT_AUTHORIZED', 'Nothing to revoke.');
  res.json({ success: true, data: await intake.revokeKey(db, auth.id, req.params.id, { actorId: req.user.id }) });
}));

// GET /host-request — a ready-to-send request for the website provider (only shown when the site refuses us).
router.get('/host-request', asyncRoute(async (req, res) => {
  const auth = req.actingOrg ? await liveAuth(req.actingOrg.id) : null;
  if (!auth) throw svcErr(409, 'NOT_AUTHORIZED', 'Authorize event promotion first.');
  const text = [
    'Hello,',
    '',
    `We (${auth.company_name}, ${auth.authorized_domain}) have authorized Advantage.Bid to list our publicly advertised auctions and estate sales.`,
    'Advantage.Bid\'s event service is refused by our website when it reads our public event pages.',
    '',
    'Could you please allow requests identifying as:',
    `  ${DEFAULT_UA}`,
    `to our public event pages on ${auth.authorized_domain} (and robots.txt)? Traffic is light: a few requests a few times a week.`,
    '',
    'If you can, please also tell us whether our event pages publish schema.org Event structured data, or whether a calendar (iCal) or RSS feed of our upcoming events is available.',
    '',
    'Thank you,',
    auth.company_name,
  ].join('\n');
  res.json({ success: true, data: { subject: 'Please allow Advantage.Bid to read our public event pages', text } });
}));

// POST /withdraw — stop promotion. Collection stops and sending keys stop working at once.
router.post('/withdraw', asyncRoute(async (req, res) => {
  await requireOrgAdmin(req);
  const auth = await liveAuth(req.actingOrg.id);
  if (!auth) throw svcErr(409, 'NOT_AUTHORIZED', 'Nothing to withdraw.');
  await authorization.revoke(auth.id, { actorId: req.user.id, via: 'company_request', reason: String((req.body || {}).reason || 'withdrawn by the company').slice(0, 300) });
  res.json({ success: true, data: await discovery.sellerStatus(db, req.actingOrg.id) });
}));

module.exports = router;
