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
// Keywords by which an avoid_for phrase names a campaign class.
const CLASS_KEYWORDS = {
  estate_sale: ['estate sale', 'estate-sale', 'estate sales'], auction: ['broad auction', 'broad estate auction', 'general auction', 'online-only auction', 'online auction', 'any auction'],
  notable_lot: ['single-lot', 'single lot', 'notable lot', 'spotlight'], closing_soon: ['closing-soon', 'closing soon', 'closing'],
  individual_seller_acquisition: ['acquisition'], professional_seller_acquisition: ['acquisition'], buyer_platform_growth: ['acquisition', 'buyer growth', 'growth'],
  general_brand: ['brand'], geographic_event_promotion: ['geographic', 'regional'],
};
// Class-neutral lessons used when a class is empty (facets the Owner's taste expresses regardless of class).
const NEUTRAL_TAGS = ['breadth', 'warm-light', 'light-ground', 'scene', 'minimal-copy', 'material-typography', 'factual-cta', 'footer-band'];

function avoided(ref, campaignClass) {
  const kws = CLASS_KEYWORDS[campaignClass] || [campaignClass.replace(/_/g, ' ')];
  return (ref.avoid_for || []).some((a) => { const s = String(a).toLowerCase(); return kws.some((k) => s.includes(k)); });
}
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
             score: Math.round(r.owner_weight * rel * fac * 10000) / 10000, seller: r.seller, nearest_advantage_family: r.nearest_advantage_family, transferable_lessons: r.transferable_lessons, do_not_generalize: r.do_not_generalize, measured: r.measured, tags: r.tags };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.reference_id.localeCompare(b.reference_id));
  let top = scored.slice(0, TOP_N);
  // Always include a Gold Standard of the class if one exists.
  const gold = scored.find((x) => x.owner_status === 'OWNER_GOLD_STANDARD' && x.relevance === RELEVANCE.primary);
  if (gold && !top.some((x) => x.reference_id === gold.reference_id)) top = [gold, ...top.slice(0, TOP_N - 1)];
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
  const sellers = {}; for (const r of considered) sellers[r.seller] = (sellers[r.seller] || 0) + 1;
  const dominant = Object.entries(sellers).sort((a, b) => b[1] - a[1])[0];
  const concentration = considered.length && dominant ? dominant[1] / considered.length : 0;
  const confidence = empty ? 'LOW' : (top.some((x) => x.relevance === RELEVANCE.primary) ? 'HIGH' : 'MEDIUM');
  return {
    index_version: index.index_version, campaign_class: need.campaign_class, retrieved: top, negatives, neutral_fallback: neutral,
    empty_class: empty, confidence, owner_review_required: empty || need.owner_review_required === true,
    has_gold_standard: hasGold, seller_concentration: { dominant_seller: dominant ? dominant[0] : null, share: Math.round(concentration * 100) / 100 },
    strip_seller_identity: concentration > SELLER_CONCENTRATION_MAX || (considered.length > 0 && concentration >= 1),
    excluded_by_avoid_for: refs.filter((r) => avoided(r, need.campaign_class)).map((r) => r.reference_id),
  };
}

module.exports = { retrieve, relevance, facetSimilarity, avoided, RELEVANCE, FACET_WEIGHTS, TOP_N, NEUTRAL_TAGS, SELLER_CONCENTRATION_MAX };
