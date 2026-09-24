'use strict';

/**
 * /api/admin/claimed-listings — the Claimed Listings tab of the Sales & Marketing Toolbox.
 *
 * Permissions (src/lib/rbac.js): listings.view (read) · listings.work (lock, log, tasks, pause, propose,
 * shadow) · listings.approve_cohort (Super Admin: templates, cohorts, program switches) ·
 * listings.manage_journey (Super Admin: journeys, lock reassignment, identity apply, admin-assisted claims,
 * profile-change decisions). No package economics or financial fields are returned by any route.
 *
 * Nothing here sends outreach. Program switches are an audited Super Admin edit path; they ship OFF.
 */

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const db = require('../db');
const auditService = require('../services/auditService');
const toolbox = require('../services/claimedListings/toolboxService');
const eligibility = require('../services/claimedListings/eligibilityService');
const scoring = require('../services/claimedListings/scoringService');
const tasks = require('../services/claimedListings/taskService');
const templates = require('../services/claimedListings/templates');
const sequences = require('../services/claimedListings/sequenceService');
const funnelSvc = require('../services/claimedListings/funnelService');
const profileChanges = require('../services/claimedListings/profileChangeService');
const sendGate = require('../services/claimedListings/sendGate');
const identity = require('../services/acquisition/companyIdentityService');
const journeys = require('../services/acquisition/journeyService');
const locks = require('../services/acquisition/contactLockService');
const lifecycle = require('../services/organizationLifecycleService');
const claims = require('../services/claimedListings/claimLinkService');
const { normalizeEmail } = require('../lib/emailNormalize');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const staff = (req) => ({ id: req.user.id, isSuperAdmin: !!(req.staff && req.staff.is_super_admin) });
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[admin-claimed-listings]', e.message);
    res.status(status).json({ success: false, code: e.code || 'FAILED', message: e.expose || status < 500 ? e.message : 'Request failed.' });
  }
};
const idParam = (name) => (req, res, next) => (UUID_RE.test(req.params[name]) ? next() : res.status(404).json({ success: false, message: 'Not found.' }));
const work = requirePermission('listings.work');
const approve = requirePermission('listings.approve_cohort');
const journeyPerm = requirePermission('listings.manage_journey');

router.use(auth, requirePermission('listings.view'));

const PROGRAM_KEYS = ['claimed_listings.sending_enabled', 'claimed_listings.inbound_enabled', 'claimed_listings.activation_emails_enabled',
  'claimed_listings.self_request_enabled', 'claimed_listings.paused_reason', 'claimed_listings.daily_cap', 'company.postal_address'];

async function programState() {
  const cfg = (await db.query(`SELECT key, value, updated_at FROM platform_config WHERE key = ANY($1)`, [PROGRAM_KEYS])).rows
    .reduce((m, r) => { m[r.key] = r.value; return m; }, {});
  const emailService = require('../services/emailService');
  return {
    switches: {
      sending_enabled: cfg['claimed_listings.sending_enabled'] === true, inbound_enabled: cfg['claimed_listings.inbound_enabled'] === true,
      activation_emails_enabled: cfg['claimed_listings.activation_emails_enabled'] === true, self_request_enabled: cfg['claimed_listings.self_request_enabled'] === true,
    },
    paused_reason: cfg['claimed_listings.paused_reason'] || null, daily_cap: cfg['claimed_listings.daily_cap'],
    readiness: {
      postal_address: !!String(cfg['company.postal_address'] || '').trim(),
      ses_configuration_set: !!emailService.claimedListingConfigurationSet(),
      unsubscribe_secret: require('../lib/listingUnsubscribeToken').configured(),
      email_transport: emailService.isConfigured(),
    },
  };
}

