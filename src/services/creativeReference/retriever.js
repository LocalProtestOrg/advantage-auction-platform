'use strict';

/**
 * creativeReference/retriever — Deliverable 6 §2. Deterministic, campaign-aware retrieval over index.json.
 *   score = owner_weight × relevance(class) × facet_similarity(need)      top-5, ties by reference_id
 *   relevance: primary 1.0 · secondary 0.5 · family-compatible-only 0.25 · else 0
 *   avoid_for is a hard exclusion (class keyword match); DO_NOT_USE references are returned separately as negatives.
 *   Empty class → [] + confidence LOW + owner_review_required + global profile (class-neutral lessons at 0.25).
 *   Seller concentration > 60% → strip_seller_identity (logged on the result).
 * Stub records (no visual read yet) are never retrieved: they carry no transferable lessons.
 */
const RELEVANCE = { primary: 1.0, secondary: 0.5, family: 0.25 };
const FACET_WEIGHTS = { event_mode: 0.25, nearest_advantage_family: 0.25, merchandise_breadth: 0.2, format_class: 0.1, seller_hierarchy: 0.1, tags: 0.1 };
const TOP_N = 5;
const SELLER_CONCENTRATION_MAX = 0.6;
// Keywords by which an avoid_for phrase names a campaign class. Phase 3P.2: acquisition classes are told apart — a bare
// "acquisition" names all three; "seller acquisition" names both seller classes; "individual seller" / "professional
// seller" / "buyer growth" name one. A phrase that restricts COPY ("… copy", "… wording") keeps the reference for
// imagery/layout evidence (imagery_only) instead of excluding it.
const CLASS_KEYWORDS = {
  estate_sale: ['estate sale', 'estate-sale', 'estate sales'], auction: ['broad auction', 'broad estate auction', 'general auction', 'online-only auction', 'online auction', 'any auction'],
  notable_lot: ['single-lot', 'single lot', 'notable lot', 'spotlight'], closing_soon: ['closing-soon', 'closing soon', 'closing'],
  individual_seller_acquisition: ['individual seller', 'individual-seller', 'seller acquisition', 'seller-acquisition', 'seller/buyer acquisition'],
  professional_seller_acquisition: ['professional seller', 'professional-seller', 'seller acquisition', 'seller-acquisition', 'seller/buyer acquisition'],
  buyer_platform_growth: ['buyer growth', 'buyer-growth', 'buyer acquisition', 'seller/buyer acquisition'],
  general_brand: ['brand'], geographic_event_promotion: ['geographic', 'regional'],
};
const ACQ_CLASSES = ['individual_seller_acquisition', 'professional_seller_acquisition', 'buyer_platform_growth'];
const BRAND_SELLER = 'Advantage.Bid';
// Structures the Owner's references show (variation-requirements.json structures_seen_3p2 + the 3P environmental set).
let _structureMap = null;
function structureMap() {
  if (_structureMap) return _structureMap;
  _structureMap = { 'REF-09': 'ENVIRONMENTAL_FULL_BLEED', 'REF-10': 'ENVIRONMENTAL_FULL_BLEED' };
  try {
    const v = require('../../../docs/marketing/phase3p2/config/variation-requirements.json');
    for (const list of Object.values(v.rules.structures_seen_3p2 || {})) {
      for (const entry of list) {
        const st = (entry.match(/^[A-Z_]+/) || [null])[0]; const m = entry.match(/REF-(\d+)(?:\/(\d+))*/g) || [];
        for (const grp of m) { const nums = grp.replace('REF-', '').split('/'); for (const n of nums) if (st) _structureMap['REF-' + n] = st; }
        const extra = entry.match(/REF-(\d+)\/(\d+)(?:\/(\d+))?/);
        if (extra && st) for (const n of extra.slice(1).filter(Boolean)) _structureMap['REF-' + n] = st;
      }
    }
  } catch (_) { /* config optional in unit tests */ }
  return _structureMap;
}
// Class-neutral lessons used when a class is empty (facets the Owner's taste expresses regardless of class).
const NEUTRAL_TAGS = ['breadth', 'warm-light', 'light-ground', 'scene', 'minimal-copy', 'material-typography', 'factual-cta', 'footer-band'];

