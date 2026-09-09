'use strict';

/**
 * creativeReference/gates — Phase 3P QA gates after the existing G0–G9:
 *   G11 anti-similarity   (layout-signature distance ≥ τ_ref to every library reference, ≥ τ_self to the seller×class's
 *                          last five accepted creatives, ≥ τ_pub to a published anchor when supplied)          HARD FAIL
 *   G12 seller-mark leak  (every string drawn on the render vs the seller-mark blocklist minus the brief's own
 *                          cobrand seller; logo template match reported as unavailable when no templates exist)   HARD FAIL
 *   G13 merchandise provenance (objects' auction_id = brief; photographs / representative assets carry provenance;
 *                          representative only in acquisition/brand classes)                                     HARD FAIL
 *   G14 Owner review       (empty classes, first 3 creatives of a new family, every proving ground)               HOLD
 *   G10 is the calibration score (scorer.js).
 */
const { distance } = require('./engineBridge');

const REPRESENTATIVE_CLASSES = ['individual_seller_acquisition', 'professional_seller_acquisition', 'buyer_platform_growth', 'general_brand'];
const DEFAULT_TAU = { tau_ref: 0.35, tau_self: 0.25, tau_pub: 0.40 };

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim(); }

/** G12. drawnText: every string rendered; sellerMarks: blocklist; cobrandSeller: the brief's own seller (allowed). */
function sellerMarkLeak({ drawnText = [], sellerMarks = [], wording = [], cobrandSeller = null, ocr = null, logoTemplates = null }) {
  const allowed = new Set([cobrandSeller, cobrandSeller && cobrandSeller.replace(/&/g, 'and')].filter(Boolean).map(norm));
  const texts = drawnText.map(norm).concat((ocr && ocr.text ? [norm(ocr.text)] : []));
  const hits = [];
  for (const m of sellerMarks) {
    const nm = norm(m); if (!nm || allowed.has(nm)) continue;
    if (nm === 'l&m' || nm.length < 4) continue;                  // too short to test safely as a substring
    if (texts.some((t) => t.includes(nm))) hits.push({ kind: 'seller_mark', value: m });
  }
  for (const w of wording) { const nw = norm(w); if (nw && texts.some((t) => t.includes(nw))) hits.push({ kind: 'reference_wording', value: w }); }
  return { pass: hits.length === 0, hits, ocr: ocr ? 'available' : 'unavailable (no OCR engine in the runtime image; every drawn string is checked exactly)',
           logo_template_match: logoTemplates && logoTemplates.length ? 'checked' : 'not_available (no seller logo templates on file)' };
}

/** G13. brief: { auction_id, merchandise_mode, campaign_class, objects[], site_photographs[], representative_assets[] } */
function provenanceGate(brief) {
  const reasons = [];
  const mode = brief.merchandise_mode;
  if (mode === 'lots') {
    if (!Array.isArray(brief.objects) || !brief.objects.length) reasons.push('lots mode requires objects');
    for (const o of (brief.objects || [])) { if (o.auction_id !== brief.auction_id) reasons.push(`object ${o.lot_id} belongs to auction ${o.auction_id}, not ${brief.auction_id}`); if (o.fidelity !== 'CLEAN') reasons.push(`object ${o.lot_id} fidelity ${o.fidelity} (CLEAN required)`); }
  }
  if (mode === 'photograph') {
    if (!Array.isArray(brief.site_photographs) || !brief.site_photographs.length) reasons.push('photograph mode requires site_photographs');
    for (const p of (brief.site_photographs || [])) { if (!p.provenance_row_id && !p.provenance) reasons.push(`photograph ${p.asset_id} has no provenance`); if (p.event_id && brief.event_id && p.event_id !== brief.event_id) reasons.push(`photograph ${p.asset_id} bound to another event`); }
  }
  if (mode === 'representative') {
    if (!REPRESENTATIVE_CLASSES.includes(brief.campaign_class)) reasons.push(`representative imagery is not permitted in class ${brief.campaign_class}`);
    for (const a of (brief.representative_assets || [])) { if (a.representative_not_lots !== true) reasons.push(`asset ${a.asset_id} not flagged representative_not_lots`); if (!a.rights) reasons.push(`asset ${a.asset_id} has no rights statement`); }
    if (!Array.isArray(brief.representative_assets) || !brief.representative_assets.length) reasons.push('representative mode requires representative_assets');
  }
  if (mode !== 'representative' && Array.isArray(brief.representative_assets) && brief.representative_assets.length) reasons.push('representative assets present outside representative mode');
  if (brief.screenshot && !brief.screenshot.provenance) reasons.push('screenshot without provenance');
  return { pass: reasons.length === 0, reasons };
}

/** G11. candidateSig vs reference sigs / self sigs / anchor sig. */
function antiSimilarity({ candidateSig, referenceSigs = [], selfSigs = [], anchorSig = null, tau = DEFAULT_TAU }) {
  const refD = referenceSigs.map((r) => ({ id: r.id, distance: distance(candidateSig, r.signature) }));
  const selfD = selfSigs.map((r) => ({ id: r.id, distance: distance(candidateSig, r.signature) }));
  const minRef = refD.length ? refD.reduce((m, x) => (x.distance < m.distance ? x : m)) : null;
  const minSelf = selfD.length ? selfD.reduce((m, x) => (x.distance < m.distance ? x : m)) : null;
  const pub = anchorSig ? distance(candidateSig, anchorSig) : null;
  const failures = [];
  if (minRef && minRef.distance < tau.tau_ref) failures.push(`too close to reference ${minRef.id} (${minRef.distance} < τ_ref ${tau.tau_ref})`);
  if (minSelf && minSelf.distance < tau.tau_self) failures.push(`too close to prior creative ${minSelf.id} (${minSelf.distance} < τ_self ${tau.tau_self})`);
  if (pub != null && pub < tau.tau_pub) failures.push(`too close to the published anchor (${pub} < τ_pub ${tau.tau_pub})`);
  return { pass: failures.length === 0, failures, max_reference: minRef, self_history_min: minSelf, published_anchor_distance: pub, thresholds: tau, all_reference_distances: refD };
}

/** G14. */
function ownerReviewRequired({ emptyClass, provingGround, familyPriorCount, retrievalRequires }) {
  const reasons = [];
  if (emptyClass) reasons.push('campaign class has no Owner-approved reference');
  if (provingGround) reasons.push('proving ground — Owner review mandatory');
  if (familyPriorCount != null && familyPriorCount < 3) reasons.push('one of the first three creatives of this family');
  if (retrievalRequires) reasons.push('retrieval flagged owner_review_required');
  return { required: reasons.length > 0, reasons };
}

/** Text budget by profile (mirrors the shipped 5-block rule; LOGISTICS 7 needs a reason; TEASER 3). */
function textBudget(profile, blocks, logisticsReason) {
  const max = { GENERAL: 5, LOGISTICS: 7, TEASER: 3 }[profile || 'GENERAL'] || 5;
  const reasons = [];
  if (profile === 'LOGISTICS' && !logisticsReason) reasons.push('LOGISTICS profile requires logistics_reason');
  if (blocks > max) reasons.push(`${blocks} copy blocks > ${max} (${profile || 'GENERAL'})`);
  return { pass: reasons.length === 0, max, blocks, reasons };
}

module.exports = { sellerMarkLeak, provenanceGate, antiSimilarity, ownerReviewRequired, textBudget, REPRESENTATIVE_CLASSES, DEFAULT_TAU };
