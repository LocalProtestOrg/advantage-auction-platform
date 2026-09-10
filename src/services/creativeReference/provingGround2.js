'use strict';

/**
 * creativeReference/provingGround2 — Phase 3P.1 + 3P.2 generation order for proving grounds (NON-PUBLISHING):
 *   classify → retrieve (Gold weighting, imagery-only, structures) → principles (ranges, no prop checklist, no logo
 *   style) → media decision (events) → copy (title style by role, approved messages, lexicon, claim manifest) → brief
 *   (validated) → render (EDITORIAL / EVENT_PHOTO; scene planned + physically audited; logo stage composites the
 *   registered asset) → QA (logo_source, rendered_logo_elsewhere, G11 incl. Golds + Owner negative signatures (τ_neg),
 *   G12 seller-mark, G13 provenance, capitalization hygiene, copy density, colour, prominence, event type, coverage,
 *   template echo) → judge v2 → scorer v2 → persist (calibrations + signatures + job) → Owner review packet.
 * Every candidate is HELD FOR OWNER REVIEW; a calibration extreme is NOT FOR PUBLICATION (sidecar label only).
 * A9 and every destination gate are asserted OFF; no publishing, destination or send job is ever created here.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./library');
const indexer = require('./indexer');
const retriever = require('./retriever');
const principles = require('./principles');
const gates = require('./gates');
const bridge = require('./engineBridge');
const judgeSvc = require('./judge');
const scorerV2 = require('./scorerV2');
const titleCase = require('./titleCase');
const messages = require('./campaignMessages');
const density = require('./copyDensity');
const variation = require('./variation');
const feedbackRecords = require('./feedbackRecords');
const { referenceSignatures, configNumbers } = require('./provingGround');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const GATE_KEYS = ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled', 'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled'];
const COPY_ROLES = { headline: 'headline', subheadline: 'subheadline', support: 'support', cta: 'cta', help: 'help', availability: 'availability', eyebrow: 'eyebrow', slogan: 'slogan',
  disclosure: 'disclosure', label: 'label', item_title: 'headline', event_type: 'event_type', event_title: 'event_title', modifier: 'major_label', date: 'date_day_label', time: 'session_hours',
  place_plate: 'place_name', presenter: 'presenter', relationship: 'major_label', lot_number: 'label', catalogue_size: 'support' };

// Drawn boxes are one per rendered LINE. Consecutive lines of the same role are one string (a headline wrapped onto two
// lines — "Have Items / to Sell?" — is judged as "Have Items to Sell?", never as a line that "ends" with "to").
function mapDrawnRoles(boxes) {
  const out = [];
  for (const b of (boxes || []).filter((x) => x.text)) {
    const last = out[out.length - 1];
    if (last && last.role === b.role && ['headline', 'subheadline', 'event_title', 'event_type'].includes(b.role)) last.text += ' ' + b.text;
    else out.push({ text: b.text, role: b.role });
  }
  return out;
}

async function gateState(cfg) {
  const s = {}; for (const k of GATE_KEYS) s[k] = await cfg.getBool(k, false);
  if (Object.values(s).some(Boolean)) throw new Error('refused: a publish/destination gate is ON — proving grounds run only with every gate OFF');
  return s;
}

/**
 * p: { jobId, title, campaignClass, need, brief, candidates:[{key, family, structure, profile, spec, extreme, market, factFields,
 *      generic, expect, objects}], formats, db, cfg, judge, outDir, index, cobrandSeller, anchorPath, mediaDecision, previous, omissions, tauNeg }
 */
