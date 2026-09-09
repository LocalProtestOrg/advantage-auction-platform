'use strict';

/**
 * creativeReference/provingGround — runs the Phase 3P generation order for a set of candidates WITHOUT publishing:
 *   classify → retrieve → principles → facts/assets → brief (validated) → family → generate (Python family engine)
 *   → audit profile → QA (text budget, provenance, seller-mark, anti-similarity) → judge → score → decide → persist
 *   (marketing_creative_jobs + calibrations + signatures) → Owner review packet (HTML + JSON beside the renders).
 * Every candidate is HELD FOR OWNER REVIEW; a calibration extreme is NOT FOR PUBLICATION. A9 and every destination
 * gate are asserted OFF and no publishing/destination job is ever created here.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./library');
const indexer = require('./indexer');
const retriever = require('./retriever');
const principles = require('./principles');
const gates = require('./gates');
const scorer = require('./scorer');
const judgeSvc = require('./judge');
const bridge = require('./engineBridge');
const briefValidator = require('./briefValidator');

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function configNumbers(cfg) {
  const get = async (k, d) => { try { const v = await cfg.raw(k, d); const n = Number(v); return Number.isFinite(n) ? n : d; } catch (_) { return d; } };
  return { bar: await get('marketing.creative.calibration.accept_bar', 70), barGold: await get('marketing.creative.calibration.accept_bar_gold', 75), regen: await get('marketing.creative.calibration.regenerate_floor', 50),
           tau: { tau_ref: await get('marketing.creative.similarity.tau_ref', 0.35), tau_self: await get('marketing.creative.similarity.tau_self', 0.25), tau_pub: await get('marketing.creative.similarity.tau_pub', 0.40) } };
}

/** Signatures for every active library reference (computed by Python; cached in the DB when a runner is given). */
async function referenceSignatures(index, { db, root } = {}) {
  root = root || lib.LIBRARY_ROOT;
  const refs = index.references.filter((r) => r.owner_status !== 'RETIRED');
  const out = []; const missing = [];
  for (const r of refs) {
    let sig = null;
    if (db) { const row = (await db.query(`SELECT signature FROM marketing_creative_layout_signatures WHERE subject_kind='reference' AND subject_id=$1`, [r.sha256])).rows[0]; if (row) sig = row.signature; }
    if (!sig) missing.push(r);
    else out.push({ id: r.reference_id, sha256: r.sha256, signature: sig });
  }
  if (missing.length) {
    const paths = missing.map((r) => path.join(root, r.path));
    const res = await bridge.signatures(paths);
    if (res.ok) for (const r of missing) {
      const sig = res.signatures[path.join(root, r.path)] || res.signatures[paths[missing.indexOf(r)]];
      if (!sig) continue;
      out.push({ id: r.reference_id, sha256: r.sha256, signature: sig });
      if (db) await db.query(`INSERT INTO marketing_creative_layout_signatures (subject_kind, subject_id, family, seller, campaign_class, signature) VALUES ('reference',$1,$2,$3,$4,$5::jsonb) ON CONFLICT (subject_kind, subject_id) DO NOTHING`, [r.sha256, r.nearest_advantage_family, r.seller, r.campaign_class_primary, JSON.stringify(sig)]);
    }
  }
  return out;
}

/**
 * Run one proving ground.
 * @param p { jobId, campaignClass, need, brief, candidates:[{key, family, renderSpec, extreme, textProfile}], anchorPath, outDir,
 *            provingGround:true, cobrandSeller, db, cfg, judge (bool), index (optional), sellerHierarchy }
 */