// ── overview / rows / company ──────────────────────────────────────────────────────────────────
router.get('/overview', wrap(async (req, res) => {
  const [decisions, tiers, taskCounts, seqs, program] = await Promise.all([
    db.query(`SELECT decision, count(*)::int AS n FROM listing_outreach_eligibility_decisions GROUP BY 1 ORDER BY 2 DESC`),
    db.query(`SELECT tier, count(*)::int AS n FROM listing_outreach_scores GROUP BY 1 ORDER BY 1`),
    db.query(`SELECT task_type, count(*)::int AS n, count(*) FILTER (WHERE due_at < now())::int AS overdue FROM listing_tasks WHERE status IN ('open','in_progress') GROUP BY 1`),
    db.query(`SELECT state, count(*)::int AS n FROM listing_outreach_sequences GROUP BY 1`),
    programState(),
  ]);
  res.json({ success: true, data: { decisions: decisions.rows, tiers: tiers.rows, tasks: taskCounts.rows, sequences: seqs.rows, program } });
}));

router.get('/rows', wrap(async (req, res) => {
  const data = await toolbox.rows({ decision: req.query.decision || null, tier: req.query.tier || null, q: req.query.q || null,
    market: req.query.market || null, limit: Math.min(Number(req.query.limit) || 500, 1000) });
  res.json({ success: true, data });
}));

router.get('/company/:orgId', idParam('orgId'), wrap(async (req, res) => {
  const d = await toolbox.companyDetail(req.params.orgId);
  if (!d) return res.status(404).json({ success: false, message: 'Not found.' });
  await auditService.logEvent(db, { eventType: 'claimed_listing.row_opened', entityType: 'organization', entityId: req.params.orgId, actorId: req.user.id, metadata: {} }).catch(() => {});
  res.json({ success: true, data: d });
}));

// ── locks, notes, pause ────────────────────────────────────────────────────────────────────────
async function companyFor(orgId, actorId) {
  const id = await identity.ensureCompany('organization', orgId, { actorId });
  if (!id) throw Object.assign(new Error('Listing not found.'), { status: 404, expose: true });
  return id;
}
router.post('/company/:orgId/lock', idParam('orgId'), work, express.json(), wrap(async (req, res) => {
  const s = staff(req);
  const reassign = (req.body || {}).reassign === true;
  if (reassign && !s.isSuperAdmin) return res.status(403).json({ success: false, message: 'Only a Super Admin can reassign a lock.' });
  const lock = await locks.acquire(await companyFor(req.params.orgId, s.id), { userId: s.id, reason: (req.body || {}).reason || null, reassign, isSuperAdmin: s.isSuperAdmin });
  res.json({ success: true, data: lock });
}));
router.delete('/company/:orgId/lock', idParam('orgId'), work, wrap(async (req, res) => {
  const s = staff(req);
  res.json({ success: true, data: await locks.release(await companyFor(req.params.orgId, s.id), { userId: s.id, isSuperAdmin: s.isSuperAdmin }) });
}));
router.post('/company/:orgId/note', idParam('orgId'), work, express.json(), wrap(async (req, res) => {
  const s = staff(req);
  const b = req.body || {};
  const channel = ['email', 'phone', 'sms', 'meeting', 'mail', 'note', 'other'].includes(b.channel) ? b.channel : 'note';
  const direction = ['inbound', 'outbound', 'internal'].includes(b.direction) ? b.direction : 'internal';
  const text = String(b.body || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ success: false, message: 'Write a note first.' });
  if (direction === 'outbound') {
    // Logging outbound contact needs the company lock (one contact owner per company).
    const companyId = await companyFor(req.params.orgId, s.id);
    const c = await locks.check(companyId, { type: 'user', userId: s.id });
    if (!c.ok || !c.lock) return res.status(409).json({ success: false, code: 'LOCK_REQUIRED', message: 'Take the company lock before logging outbound contact.' });
    await locks.touch(companyId, s.id);
  }
  if (b.pro_interest === true) {
    await require('../services/claimedListings/claimEvents').record('pro_interest', { organizationId: req.params.orgId, userId: s.id, meta: { via: 'rep_logged' },
      idempotencyKey: 'pi:rep:' + req.params.orgId });
    await tasks.open({ type: 'pro_interest', organizationId: req.params.orgId, summary: 'Professional Seller interest (rep logged)', dedupeKey: 'pi:' + req.params.orgId });
  }
  const r = (await db.query(
    `INSERT INTO organization_activity (organization_id, activity_type, channel, direction, actor_id, subject, body, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id, occurred_at`,
    [req.params.orgId, direction === 'outbound' ? 'outreach' : 'note', channel, direction, s.id, String(b.subject || '').slice(0, 200) || null, text,
     JSON.stringify({ via: 'claimed_listings_toolbox' })])).rows[0];
  res.status(201).json({ success: true, data: r });
}));
router.post('/company/:orgId/pause', idParam('orgId'), work, express.json(), wrap(async (req, res) => {
  res.json({ success: true, data: await sequences.pauseSequence(req.params.orgId, { actorId: req.user.id, reason: (req.body || {}).reason || null }) });
}));