function phraseNames(s, campaignClass) {
  const kws = CLASS_KEYWORDS[campaignClass] || [campaignClass.replace(/_/g, ' ')];
  if (kws.some((k) => s.includes(k))) return true;
  // a bare "acquisition" (no seller/buyer qualifier) names every acquisition class
  return ACQ_CLASSES.includes(campaignClass) && /\bacquisition\b/.test(s) && !/(seller|buyer|individual|professional)/.test(s);
}
const COPY_ONLY = /\b(copy|wording|language|headline|text)\b/;
/** 'exclude' | 'copy' (imagery/layout evidence only) | null */
function avoidance(ref, campaignClass) {
  if ((ref.copy_restricted_classes || []).includes(campaignClass)) return 'copy';
  let mode = null;
  for (const a of (ref.avoid_for || [])) {
    const s = String(a).toLowerCase();
    if (!phraseNames(s, campaignClass)) continue;
    if (COPY_ONLY.test(s)) mode = mode || 'copy'; else return 'exclude';
  }
  return mode;
}
function avoided(ref, campaignClass) { return avoidance(ref, campaignClass) === 'exclude'; }
function relevance(ref, need) {
  if (ref.campaign_class_primary === need.campaign_class) return RELEVANCE.primary;
  if ((ref.campaign_class_secondary || []).includes(need.campaign_class)) return RELEVANCE.secondary;
  const fams = need.families_allowed || (need.requested_family ? [need.requested_family] : []);
  if (fams.length && fams.includes(ref.nearest_advantage_family)) return RELEVANCE.family;
  return 0;
}
function jaccard(a, b) { const A = new Set(a || []), B = new Set(b || []); if (!A.size && !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); }
function facetSimilarity(ref, need) {
  let total = 0, got = 0;
  const eq = (k, w) => { if (need[k] == null) return; total += w; if (ref[k] === need[k]) got += w; };
  eq('event_mode', FACET_WEIGHTS.event_mode);
  if (need.requested_family) { total += FACET_WEIGHTS.nearest_advantage_family; if (ref.nearest_advantage_family === need.requested_family) got += FACET_WEIGHTS.nearest_advantage_family; }
  eq('merchandise_breadth', FACET_WEIGHTS.merchandise_breadth);
  eq('format_class', FACET_WEIGHTS.format_class);
  eq('seller_hierarchy', FACET_WEIGHTS.seller_hierarchy);
  if (need.tags && need.tags.length) { total += FACET_WEIGHTS.tags; got += FACET_WEIGHTS.tags * jaccard(ref.tags, need.tags); }
  return total ? Math.round((got / total) * 1000) / 1000 : 0;
}

/**
 * @param index  index.json object
 * @param need   { campaign_class, seller_hierarchy, event_mode, wave, merchandise_mode, merchandise_breadth, format_class, requested_family, families_allowed[], tags[] }
 */