async function run(p) {
  const db = p.db || null; const cfg = p.cfg || require('../marketingConfigService');
  const nums = await configNumbers(cfg);
  const index = p.index || indexer.loadIndex();
  const sidecarsForMarks = index.references.map((r) => ({ json: { source: { seller: r.seller }, do_not_generalize: r.do_not_generalize } }));
  const marks = lib.sellerMarksFrom(sidecarsForMarks);
  fs.mkdirSync(p.outDir, { recursive: true });

  // Gates asserted OFF (publishing is untouched; the packet records the state).
  const gateState = {};
  for (const k of ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled', 'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled']) gateState[k] = await cfg.getBool(k, false);

  // 1–3. classify / retrieve / principles
  const retrieval = retriever.retrieve(index, Object.assign({ owner_review_required: true }, p.need));
  const calibration = principles.buildCalibration(index, retrieval, Object.assign({}, p.need, { family: p.candidates[0].family }), marks);
  const bar = retrieval.has_gold_standard ? nums.barGold : nums.bar;

  // 4. brief (validated; never carries a reference image)
  const brief = Object.assign({}, p.brief, { calibration, campaign_class: p.campaignClass, seller_hierarchy: p.need.seller_hierarchy });
  const libHashes = new Set(index.references.map((r) => r.sha256));
  const bv = briefValidator.validateBrief(brief, { libraryHashes: libHashes });
  if (!bv.valid) throw new Error('brief invalid: ' + bv.errors.join('; '));
  const briefHash = crypto.createHash('sha256').update(JSON.stringify(brief)).digest('hex');

  // anti-similarity inputs
  const refSigs = await referenceSignatures(index, { db });
  let anchorSig = null, anchorSha = null;
  if (p.anchorPath && fs.existsSync(p.anchorPath)) { const r = await bridge.signatures([p.anchorPath]); anchorSig = r.ok ? r.signatures[p.anchorPath] : null; anchorSha = sha256File(p.anchorPath); }
  let selfSigs = [];
  // Prior ACCEPTED creatives of the same seller × class (never this job's own rows — a re-run must not fail against itself).
  if (db) selfSigs = (await db.query(`SELECT s.subject_id, s.signature FROM marketing_creative_layout_signatures s JOIN marketing_creative_calibrations c ON c.creative_job_id || ':' || c.candidate_key || ':' || c.format = s.subject_id WHERE s.subject_kind='creative' AND s.seller IS NOT DISTINCT FROM $1 AND s.campaign_class=$2 AND s.subject_id NOT LIKE $3 AND c.publication_status IN ('OWNER_APPROVED','HELD_FOR_OWNER_REVIEW') AND c.decision IN ('ACCEPT','OWNER_REVIEW') ORDER BY s.created_at DESC LIMIT 5`, [p.cobrandSeller || 'Advantage.Bid', p.campaignClass, p.jobId + ':%'])).rows.map((r) => ({ id: r.subject_id, signature: r.signature }));

  if (db) await db.query(`INSERT INTO marketing_creative_jobs (job_id, auction_id, status, request) VALUES ($1,$2,'review',$3::jsonb) ON CONFLICT (job_id) DO UPDATE SET status='review', request=EXCLUDED.request, updated_at=now()`,
    [p.jobId, brief.auction_id || brief.event_id || null, JSON.stringify({ proving_ground: true, campaign_class: p.campaignClass, brief_hash: briefHash, index_version: index.index_version, formats: p.formats })]);

  const results = [];
  const candidateSigs = [];
  for (const c of p.candidates) {
    for (const fmt of (p.formats || ['portrait_1080x1350'])) {
      const out = path.join(p.outDir, `${p.jobId}-${c.key}-${fmt}.png`);
      const spec = Object.assign({}, c.renderSpec, { format: fmt, out_png: out });
      const render = await bridge.render(c.family === 'ENVIRONMENTAL_PHOTO' ? 'ENVIRONMENTAL_PHOTO' : 'ACQUISITION', spec);
      if (!render.ok) { results.push({ key: c.key, format: fmt, ok: false, error: render.error }); continue; }
      const m = render.metrics;
      const band = principles.bandFor(c.family, index);
      const textProfile = c.textProfile || 'GENERAL';
      // ── gates ──
      const budget = gates.textBudget(textProfile, m.text_blocks, brief.text_budget && brief.text_budget.logistics_reason);
      const leak = gates.sellerMarkLeak({ drawnText: render.drawn_text, sellerMarks: marks.seller_marks, wording: marks.wording, cobrandSeller: p.cobrandSeller || null });
      const prov = gates.provenanceGate(brief);
      const sigRes = await bridge.signatures([out]); const candidateSig = sigRes.ok ? sigRes.signatures[out] : null;
      // Siblings in this run count as prior creatives for A/B; a calibration EXTREME is its parent pushed past the band by
      // design, so it is checked against references + the published anchor only (it can never publish).
      const siblings = c.extreme ? [] : candidateSigs.filter((x) => x.key !== c.key && x.format === fmt && !x.extreme).map((x) => ({ id: x.id, signature: x.signature }));
      const sim = candidateSig ? gates.antiSimilarity({ candidateSig, referenceSigs: refSigs, selfSigs: (c.extreme ? [] : selfSigs).concat(siblings), anchorSig, tau: nums.tau }) : { pass: false, failures: ['signature unavailable'] };
      const audit = { profile: c.family === 'ENVIRONMENTAL_PHOTO' ? 'environmental' : 'acquisition', violations: [] };
      if (c.family === 'ENVIRONMENTAL_PHOTO') { if (m.copy_over_merchandise && m.copy_over_merchandise.length) audit.violations.push('copy over merchandise: ' + m.copy_over_merchandise.join(' | ')); if (!m.place_plate_ok) audit.violations.push('place plate exceeds 6% of the canvas'); if (m.panel_contrast < 4.5) audit.violations.push('panel contrast below 4.5:1'); }
      if (c.family === 'ACQUISITION') { if (!m.representative) audit.violations.push('representative flag missing'); if (m.copy_over_merchandise && m.copy_over_merchandise.length) audit.violations.push('copy over merchandise: ' + m.copy_over_merchandise.join(' | ')); if (!render.drawn_text.some((t) => /representative/i.test(t))) audit.violations.push('representative disclosure not rendered'); }
      if (!m.brand_frame || !m.brand_frame.band || !m.brand_frame.wordmark) audit.violations.push('brand frame incomplete');
      // ── judge (portrait only, to bound cost) + score ──
      const measurable = scorer.scoreMeasurable(m, band, { family: c.family, textProfile, eventFamily: c.family === 'ENVIRONMENTAL_PHOTO' });
      const judge = p.judge !== false ? await judgeSvc.judge({ pngPath: out, profile: calibration.principle_profile, family: c.family, campaignClass: p.campaignClass }) : { available: false, reason: 'judge disabled for this run' };
      const hardChecks = { G11_anti_similarity: sim, G12_seller_mark_leak: leak, G13_provenance: prov, text_budget: budget, audit: { pass: audit.violations.length === 0, failures: audit.violations } };
      const review = gates.ownerReviewRequired({ emptyClass: retrieval.empty_class, provingGround: !!p.provingGround, retrievalRequires: retrieval.owner_review_required });
      const fin = scorer.finalize({ measurable, judge, hardChecks, bar, regenerateFloor: nums.regen, extreme: !!c.extreme, ownerReviewRequired: review.required });
      const renderSha = sha256File(out);
      const rec = { key: c.key, format: fmt, family: c.family, ok: true, png: out, thumb: render.thumb, render_sha256: renderSha, metrics: m, audit, budget, leak, provenance: prov, similarity: sim, judge, measurable, score: fin.score, decision: fin.decision, hard_failures: fin.hard_failures, score_basis: fin.score_basis, bar, owner_review: review, extreme: !!c.extreme, publication_status: c.extreme ? 'NOT_FOR_PUBLICATION' : 'HELD_FOR_OWNER_REVIEW', drawn_text: render.drawn_text, references_used: calibration.reference_ids, principles_applied: calibration.principle_profile.transferable_lessons, assets: c.assets || [] };
      results.push(rec);
      if (candidateSig) candidateSigs.push({ id: `${p.jobId}:${c.key}:${fmt}`, key: c.key, format: fmt, signature: candidateSig, extreme: !!c.extreme });
      if (db) {
        await db.query(`INSERT INTO marketing_creative_calibrations (creative_job_id, candidate_key, campaign_class, family, format, seller, index_version, retrieved, principle_profile, do_not_copy, brief, metrics, judge, hard_checks, similarity, score, score_breakdown, decision, owner_review_required, publication_status, render_path, render_sha256, scorer_version, judge_model, prompt_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25)
           ON CONFLICT (creative_job_id, candidate_key, format) DO UPDATE SET metrics=EXCLUDED.metrics, judge=EXCLUDED.judge, hard_checks=EXCLUDED.hard_checks, similarity=EXCLUDED.similarity, score=EXCLUDED.score, score_breakdown=EXCLUDED.score_breakdown, decision=EXCLUDED.decision, render_path=EXCLUDED.render_path, render_sha256=EXCLUDED.render_sha256`,
          [p.jobId, c.key, p.campaignClass, c.family, fmt, p.cobrandSeller || 'Advantage.Bid', index.index_version, JSON.stringify((retrieval.empty_class ? retrieval.neutral_fallback : retrieval.retrieved).map((r) => ({ reference_id: r.reference_id, weight: r.owner_weight, score: r.score, sidecar_hash: r.sidecar_hash }))),
           JSON.stringify(calibration.principle_profile), JSON.stringify(calibration.do_not_copy), JSON.stringify(Object.assign({}, brief, { brief_hash: briefHash })), JSON.stringify(m), JSON.stringify(judge), JSON.stringify(hardChecks), JSON.stringify(sim), fin.score, JSON.stringify({ measurable, judge_points: fin.judge_points, basis: fin.score_basis }), fin.decision, review.required, rec.publication_status, out, renderSha, scorer.SCORER_VERSION, judge.model || null, judge.prompt_version || null]);
        if (candidateSig) await db.query(`INSERT INTO marketing_creative_layout_signatures (subject_kind, subject_id, family, seller, campaign_class, signature) VALUES ('creative',$1,$2,$3,$4,$5::jsonb) ON CONFLICT (subject_kind, subject_id) DO UPDATE SET signature=EXCLUDED.signature`, [`${p.jobId}:${c.key}:${fmt}`, c.family, p.cobrandSeller || 'Advantage.Bid', p.campaignClass, JSON.stringify(candidateSig)]);
      }
    }
  }
  if (anchorSig && db) await db.query(`INSERT INTO marketing_creative_layout_signatures (subject_kind, subject_id, family, seller, campaign_class, signature) VALUES ('anchor',$1,$2,$3,$4,$5::jsonb) ON CONFLICT (subject_kind, subject_id) DO NOTHING`, [anchorSha, 'published_anchor', p.cobrandSeller || null, p.campaignClass, JSON.stringify(anchorSig)]);
  if (db) await db.query(`UPDATE marketing_creative_jobs SET result=$2::jsonb, runtime_version=$3, updated_at=now() WHERE job_id=$1`, [p.jobId, JSON.stringify({ proving_ground: true, candidates: results.map((r) => ({ key: r.key, format: r.format, score: r.score, decision: r.decision, publication_status: r.publication_status, render_sha256: r.render_sha256 })) }), 'p3p-' + scorer.SCORER_VERSION]);

  const packet = { job_id: p.jobId, campaign_class: p.campaignClass, title: p.title, index_version: index.index_version, gates: gateState, no_publish: true,
    retrieval: { confidence: retrieval.confidence, empty_class: retrieval.empty_class, owner_review_required: retrieval.owner_review_required, retrieved: (retrieval.empty_class ? retrieval.neutral_fallback : retrieval.retrieved).map((r) => ({ reference_id: r.reference_id, score: r.score, lessons: r.transferable_lessons, neutral: !!r.neutral })), excluded_by_avoid_for: retrieval.excluded_by_avoid_for, seller_concentration: retrieval.seller_concentration, strip_seller_identity: retrieval.strip_seller_identity },
    calibration, brief_hash: briefHash, brief, anchor: p.anchorPath ? { path: p.anchorPath, sha256: anchorSha, note: 'currently published — external — not generated; scorer-only negative anchor' } : null,
    omissions: p.omissions || [], results, bar };
  fs.writeFileSync(path.join(p.outDir, `${p.jobId}-packet.json`), JSON.stringify(packet, null, 1));
  return packet;
}

module.exports = { run, referenceSignatures, configNumbers };
