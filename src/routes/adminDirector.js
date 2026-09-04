'use strict';

/**
 * Marketing Director operating bridge. Mounted at /api/admin/director. This is the SAFE authenticated
 * surface Desktop Marketing (A1) uses — it may reason, but PRODUCTION services decide whether an action is
 * allowed. Desktop never mutates tables directly; every write goes through a service + the execution
 * authorization gate. RBAC: read = members.view; consequential writes = Super Admin. NO mass-send; ONLY
 * onsite may become authorized (email/Google/Meta hard-gated OFF).
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const rbac = require('../lib/rbac');
const db = require('../db');
const opportunityService = require('./../services/opportunityService');
const director = require('./../services/marketingDirectorService');
const report = require('./../services/directorReportService');
const targetingQa = require('./../services/targetingQaService');
const execAuth = require('./../services/executionAuthorizationService');
const growthBridge = require('./../services/growthBridgeService');
const membership = require('./../services/audienceMembershipService');
const learningService = require('./../services/marketingLearningService');
const onsite = require('./../services/onsiteService');
const baseline = require('./../services/baselineReportService');
const marketDx = require('./../services/marketDiagnosisService');
const auctionDx = require('./../services/liveAuctionDiagnosisService');
const crmRanking = require('./../services/crmRankingService');
const platformFacts = require('./../services/platformFactAudienceService');

router.use(express.json());
router.use(auth, requirePermission('members.view'));
function superOnly(req, res, next) { if (!rbac.isSuperAdmin(req.user)) return res.status(403).json({ success: false, message: 'Super Admin required' }); next(); }

// ── READ ──
router.get('/opportunities', async (req, res, next) => {
  try {
    const rows = (await db.query(`SELECT id, opportunity_type, objective, subject_ref, size_estimate, time_criticality,
      influenceability, status, decline_reason, rank_index, ranking_reason, detected_at
      FROM marketing_opportunities ORDER BY (status='ranked') DESC, rank_index ASC NULLS LAST, detected_at DESC LIMIT 100`)).rows;
    res.json({ success: true, opportunities: rows });
  } catch (e) { next(e); }
});
router.post('/opportunities/detect', superOnly, async (req, res, next) => {
  try { res.json({ success: true, ...(await opportunityService.detectAndPersist()) }); } catch (e) { next(e); }
});
router.get('/audiences/summary', async (req, res, next) => {
  try { res.json({ success: true, audiences: await director.allBriefs() }); } catch (e) { next(e); }
});
router.get('/report', async (req, res, next) => {
  try { res.json({ success: true, report: await report.generate(), crossover: await report.crossoverReadiness() }); } catch (e) { next(e); }
});
router.get('/readiness', async (req, res, next) => {
  try {
    res.json({ success: true, channels: {
      onsite: await execAuth.channelEnabled('onsite'),
      a7_email: await execAuth.channelEnabled('a7_email'),
      google_ads: await execAuth.channelEnabled('google_ads'),
      meta: await execAuth.channelEnabled('meta'),
    }, crossover: await report.crossoverReadiness() });
  } catch (e) { next(e); }
});
router.get('/qa/:audienceKey', async (req, res, next) => {
  try { res.json({ success: true, qa: await targetingQa.reviewTargeting({ audienceKey: req.params.audienceKey, channel: req.query.channel || 'onsite' }) }); }
  catch (e) { next(e); }
});

// ── READ: 4H evidence surfaces ──
router.get('/baseline', async (req, res, next) => {
  try { res.json({ success: true, baseline: await baseline.latest(), subscriber_placement: await baseline.subscriberPlacement() }); } catch (e) { next(e); }
});
router.get('/market-diagnosis', async (req, res, next) => {
  try { res.json({ success: true, markets: await marketDx.diagnoseAll() }); } catch (e) { next(e); }
});
router.get('/auction-diagnosis', async (req, res, next) => {
  try { res.json({ success: true, auctions: await auctionDx.diagnoseCurrent() }); } catch (e) { next(e); }
});
router.get('/crm-ranking', async (req, res, next) => {
  try { res.json({ success: true, ...(await crmRanking.rank({ limit: 50 })) }); } catch (e) { next(e); }
});
// Director DAILY readiness — the "is the engine alive + what's actionable today" aggregate.
router.get('/daily', async (req, res, next) => {
  try {
    const counts = await membership.counts();
    const q = async (sql) => Number((await db.query(sql)).rows[0].n);
    const eventsToday = await q(`SELECT count(*)::int n FROM analytics_events WHERE received_at > now() - interval '24 hours'`);
    const eventsWithVisitor = await q(`SELECT count(*)::int n FROM analytics_events WHERE visitor_id IS NOT NULL AND received_at > now() - interval '24 hours'`);
    const identityLinks = await q(`SELECT count(*)::int n FROM behavioral_identity_links`);
    const signals = await q(`SELECT count(*)::int n FROM marketing_signals WHERE active=true`);
    const onsiteToday = await q(`SELECT count(*)::int n FROM marketing_onsite_treatments WHERE shown_at > now() - interval '24 hours'`);
    res.json({ success: true, daily: {
      behavioral_events_24h: eventsToday, behavioral_events_24h_with_visitor: eventsWithVisitor,
      identity_links: identityLinks, active_signals: signals, onsite_treatments_24h: onsiteToday,
      audiences: counts,
      registered_non_bidder: counts['registered_non_bidder'] || 0,
      watcher_no_bid: counts['watcher_no_bid'] || 0,
      local_event_interest: counts['local_event_interest'] || 0,
      abandoned_seller_signup: counts['abandoned_individual_seller_signup'] || 0,
      watcher_ending_soon_transactional: 'wired (marketing.watcher_ending_soon.enabled)',
      engine_receiving_input: eventsWithVisitor > 0,
    } });
  } catch (e) { next(e); }
});

// ── WRITE / ACTION (Super Admin; all pass production enforcement) ──
router.post('/baseline/snapshot', superOnly, async (req, res, next) => {
  try { res.json({ success: true, ...(await baseline.snapshot()) }); } catch (e) { next(e); }
});
router.post('/platform-facts/refresh', superOnly, async (req, res, next) => {
  try { res.json({ success: true, refreshed: await platformFacts.refreshAll() }); } catch (e) { next(e); }
});
router.post('/decisions', superOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const decision = await opportunityService.createDecision({
      opportunityId: b.opportunity_id, decision: b.decision, decisionReason: b.decision_reason,
      objective: b.objective, audienceKey: b.audience_key, channel: b.channel, evidence: b.evidence,
      hypothesis: b.hypothesis, outcomeDefinition: b.outcome_definition, stopCondition: b.stop_condition,
      scaleCondition: b.scale_condition, exclusions: b.exclusions, createdBy: 'A1',
    });
    res.json({ success: true, decision });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
router.post('/experiments/preregister', superOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const size = b.audience_key ? ((await membership.counts())[b.audience_key] || 0) : (b.audience_size || 0);
    const out = await growthBridge.preregister({ hypothesis: b.hypothesis, objective: b.objective,
      campaignClass: b.campaign_class, audienceKey: b.audience_key, audienceSize: size,
      channels: b.channels || [], proposedByAgent: b.proposed_by_agent || 'A1', preregFields: b.prereg || {} });
    res.status(out.ok ? 200 : 422).json({ success: out.ok, ...out });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
router.post('/onsite/authorize', superOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const authz = await execAuth.authorize({ channel: 'onsite', scopeType: 'visitor', scopeId: b.visitor_id,
      pagePath: b.path, decisionId: b.decision_id });
    res.json({ success: true, authorization: authz });
  } catch (e) { next(e); }
});
router.post('/learning', superOnly, async (req, res, next) => {
  try { const b = req.body || {}; res.json({ success: true, learning: await learningService.record(b) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

module.exports = router;