// ── journeys (Super Admin) ─────────────────────────────────────────────────────────────────────
router.post('/company/:orgId/journey', idParam('orgId'), journeyPerm, express.json(), wrap(async (req, res) => {
  const b = req.body || {};
  const companyId = await companyFor(req.params.orgId, req.user.id);
  res.json({ success: true, data: await journeys.move(companyId, { toJourney: b.journey || null, reason: b.reason, actorId: req.user.id }) });
}));

// ── removal requests: soft, reversible hide (Super Admin / listings.work) ─────────────────────
router.post('/company/:orgId/visibility', idParam('orgId'), work, express.json(), wrap(async (req, res) => {
  const hide = (req.body || {}).hidden === true;
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ success: false, message: 'Give a reason.' });
  await db.query(`UPDATE organizations SET profile_data = COALESCE(profile_data,'{}'::jsonb) || jsonb_build_object('hidden_by_request', $2::boolean, 'hidden_reason', $3::text) WHERE id = $1`,
    [req.params.orgId, hide, reason]);
  await auditService.logEvent(db, { eventType: hide ? 'organization.hidden_by_request' : 'organization.unhidden', entityType: 'organization', entityId: req.params.orgId,
    actorId: req.user.id, metadata: { reason, note: 'The directory (BD) listing is unpublished separately by the BD agent.' } });
  res.json({ success: true, hidden: hide });
}));

// ── admin-assisted claim after a phone verification (Super Admin) ─────────────────────────────
router.post('/company/:orgId/assisted-claim', idParam('orgId'), journeyPerm, express.json(), wrap(async (req, res) => {
  const b = req.body || {};
  const email = normalizeEmail(b.email || '');
  const note = String(b.verification_note || '').trim();
  if (!email) return res.status(400).json({ success: false, message: 'The new owner\'s email is required.' });
  if (note.length < 10) return res.status(400).json({ success: false, message: 'Record how ownership was verified (the call to the phone number on the listing).' });
  let user = (await db.query(`SELECT id FROM users WHERE lower(email) = $1`, [email])).rows[0];
  if (!user) {
    // An account the owner activates with "Forgot password": no password is ever chosen by staff.
    const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    user = (await db.query(`INSERT INTO users (email, password_hash, role, full_name, auth_source) VALUES ($1,$2,'buyer',$3,'admin_assisted_claim') RETURNING id`,
      [email, hash, String(b.full_name || '').trim().slice(0, 120) || null])).rows[0];
  }
  const org = await lifecycle.claim(user.id, req.params.orgId, { adminOverride: true, actorId: req.user.id });
  await db.query(`INSERT INTO organization_activity (organization_id, activity_type, channel, direction, actor_id, subject, body, metadata)
    VALUES ($1,'note','phone','outbound',$2,'Ownership verified by phone',$3,$4::jsonb)`,
    [req.params.orgId, req.user.id, note.slice(0, 2000), JSON.stringify({ via: 'assisted_claim', rule: 'called the phone number on the listing' })]);
  await claims.afterClaim({ organizationId: org.id, userId: user.id, proofMethod: 'admin_override' });
  if (b.task_id && UUID_RE.test(b.task_id)) await tasks.resolve(b.task_id, { status: 'done', resolution: 'claimed by admin after phone verification', actorId: req.user.id });
  res.status(201).json({ success: true, organization: { id: org.id, name: org.name, lifecycle_state: org.lifecycle_state } });
}));