async function run(p) {
  const db = p.db || null; const cfg = p.cfg || require('../marketingConfigService');
  const gs = await gateState(cfg);
  const nums = await configNumbers(cfg);
  const tauNeg = p.tauNeg || 0.30;
  const index = p.index || indexer.loadIndex();
  const marks = lib.sellerMarksFrom(index.references.map((r) => ({ json: { source: { seller: r.seller }, do_not_generalize: r.do_not_generalize } })));
  const approvedAll = messages.allApprovedTexts();
  const wording = marks.wording.filter((w) => !approvedAll.some((a) => a.toLowerCase().replace(/[.!?]+$/, '') === w.toLowerCase().replace(/[.!?]+$/, '')));
  fs.mkdirSync(p.outDir, { recursive: true });

  const retrieval = retriever.retrieve(index, Object.assign({ owner_review_required: true }, p.need));
  const calibration = principles.buildCalibration(index, retrieval, Object.assign({}, p.need, { family: p.need.family || 'ACQUISITION' }), marks);
  const bar = retrieval.has_gold_standard ? Math.max(nums.barGold, retrieval.accept_bar || 75) : nums.bar;
  const brief = Object.assign({}, p.brief, { calibration, campaign_class: p.campaignClass, seller_hierarchy: p.need.seller_hierarchy, media_decision: p.mediaDecision || null });
  const briefHash = crypto.createHash('sha256').update(JSON.stringify(brief)).digest('hex');

  const refSigs = await referenceSignatures(index, { db });
  const negSigs = db ? await feedbackRecords.negativeSignatures(db, p.campaignClass) : [];
  let anchorSig = null;
  if (p.anchorPath && fs.existsSync(p.anchorPath)) { const r = await bridge.signatures([p.anchorPath]); anchorSig = r.ok ? r.signatures[p.anchorPath] : null; }
  let selfSigs = [];
  if (db) selfSigs = (await db.query(`SELECT s.subject_id AS id, s.signature FROM marketing_creative_layout_signatures s WHERE s.subject_kind='creative' AND s.polarity='positive' AND s.campaign_class=$1 AND s.subject_id NOT LIKE $2 ORDER BY s.created_at DESC LIMIT 5`, [p.campaignClass, p.jobId + ':%'])).rows;
  if (db) await db.query(`INSERT INTO marketing_creative_jobs (job_id, auction_id, status, request) VALUES ($1,$2,'review',$3::jsonb) ON CONFLICT (job_id) DO UPDATE SET status='review', request=EXCLUDED.request, updated_at=now()`,
    [p.jobId, brief.auction_id || brief.event_id || null, JSON.stringify({ proving_ground: true, phase: '3P.1+3P.2', campaign_class: p.campaignClass, brief_hash: briefHash, index_version: index.index_version, formats: p.formats })]);

  const results = []; const candidateSigs = []; const blocked = [];
  for (const c of p.candidates) {
    // ── copy: title style by role (approved messages keep canonical casing) → rules → claim manifest ──
    const roles = Object.fromEntries(Object.keys(c.spec.copy || {}).map((k) => [k, COPY_ROLES[k] || k]));
    const cased = titleCase.applyToCopy(c.spec.copy, roles, { approved: approvedAll, uppercaseDisplay: (c.spec.options || {}).headline_case === 'uppercase_display' });
    const copyCheck = messages.validateCopy({ campaignClass: p.campaignClass, copy: cased.copy, roles, manifest: brief.claim_manifest || [], factFields: c.factFields || [], market: c.market || null });
    if (!copyCheck.pass) { blocked.push({ key: c.key, stage: 'copy/claims', rejections: copyCheck.rejections }); continue; }
    for (const fmt of (p.formats || ['portrait_1080x1350'])) {
      const out = path.join(p.outDir, `${p.jobId}-${c.key}-${fmt}.png`);
      // The candidate's copy profile reaches the engine (its density slots differ per profile, e.g. RESTRAINED_FACTUAL).
      const spec = Object.assign({ profile: c.profile }, c.spec, { copy: cased.copy, format: fmt, out_png: out });
      const render = await bridge.call({ op: 'render', family: c.family, spec }, { timeoutMs: 900000 });
      if (!render || !render.ok) { results.push({ key: c.key, format: fmt, ok: false, error: render && render.error }); continue; }
      const m = render.metrics;
      const sigRes = await bridge.signatures([out]); const candidateSig = sigRes.ok ? sigRes.signatures[out] : null;
      const siblings = c.extreme ? [] : candidateSigs.filter((x) => x.key !== c.key && x.format === fmt && !x.extreme).map((x) => ({ id: x.id, signature: x.signature }));
      const sim = candidateSig ? gates.antiSimilarity({ candidateSig, referenceSigs: refSigs, selfSigs: (c.extreme ? [] : selfSigs).concat(siblings), anchorSig, tau: nums.tau }) : { pass: false, failures: ['signature unavailable'] };
      const negD = candidateSig ? negSigs.map((n) => ({ id: n.id, distance: bridge.distance(candidateSig, n.signature) })) : [];
      const negMin = negD.length ? negD.reduce((a, b) => (b.distance < a.distance ? b : a)) : null;
      const negCheck = { nearest: negMin, tau_neg: tauNeg, hard: !!(negMin && negMin.distance < tauNeg / 2), penalty: !!(negMin && negMin.distance < tauNeg) };
      const leak = gates.sellerMarkLeak({ drawnText: render.drawn_text, sellerMarks: marks.seller_marks, wording, cobrandSeller: p.cobrandSeller || null, ocr: null });
      const prov = gates.provenanceGate(brief);
      const hyg = titleCase.hygiene(mapDrawnRoles(render.boxes), { uppercaseDisplay: (c.spec.options || {}).headline_case === 'uppercase_display' });
      const dens = density.gate(c.profile, m.density, m, { scriptAccents: c.spec.band_script ? 1 : 0 });
      const echo = variation.templateEcho(c.objects || []);
      const lq = render.logo_qa || {};
      const plan = render.plan || null;
      if (plan) m.planes_count = new Set((plan.objects || []).map((o) => o.plane)).size;
      const judge = p.judge !== false ? await judgeSvc.judgeV2({ pngPath: out, profile: calibration.principle_profile, family: c.family, campaignClass: p.campaignClass, generic: !!c.generic, expect: c.expect || {} })
        : { available: false, reason: 'judge disabled for this run' };
      const coverageFamily = c.spec.coverage_family || (m.family === 'RESTRAINED_FACTUAL' ? 'RESTRAINED_FACTUAL' : (c.family === 'EVENT_PHOTO' ? 'ENVIRONMENTAL_PHOTO' : 'ACQUISITION'));
      const measurable = scorerV2.scoreMeasurable(m, { family: coverageFamily, profile: c.profile, scene: (c.spec.scene || {}).kind || (c.family === 'EVENT_PHOTO' ? 'photo' : null) });
      const checks = {
        blocking: {
          physical_audit: { pass: !(m.physical_violations || []).length, detail: (m.physical_violations || []).map((v) => v.kind + ':' + v.id) },
          coverage: { pass: m.coverage_gate.pass_, detail: m.coverage_gate.hard_failures },
          colour: { pass: m.colour.pass_, detail: m.colour.hard_failures },
          logo_source: { pass: !!(lq.logo_source && lq.logo_source.pass_), detail: lq.logo_source },
          rendered_logo_elsewhere: { pass: !!(lq.rendered_logo_elsewhere && lq.rendered_logo_elsewhere.pass_), detail: lq.rendered_logo_elsewhere && lq.rendered_logo_elsewhere.ocr_hits },
          negative_signature: { pass: !negCheck.hard, detail: negCheck.nearest },
          copy_density: { pass: dens.pass, detail: dens.hard },
          G11_anti_similarity: sim, G12_seller_mark_leak: leak, G13_provenance: prov,
          judge_physical: { pass: !(judge.available && (judge.physical_yes.through || judge.physical_yes.wrong_size)), detail: judge.available ? judge.physical_yes : 'judge unavailable' },
          judge_masquerade: { pass: !(judge.available && c.generic && judge.comprehension.masquerade === true), detail: 'generic creative must not look like real items from a specific sale' },
        },
        regenerate: {
          identity_prominence: { pass: m.prominence.pass_ !== false && !(m.prominence.violations || []).length || !!c.extreme, detail: m.prominence.violations },
          event_type: { pass: (m.event_type.violations || []).length === 0, detail: m.event_type.violations },
          capitalization: { pass: hyg.pass, detail: hyg.violations },
          template_echo: { pass: !echo.flagged, detail: echo.props },
          negative_proximity: { pass: !negCheck.penalty, detail: negCheck.nearest },
          judge_comprehension: { pass: !(judge.available && c.expect && ((c.expect.event_type && judge.comprehension.event_type_ok === false) || judge.comprehension.platform_ok === false)), detail: judge.available ? judge.comprehension : 'judge unavailable' },
        },
      };
      const fin = scorerV2.finalize({ measurable, judge, checks, bar, regenerateFloor: nums.regen, extreme: !!c.extreme, ownerReviewRequired: true });
      const renderSha = sha(out);
      const rec = { key: c.key, format: fmt, family: c.family, structure: c.structure, profile: c.profile, ok: true, png: out, thumb: render.thumb, render_sha256: renderSha,
                    metrics: m, logo: render.logo, logo_qa: lq, plan, copy_changes: cased.changes, copy_check: copyCheck, hygiene: hyg, density: dens, template_echo: echo,
                    similarity: sim, negative_signature_check: negCheck, leak, provenance: prov, judge, measurable, score: fin.score, decision: fin.decision,
                    hard_failures: fin.hard_failures, regenerate_violations: fin.regenerate_violations, score_basis: fin.score_basis, bar, extreme: !!c.extreme,
                    publication_status: c.extreme ? 'NOT_FOR_PUBLICATION' : 'HELD_FOR_OWNER_REVIEW', market: c.market || null, notes: c.notes || null };
      results.push(rec);
      if (candidateSig) candidateSigs.push({ id: `${p.jobId}:${c.key}:${fmt}`, key: c.key, format: fmt, signature: candidateSig, extreme: !!c.extreme });
      if (db) {
        await db.query(`INSERT INTO marketing_creative_calibrations (creative_job_id, candidate_key, campaign_class, family, format, seller, index_version, retrieved, principle_profile, do_not_copy, brief, metrics, judge, hard_checks, similarity, score, score_breakdown, decision, owner_review_required, publication_status, render_path, render_sha256, scorer_version, judge_model, prompt_version,
             structure, copy_profile, media_decision, scene_plan, physical_audit, coverage, prominence, event_type_check, capitalization, colour, copy_density, logo_composite, logo_qa, negative_signature_check, claim_check)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17::jsonb,$18,true,$19,$20,$21,$22,$23,$24,
             $25,$26,$27::jsonb,$28::jsonb,$29::jsonb,$30::jsonb,$31::jsonb,$32::jsonb,$33::jsonb,$34::jsonb,$35::jsonb,$36::jsonb,$37::jsonb,$38::jsonb,$39::jsonb)
           ON CONFLICT (creative_job_id, candidate_key, format) DO UPDATE SET metrics=EXCLUDED.metrics, judge=EXCLUDED.judge, hard_checks=EXCLUDED.hard_checks, similarity=EXCLUDED.similarity, score=EXCLUDED.score, score_breakdown=EXCLUDED.score_breakdown,
             decision=EXCLUDED.decision, publication_status=EXCLUDED.publication_status, render_path=EXCLUDED.render_path, render_sha256=EXCLUDED.render_sha256, scorer_version=EXCLUDED.scorer_version, judge_model=EXCLUDED.judge_model, prompt_version=EXCLUDED.prompt_version,
             structure=EXCLUDED.structure, copy_profile=EXCLUDED.copy_profile, media_decision=EXCLUDED.media_decision, scene_plan=EXCLUDED.scene_plan, physical_audit=EXCLUDED.physical_audit, coverage=EXCLUDED.coverage, prominence=EXCLUDED.prominence,
             event_type_check=EXCLUDED.event_type_check, capitalization=EXCLUDED.capitalization, colour=EXCLUDED.colour, copy_density=EXCLUDED.copy_density, logo_composite=EXCLUDED.logo_composite, logo_qa=EXCLUDED.logo_qa, negative_signature_check=EXCLUDED.negative_signature_check, claim_check=EXCLUDED.claim_check`,
          [p.jobId, c.key, p.campaignClass, c.family, fmt, p.cobrandSeller || 'Advantage.Bid', index.index_version, JSON.stringify(retrieval.retrieved.map((r) => ({ reference_id: r.reference_id, weight: r.owner_weight, imagery_only: r.imagery_only, sidecar_hash: r.sidecar_hash }))),
           JSON.stringify(calibration.principle_profile), JSON.stringify(calibration.do_not_copy), JSON.stringify(Object.assign({}, brief, { brief_hash: briefHash, copy: cased.copy })), JSON.stringify(m), JSON.stringify(judge), JSON.stringify(checks), JSON.stringify(sim),
           fin.score, JSON.stringify({ measurable, judge_points: fin.judge_points, hard_failures: fin.hard_failures, regenerate_violations: fin.regenerate_violations }), fin.decision, rec.publication_status, out, renderSha, fin.scorer_version, judge.model || null, judge.prompt_version || null,
           c.structure || null, c.profile || null, JSON.stringify(p.mediaDecision || null), JSON.stringify(plan), JSON.stringify(plan ? plan.audit : null), JSON.stringify(m.coverage), JSON.stringify(m.prominence), JSON.stringify(m.event_type),
           JSON.stringify({ changes: cased.changes, hygiene: hyg }), JSON.stringify(m.colour), JSON.stringify(dens), JSON.stringify(render.logo), JSON.stringify(lq), JSON.stringify(negCheck), JSON.stringify(copyCheck)]);
        if (candidateSig) await db.query(`INSERT INTO marketing_creative_layout_signatures (subject_kind, subject_id, family, seller, campaign_class, signature, polarity) VALUES ('creative',$1,$2,$3,$4,$5::jsonb,'positive') ON CONFLICT (subject_kind, subject_id) DO UPDATE SET signature=EXCLUDED.signature`,
          [`${p.jobId}:${c.key}:${fmt}`, c.family, p.cobrandSeller || 'Advantage.Bid', p.campaignClass, JSON.stringify(candidateSig)]);
      }
    }
  }
  if (db) await db.query(`UPDATE marketing_creative_jobs SET result=$2::jsonb, runtime_version=$3, updated_at=now() WHERE job_id=$1`,
    [p.jobId, JSON.stringify({ proving_ground: true, candidates: results.map((r) => ({ key: r.key, format: r.format, score: r.score, decision: r.decision, publication_status: r.publication_status })), blocked }), '3P.1+3P.2']);
  const packet = { job_id: p.jobId, campaign_class: p.campaignClass, title: p.title, index_version: index.index_version, gates: gs, no_publish: true, bar,
    retrieval: { confidence: retrieval.confidence, empty_class: retrieval.empty_class, has_gold_standard: retrieval.has_gold_standard, structures_seen: retrieval.structures_seen, imagery_only: retrieval.imagery_only, pending_promotion: retrieval.pending_promotion,
                 retrieved: retrieval.retrieved.map((r) => ({ reference_id: r.reference_id, owner_status: r.owner_status, weight: r.owner_weight, relevance: r.relevance, imagery_only: r.imagery_only, structure: r.structure })) },
    calibration, media_decision: p.mediaDecision || null, anchor: p.anchorPath ? { path: p.anchorPath } : null, omissions: p.omissions || [], deferred: p.deferred || null,
    previous: p.previous || [], blocked, results };
  fs.writeFileSync(path.join(p.outDir, `${p.jobId}-packet.json`), JSON.stringify(packet, (k, v) => (k === 'signature' ? undefined : v), 1));
  return packet;
}

module.exports = { run, COPY_ROLES, GATE_KEYS, mapDrawnRoles };