function retrieve(index, need) {
  const refs = (index.references || []).filter((r) => !r.stub);
  const positives = refs.filter((r) => ['OWNER_APPROVED', 'OWNER_GOLD_STANDARD'].includes(r.owner_status) && !avoided(r, need.campaign_class));
  const scored = positives.map((r) => {
    const rel = relevance(r, need); const fac = facetSimilarity(r, need);
    return { reference_id: r.reference_id, sha256: r.sha256, sidecar_hash: r.sidecar_hash, owner_status: r.owner_status, owner_weight: r.owner_weight, relevance: rel, facet_similarity: fac,
             imagery_only: avoidance(r, need.campaign_class) === 'copy', training_example: r.training_example === true, structure: structureMap()[r.reference_id] || null,
             score: Math.round(r.owner_weight * rel * fac * 10000) / 10000, seller: r.seller, nearest_advantage_family: r.nearest_advantage_family, transferable_lessons: r.transferable_lessons, do_not_generalize: r.do_not_generalize, measured: r.measured, tags: r.tags };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.reference_id.localeCompare(b.reference_id));
  let top = scored.slice(0, TOP_N);
  // Every Gold Standard of the class is always included (Phase 3P.2: Golds are live evidence, weight 2.0, bar 75).
  const golds = scored.filter((x) => x.owner_status === 'OWNER_GOLD_STANDARD' && x.relevance === RELEVANCE.primary);
  for (const g of golds.slice().reverse()) if (!top.some((x) => x.reference_id === g.reference_id)) top = [g, ...top];
  if (top.length > TOP_N) { const keep = new Set(golds.map((g) => g.reference_id)); const rest = top.filter((x) => !keep.has(x.reference_id)); top = golds.concat(rest).slice(0, Math.max(TOP_N, golds.length)); }
  const gold = golds[0];
  const negatives = refs.filter((r) => r.owner_status === 'OWNER_DO_NOT_USE' && (r.campaign_class_primary === need.campaign_class || (r.campaign_class_secondary || []).includes(need.campaign_class)))
    .map((r) => ({ reference_id: r.reference_id, sha256: r.sha256, anti_patterns: r.do_not_generalize, tags: r.tags }));
  const empty = top.length === 0;
  const hasGold = !!gold;
  let neutral = [];
  if (empty) {
    neutral = refs.filter((r) => ['OWNER_APPROVED', 'OWNER_GOLD_STANDARD'].includes(r.owner_status) && !avoided(r, need.campaign_class) && jaccard(r.tags, NEUTRAL_TAGS) > 0)
      .map((r) => ({ reference_id: r.reference_id, sha256: r.sha256, sidecar_hash: r.sidecar_hash, owner_weight: r.owner_weight, relevance: 0.25, facet_similarity: jaccard(r.tags, NEUTRAL_TAGS), score: Math.round(r.owner_weight * 0.25 * jaccard(r.tags, NEUTRAL_TAGS) * 10000) / 10000, seller: r.seller, transferable_lessons: r.transferable_lessons, do_not_generalize: r.do_not_generalize, measured: r.measured, tags: r.tags, neutral: true }))
      .sort((a, b) => b.score - a.score || a.reference_id.localeCompare(b.reference_id)).slice(0, TOP_N);
  }
  const considered = empty ? neutral : top;
  // Advantage.Bid's own references are the brand: exempt from seller-identity stripping (never from G11 anti-copy
  // or the prop-checklist ban). Concentration is measured over third-party sellers only.
  const sellers = {}; for (const r of considered) if (r.seller !== BRAND_SELLER) sellers[r.seller] = (sellers[r.seller] || 0) + 1;
  const thirdParty = considered.filter((r) => r.seller !== BRAND_SELLER);
  const dominant = Object.entries(sellers).sort((a, b) => b[1] - a[1])[0];
  const concentration = thirdParty.length && dominant ? dominant[1] / thirdParty.length : 0;
  const confidence = empty ? 'LOW' : (top.some((x) => x.relevance === RELEVANCE.primary) ? 'HIGH' : 'MEDIUM');
  return {
    index_version: index.index_version, campaign_class: need.campaign_class, retrieved: top, negatives, neutral_fallback: neutral,
    empty_class: empty, confidence, owner_review_required: empty || need.owner_review_required === true,
    has_gold_standard: hasGold, seller_concentration: { dominant_seller: dominant ? dominant[0] : null, share: Math.round(concentration * 100) / 100 },
    strip_seller_identity: thirdParty.length > 0 && (concentration > SELLER_CONCENTRATION_MAX || concentration >= 1),
    structures_seen: [...new Set(top.map((x) => x.structure).filter(Boolean))],
    imagery_only: top.filter((x) => x.imagery_only).map((x) => x.reference_id),
    pending_promotion: refs.filter((r) => r.owner_status === 'OWNER_APPROVED' && /gold-standard/i.test(r.filename_signal || '') && (r.campaign_class_primary === need.campaign_class))
      .map((r) => ({ reference_id: r.reference_id, reason: 'filename signals gold-standard but the file sits in the plain folder — one Owner word or a folder move promotes it; never automatic' })),
    accept_bar: golds.length ? 75 : 70,
    excluded_by_avoid_for: refs.filter((r) => avoided(r, need.campaign_class)).map((r) => r.reference_id),
  };
}

module.exports = { retrieve, relevance, facetSimilarity, avoided, avoidance, structureMap, RELEVANCE, FACET_WEIGHTS, TOP_N, NEUTRAL_TAGS, SELLER_CONCENTRATION_MAX, BRAND_SELLER };