// ── tasks ──────────────────────────────────────────────────────────────────────────────────────
router.get('/tasks', wrap(async (req, res) => {
  res.json({ success: true, data: await tasks.list({ status: req.query.status || 'open', type: req.query.type || null, limit: 300 }) });
}));
router.post('/tasks/:id', idParam('id'), work, express.json(), wrap(async (req, res) => {
  const b = req.body || {};
  const t = await tasks.resolve(req.params.id, { status: b.status || 'done', resolution: b.resolution || null, actorId: req.user.id });
  if (!t) return res.status(404).json({ success: false, message: 'Task not found.' });
  res.json({ success: true, data: t });
}));

// ── profile-change review (Super Admin) ────────────────────────────────────────────────────────
router.post('/profile-changes/:id', idParam('id'), journeyPerm, express.json(), wrap(async (req, res) => {
  const b = req.body || {};
  res.json({ success: true, data: await profileChanges.decide(req.params.id, { approve: b.approve === true, actorId: req.user.id, reason: b.reason || null }) });
}));

// ── screening, scoring, identity ───────────────────────────────────────────────────────────────
router.post('/screen', work, wrap(async (req, res) => {
  const e = await eligibility.screen({ persist: true });
  const s = await scoring.scoreAll({ persist: true });
  await auditService.logEvent(db, { eventType: 'claimed_listing.screened', entityType: 'program', entityId: null, actorId: req.user.id,
    metadata: { counts: e.counts, tiers: s.tiers } }).catch(() => {});
  res.json({ success: true, data: { screened: e.screened, counts: e.counts, tiers: s.tiers } });
}));
router.get('/identity/dry-run', wrap(async (req, res) => {
  const r = await identity.backfill({ apply: false });
  res.json({ success: true, data: Object.assign({}, r, { ambiguous: r.ambiguous.slice(0, 200), conflicts: r.conflicts.slice(0, 200) }) });
}));
router.post('/identity/apply', journeyPerm, express.json(), wrap(async (req, res) => {
  if ((req.body || {}).confirm !== 'LINK-COMPANIES') return res.status(400).json({ success: false, message: 'Confirm with LINK-COMPANIES.' });
  const r = await identity.backfill({ apply: true, actorId: req.user.id });
  res.json({ success: true, data: Object.assign({}, r, { ambiguous: undefined, conflicts: undefined }) });
}));

