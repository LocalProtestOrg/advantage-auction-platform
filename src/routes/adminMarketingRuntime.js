'use strict';

/**
 * /api/admin/marketing-runtime — Super-Admin inspection + control of the Phase 3O execution runtime:
 * NEEDS_OWNER queue, obligation state history, channel readiness, the Desktop Marketing bridge (runtime
 * export + validated proposal intake), and a manual shadow monitor tick. Super-Admin-only (confidential
 * runtime + economics). Reuses the certified Admin Action Required SMS for NEEDS_OWNER (fired by the engine).
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const readiness = require('../services/channelReadinessService');
const bridge = require('../services/desktopBridgeService');
const worker = require('../services/marketingFulfillmentWorker');
const contract = require('../services/phase3oContract');

router.use(auth, role(['admin']));

router.get('/needs-owner', async (req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT id, purchase_kind, purchase_id, auction_id, obligation_key, feature_key, needs_owner_reason, needs_owner_options, deadline_at, updated_at
         FROM marketing_obligations WHERE state='needs_owner' ORDER BY updated_at DESC`)).rows;
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

router.get('/obligations/:id/events', async (req, res, next) => {
  try {
    const events = (await db.query(`SELECT * FROM marketing_obligation_events WHERE obligation_id=$1 ORDER BY created_at ASC`, [req.params.id])).rows;
    const ob = (await db.query(`SELECT * FROM marketing_obligations WHERE id=$1`, [req.params.id])).rows[0];
    return res.json({ success: true, data: { obligation: ob, events } });
  } catch (err) { next(err); }
});

router.get('/readiness', async (req, res, next) => {
  try { return res.json({ success: true, data: await readiness.phase3oMatrix() }); } catch (err) { next(err); }
});

// Build + return an anonymized RUNTIME_EXPORT (vs_to_desktop). Persisted; never contains PII.
router.post('/runtime-export', async (req, res, next) => {
  try { return res.json({ success: true, data: await bridge.buildRuntimeExport((req.body || {}).window_label) }); } catch (err) { next(err); }
});

// Ingest a Desktop → VS structured proposal (validated + routed to a controlled path; never applied live).
router.post('/desktop-proposal', async (req, res, next) => {
  try { return res.json({ success: true, data: await bridge.ingestProposal(req.body || {}, req.user.id) }); } catch (err) { next(err); }
});

router.get('/desktop-messages', async (req, res, next) => {
  try { return res.json({ success: true, data: (await db.query(`SELECT id, message_id, direction, message_type, schema_valid, applies_via, status, created_at FROM marketing_desktop_messages ORDER BY created_at DESC LIMIT 100`)).rows }); }
  catch (err) { next(err); }
});

// Manual shadow monitor tick (admin-triggered).
router.post('/tick', async (req, res, next) => {
  try { return res.json({ success: true, data: await worker.tick() }); } catch (err) { next(err); }
});

// Bounded Director decisions for a purchase (internal; evidence_line never shown to sellers).
router.get('/decisions/:purchaseId', async (req, res, next) => {
  try { return res.json({ success: true, data: await require('../services/directorDecisionService').listForPurchase(req.params.purchaseId) }); }
  catch (err) { next(err); }
});

// Paid-allocation balance + reconciliation (confidential; never seller-facing).
router.get('/allocations/:purchaseId', async (req, res, next) => {
  try {
    const alloc = require('../services/paidAllocationBridge');
    const balance = await alloc.getBalance(req.params.purchaseId);
    const reconciliation = balance ? await alloc.reconcile(req.params.purchaseId) : null;
    return res.json({ success: true, data: { balance, reconciliation } });
  } catch (err) { next(err); }
});

// Contract catalogue (features/recipes/ladders) read from the authoritative pack.
router.get('/contract', async (req, res, next) => {
  try { return res.json({ success: true, data: { features: contract.features().length, recipes: contract.recipes().length, ladders: Object.keys(contract.ladders()) } }); }
  catch (err) { next(err); }
});

// ── Wave 2 channel execution (Super-Admin; internal — no seller-facing economics) ──

// Director-resolved authoritative inputs for a purchase (auction/dates/catalog/geo/audiences/readiness/authority).
router.get('/inputs/:purchaseId', async (req, res, next) => {
  try { return res.json({ success: true, data: await require('../services/directorInputResolver').resolveInputs(req.params.purchaseId) }); }
  catch (err) { next(err); }
});

// Truthful campaign performance aggregation feeding the seller allowlist renderer (classified; shadow excluded).
router.get('/performance/:purchaseId', async (req, res, next) => {
  try {
    const engine = require('../services/marketingObligationEngine');
    const perf = require('../services/performanceAggregationService');
    const obligations = await engine.listForPurchase('package', req.params.purchaseId).catch(() => []);
    const data = await perf.aggregate({ purchaseKind: 'package', purchaseId: req.params.purchaseId, obligations, auctionFacts: {} });
    return res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── Meta organic social destinations (multi-market registry) — Super-Admin; NEVER returns/accepts a token ──
router.get('/social-destinations', async (req, res, next) => {
  try { return res.json({ success: true, data: await require('../services/socialReadinessService').evaluate() }); }
  catch (err) { next(err); }
});

// ── Phase 3P Owner Creative Reference System (Super-Admin) — index, retrieval preview, review queue, Owner feedback ──
router.get('/creative-references', async (req, res, next) => {
  try {
    const idx = require('../services/creativeReference/indexer').loadIndex();
    return res.json({ success: true, data: { index_version: idx.index_version, built_at: idx.built_at, counts: idx.counts, empty_classes: idx.empty_classes, seller_concentration: idx.seller_concentration,
      references: idx.references.map((r) => ({ reference_id: r.reference_id, owner_status: r.owner_status, owner_weight: r.owner_weight, campaign_class_primary: r.campaign_class_primary, nearest_advantage_family: r.nearest_advantage_family, seller: r.seller, path: r.path, stub: r.stub })), tasks: idx.tasks || [], problems: idx.problems || [] } });
  } catch (err) { next(err); }
});
router.post('/creative-references/reindex', async (req, res, next) => {
  try { const out = await require('../services/creativeReference/indexer').buildIndex({ db }); return res.json({ success: true, data: { index_version: out.index.index_version, counts: out.index.counts, tasks: out.tasks, foreign: out.foreign, problems: out.problems, sidecars_written: out.sidecarsWritten } }); }
  catch (err) { next(err); }
});
router.get('/creative-references/retrieve', async (req, res, next) => {
  try {
    const q = req.query || {}; const idx = require('../services/creativeReference/indexer').loadIndex();
    const out = require('../services/creativeReference/retriever').retrieve(idx, { campaign_class: String(q.campaign_class || 'auction'), event_mode: q.event_mode || null, merchandise_breadth: q.merchandise_breadth || null, format_class: q.format_class || null, seller_hierarchy: q.seller_hierarchy || null, requested_family: q.family || null, tags: q.tags ? String(q.tags).split(',') : [] });
    return res.json({ success: true, data: { ...out, retrieved: out.retrieved.map((r) => ({ reference_id: r.reference_id, score: r.score, relevance: r.relevance, facet_similarity: r.facet_similarity, lessons: r.transferable_lessons })), neutral_fallback: out.neutral_fallback.map((r) => ({ reference_id: r.reference_id, score: r.score, lessons: r.transferable_lessons })) } });
  } catch (err) { next(err); }
});
// Generated creatives awaiting the Owner (no images inline — paths + facts; renders live beside the packet).
router.get('/creative-reviews', async (req, res, next) => {
  try {
    const rows = (await db.query(`SELECT creative_job_id, candidate_key, campaign_class, family, format, score, decision, owner_review_required, publication_status, render_path, created_at FROM marketing_creative_calibrations ORDER BY created_at DESC LIMIT 200`)).rows;
    const reviews = (await db.query(`SELECT creative_job_id, candidate_key, status, owner_words, note, created_at FROM marketing_creative_owner_reviews ORDER BY created_at DESC LIMIT 200`)).rows;
    return res.json({ success: true, data: { candidates: rows, reviews } });
  } catch (err) { next(err); }
});
// Owner feedback in the Owner's own words (buttons map to the same words): good / love this / gold standard / don't use / come back 10% on the title.
router.post('/creative-reviews', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.creative_job_id || !b.words) return res.status(400).json({ success: false, message: 'creative_job_id and words are required' });
    const out = await require('../services/creativeReference/feedbackLedger').recordOwnerReview({ creativeJobId: String(b.creative_job_id), candidateKey: b.candidate_key ? String(b.candidate_key) : null, words: String(b.words).slice(0, 500), recordedBy: 'admin-ui:' + req.user.id, db });
    return res.json({ success: true, data: out });
  } catch (err) { next(err); }
});

// ── Organic social INTELLIGENCE (insights ingestion / engagement governance / webhook) — read-only status ──
router.get('/social-intelligence', async (req, res, next) => {
  try {
    const insights = require('../services/socialInsightsService');
    const engagement = require('../services/socialEngagementService');
    const webhook = require('../services/metaWebhookService');
    const learning = require('../services/socialLearningService');
    return res.json({ success: true, data: {
      insights: await insights.status(), engagement: await engagement.summary(null, { sinceDays: 30 }), webhook: await webhook.status(),
      learning: { minimum_sample: learning.MIN_SAMPLE, material_relative_diff: learning.MATERIAL_RELATIVE_DIFF, dimensions: learning.DIMENSIONS },
    } });
  } catch (err) { next(err); }
});
// Intelligence switches (NOT the publishing gates — those stay Owner activation decisions). Booleans only.
const INTELLIGENCE_SWITCHES = ['marketing.social.insights_enabled', 'marketing.social.reply_draft_enabled'];
router.put('/social-intelligence/switch', async (req, res, next) => {
  try {
    const b = req.body || {}; const key = String(b.key || '');
    if (INTELLIGENCE_SWITCHES.indexOf(key) === -1) return res.status(400).json({ success: false, message: 'Not an editable intelligence switch' });
    if (typeof b.value !== 'boolean') return res.status(400).json({ success: false, message: 'value must be boolean' });
    await require('../services/configService').setPlatformConfig(key, b.value);
    return res.json({ success: true, data: { key, value: b.value } });
  } catch (err) { next(err); }
});
// Manual bounded ingestion tick (read-only toward Meta; inert unless the insights switch is ON and REAL posts exist).
router.post('/social-intelligence/tick', async (req, res, next) => {
  try {
    const insights = require('../services/socialInsightsService');
    return res.json({ success: true, data: { posts: await insights.runOnce({ max: 10 }), accounts: await insights.snapshotAccounts() } });
  } catch (err) { next(err); }
});
// Read-only identity check of ONE destination: does the referenced token resolve the configured account id?
// Never enumerates /me/accounts (so other portfolio assets are never touched); never returns the token.
router.post('/social-destinations/:id/verify', async (req, res, next) => {
  try {
    const svc = require('../services/socialDestinationService');
    const dest = await svc.getById(req.params.id);
    if (!dest) return res.status(404).json({ success: false, message: 'Destination not found' });
    const provider = require('../services/metaGraphProvider').buildProvider(dest);
    const out = await provider.verifyIdentity();
    const detail = { ...(dest.readiness_detail || {}), identity_check: { at: new Date().toISOString(), ok: out.ok, resolved_id: out.resolved_id || null, name: out.name || null, error: out.error || null } };
    if (out.ok && dest.platform === 'facebook' && out.linked_instagram_business_account_id) detail.identity_check.linked_instagram_business_account_id = out.linked_instagram_business_account_id;
    await svc.setReadiness(dest.id, dest.readiness_status, detail);
    return res.json({ success: true, data: { destination_id: dest.id, ...out } });
  } catch (err) { next(err); }
});
// Upsert a destination (Page ID / IG account ID / credential ENV NAME / scope / active). Rejects raw secrets.
router.post('/social-destinations', async (req, res, next) => {
  try {
    const b = req.body || {};
    // Defense in depth: never let a token-looking value be stored as an identifier or credential_ref.
    for (const [k, v] of Object.entries(b)) {
      if (typeof v === 'string' && v.length > 80 && /[A-Za-z0-9]{40,}/.test(v)) {
        return res.status(400).json({ success: false, message: `Field ${k} looks like a secret. Store the token as a Railway env var and reference its NAME in credential_ref.` });
      }
    }
    const svc = require('../services/socialDestinationService');
    const saved = await svc.upsert({
      id: b.id, platform: b.platform, scope: b.scope, stateCode: b.stateCode, marketKey: b.marketKey, label: b.label,
      providerAccountId: b.providerAccountId, linkedFacebookPageId: b.linkedFacebookPageId,
      credentialRef: b.credentialRef, priority: b.priority, active: b.active,
    });
    return res.json({ success: true, data: svc.toAdminView(saved) });
  } catch (err) { next(err); }
});

// Channel-execution evidence for a purchase's obligations (placement/email/social) — DISTINGUISHES shadow.
router.get('/evidence/:purchaseId', async (req, res, next) => {
  try {
    const engine = require('../services/marketingObligationEngine');
    const obs = await engine.listForPurchase('package', req.params.purchaseId).catch(() => []);
    const ids = obs.map((o) => o.id);
    if (!ids.length) return res.json({ success: true, data: { placement: [], editions: [], dedicated: [], social: [] } });
    const placement = (await db.query(`SELECT obligation_id, feature_key, impressions, clicks, first_seen_at, last_seen_at, days, shadow FROM marketing_placement_evidence WHERE obligation_id = ANY($1)`, [ids])).rows;
    const cards = (await db.query(`SELECT c.edition_id, c.auction_id, c.position, c.delivered, c.clicks, e.shadow FROM marketing_email_edition_cards c JOIN marketing_email_editions e ON e.edition_id=c.edition_id WHERE c.obligation_id = ANY($1)`, [ids])).rows;
    const dedicated = (await db.query(`SELECT obligation_id, chosen_scope, recipient_count, audience_floor, status, shadow FROM marketing_dedicated_sends WHERE obligation_id = ANY($1)`, [ids])).rows;
    const social = (await db.query(`SELECT obligation_id, wave, provider, status, post_id, permalink, published_at, shadow FROM marketing_social_jobs WHERE obligation_id = ANY($1)`, [ids])).rows;
    return res.json({ success: true, data: { placement, cards, dedicated, social } });
  } catch (err) { next(err); }
});

// ── Phase 3P.2 measurement readiness + Paid Growth Director (SHADOW) + assisted service (Super-Admin) ──
// Nothing here spends, activates a channel or contacts an advertising provider. Cost import records spend facts only.
router.get('/measurement-readiness', async (req, res, next) => {
  try { return res.json({ success: true, data: await require('../services/measurement/measurementReadinessService').evaluate(db) }); }
  catch (err) { next(err); }
});
router.get('/conversions/summary', async (req, res, next) => {
  try {
    const oa = require('../services/measurement/outcomeAttributionService');
    const byKey = (await db.query(`SELECT conversion_key, count(*)::int n, max(occurred_at) last_at FROM marketing_conversion_events GROUP BY 1 ORDER BY 1`)).rows;
    const dispatch = (await db.query(`SELECT provider_dispatch->'meta_capi'->>'status' meta, provider_dispatch->'google_ads'->>'status' google, count(*)::int n FROM marketing_conversion_events GROUP BY 1,2`)).rows;
    return res.json({ success: true, data: { by_key: byKey, by_class: await oa.classTotals({}, db), provider_dispatch: dispatch } });
  } catch (err) { next(err); }
});
router.post('/paid-growth/run-shadow', async (req, res, next) => {
  try { return res.json({ success: true, data: await require('../services/paidGrowth/paidGrowthDirector').runShadow({ month: (req.body && req.body.month) || undefined, persist: true }, db) }); }
  catch (err) { next(err); }
});
router.post('/paid-growth/evaluate', async (req, res, next) => {
  try { return res.json({ success: true, data: await require('../services/paidGrowth/paidGrowthDirector').evaluateCampaigns({}, db) }); }
  catch (err) { next(err); }
});
router.get('/paid-growth/proposals', async (req, res, next) => {
  try {
    const month = String((req.query && req.query.month) || new Date().toISOString().slice(0, 7)).slice(0, 7) + '-01';
    const rows = (await db.query(`SELECT * FROM marketing_paid_growth_proposals WHERE month=$1::date ORDER BY created_at DESC`, [month])).rows;
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});
router.get('/paid-growth/report', async (req, res, next) => {
  try {
    const rep = require('../services/paidGrowth/paidGrowthReport');
    const kind = String((req.query && req.query.kind) || 'monthly');
    const data = kind === 'weekly' ? await rep.weekly({}, db) : kind === 'state_changes' ? await rep.stateChanges({}, db) : await rep.monthly({ month: req.query && req.query.month ? String(req.query.month).slice(0, 7) : undefined }, db);
    return res.json({ success: true, data });
  } catch (err) { next(err); }
});
router.post('/paid-growth/cost-import', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!['meta_ads', 'google_ads'].includes(b.provider) || !Array.isArray(b.rows)) return res.status(400).json({ success: false, message: 'provider (meta_ads | google_ads) and rows[] are required' });
    return res.json({ success: true, data: await require('../services/measurement/paidCostIngestionService').ingest(b.provider, b.rows.slice(0, 5000), db) });
  } catch (err) { next(err); }
});
router.post('/paid-growth/reconcile', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.provider || !b.campaign_key || !b.window_start || !b.window_end) return res.status(400).json({ success: false, message: 'provider, campaign_key, window_start and window_end are required' });
    return res.json({ success: true, data: await require('../services/measurement/providerReconciliationService').reconcile({ provider: b.provider, campaignKey: b.campaign_key, windowStart: b.window_start, windowEnd: b.window_end, note: b.note || null }, db) });
  } catch (err) { next(err); }
});
router.get('/assisted-service-inquiries', async (req, res, next) => {
  try { return res.json({ success: true, data: await require('../services/assistedServiceService').list({ status: (req.query && req.query.status) || null, limit: req.query && req.query.limit }, db) }); }
  catch (err) { next(err); }
});
router.patch('/assisted-service-inquiries/:id', async (req, res, next) => {
  try {
    const out = await require('../services/assistedServiceService').setStatus(req.params.id, req.body && req.body.status, db);
    if (!out) return res.status(400).json({ success: false, message: 'status must be new, contacted, evaluating or closed' });
    return res.json({ success: true, data: out });
  } catch (err) { next(err); }
});

module.exports = router;