// ── templates, cohorts (Super Admin approves) ──────────────────────────────────────────────────
router.get('/templates', wrap(async (req, res) => {
  const rows = (await db.query(`SELECT id, template_key, version, stream, subject, preheader, body_text, status, approved_at, created_at FROM listing_outreach_templates ORDER BY template_key, version DESC`)).rows;
  res.json({ success: true, data: rows });
}));
router.post('/templates/seed', approve, wrap(async (req, res) => {
  res.json({ success: true, data: await templates.seedDrafts({ actorId: req.user.id }) });
}));
router.post('/templates/:id/approve', idParam('id'), approve, wrap(async (req, res) => {
  const t = await templates.approve(req.params.id, { actorId: req.user.id });
  if (!t) return res.status(409).json({ success: false, message: 'Only a draft can be approved.' });
  await auditService.logEvent(db, { eventType: 'claimed_listing.template_approved', entityType: 'listing_outreach_template', entityId: t.id, actorId: req.user.id,
    metadata: { key: t.template_key, version: t.version } });
  res.json({ success: true, data: t });
}));
router.get('/cohorts', wrap(async (req, res) => {
  const rows = (await db.query(
    `SELECT c.*, (SELECT count(*)::int FROM listing_outreach_cohort_members m WHERE m.cohort_id = c.id) AS members FROM listing_outreach_cohorts c ORDER BY c.created_at DESC`)).rows;
  res.json({ success: true, data: rows });
}));
router.post('/cohorts/propose', work, express.json(), wrap(async (req, res) => {
  const b = req.body || {};
  res.status(201).json({ success: true, data: await sequences.proposeCohort({ name: b.name, size: b.size, actorId: req.user.id,
    repUserId: UUID_RE.test(b.rep_user_id || '') ? b.rep_user_id : null }) });
}));
router.post('/cohorts/:id/templates', idParam('id'), approve, express.json(), wrap(async (req, res) => {
  res.json({ success: true, data: await sequences.bindTemplates(req.params.id, (req.body || {}).template_versions || {}, { actorId: req.user.id }) });
}));
router.post('/cohorts/:id/approve', idParam('id'), approve, wrap(async (req, res) => {
  res.json({ success: true, data: await sequences.approveCohort(req.params.id, { actorId: req.user.id }) });
}));
router.post('/cohorts/:id/status', idParam('id'), approve, express.json(), wrap(async (req, res) => {
  const b = req.body || {};
  res.json({ success: true, data: await sequences.setCohortStatus(req.params.id, b.status, { actorId: req.user.id, reason: b.reason || null }) });
}));
router.post('/cohorts/:id/shadow', idParam('id'), work, wrap(async (req, res) => {
  const r = await sequences.shadowRun(req.params.id);
  res.json({ success: true, data: Object.assign({}, r, { results: r.results.slice(0, 100) }) });
}));

// ── program switches (Super Admin; ship OFF) ───────────────────────────────────────────────────
router.get('/program', wrap(async (req, res) => res.json({ success: true, data: await programState() })));
router.post('/program', approve, express.json(), wrap(async (req, res) => {
  const b = req.body || {};
  const changes = {};
  for (const k of ['sending_enabled', 'inbound_enabled', 'activation_emails_enabled', 'self_request_enabled']) {
    if (typeof b[k] === 'boolean') changes['claimed_listings.' + k] = b[k];
  }
  if (typeof b.postal_address === 'string') changes['company.postal_address'] = b.postal_address.trim().slice(0, 300);
  if (b.clear_pause === true) changes['claimed_listings.paused_reason'] = null;
  if (!Object.keys(changes).length) return res.status(400).json({ success: false, message: 'Nothing to change.' });
  if (changes['claimed_listings.sending_enabled'] === true && (String(b.confirm || '') !== 'START-CLAIMED-LISTING-OUTREACH')) {
    return res.status(400).json({ success: false, message: 'Turning sending on requires the confirmation phrase.' });
  }
  for (const [k, v] of Object.entries(changes)) {
    await db.query(`INSERT INTO platform_config (key, value, category) VALUES ($1, $2::jsonb, 'claimed_listings')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [k, JSON.stringify(v)]);
  }
  await auditService.logEvent(db, { eventType: 'claimed_listing.program_changed', entityType: 'program', entityId: null, actorId: req.user.id, metadata: { changes } });
  res.json({ success: true, data: await programState() });
}));

// ── gate preview for one listing (read-only) ───────────────────────────────────────────────────
router.get('/company/:orgId/gate', idParam('orgId'), wrap(async (req, res) => {
  const o = (await db.query(`SELECT contact_email FROM organizations WHERE id = $1`, [req.params.orgId])).rows[0];
  if (!o) return res.status(404).json({ success: false });
  const m = (await db.query(`SELECT cohort_id FROM listing_outreach_cohort_members WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.params.orgId])).rows[0];
  res.json({ success: true, data: await sendGate.evaluate({ organizationId: req.params.orgId, cohortId: m ? m.cohort_id : null, recipientEmail: o.contact_email, stepKey: 'E1' }) });
}));

router.get('/funnel', wrap(async (req, res) => res.json({ success: true, data: await funnelSvc.funnel({ includeInternal: req.query.internal === '1' }) })));

module.exports = router;
