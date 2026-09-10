'use strict';

/**
 * creativeReference/principles — Deliverable 6 §3. Turns a retrieval result into `brief.calibration`: a principle
 * profile (ranges + qualities) and a do-not-copy list. References are calibration evidence, NOT templates: the
 * generator receives transferable lessons, composition bands, copy/typography guidance, seller hierarchy and
 * do-not-copy constraints — never a reference image, layout coordinates, colour value, typeface or seller wording.
 * Output is string-scanned: any hex colour, pixel value, typeface name or seller mark is a hard failure.
 */
const lib = require('./library');

// Advantage.Bid brand-frame constants always win over any reference band.
const BRAND_FRAME = { ground: ['white', 'very_light'], band: 'navy Advantage.Bid band closes the canvas', logo: 'Advantage.Bid logo at spec', accent: 'red accent, used once' };
// C6 hypothesis (Deliverable 7): scene merchandise 50–65, text ≤ 18 — until the proving grounds adjust it.
const FAMILY_BANDS = {
  CENTERED_WHITE: { merch: [50, 65], text: [0, 18], empty_max: 6, upper_half_min: 30, scene: true },
  LEFT_THIRD_WHITE: { merch: [48, 62], text: [0, 22], empty_max: 10, upper_half_min: 30, scene: true },
  CATEGORY_GROUP: { merch: [45, 55], text: [0, 18], empty_max: 10, upper_half_min: 0, scene: false },
  SINGLE_LOT: { merch: [45, 60], text: [0, 18], empty_max: null, upper_half_min: 0, scene: false },
  CATALOG_SCATTER: { merch: [65, 85], text: [0, 12], empty_max: 10, upper_half_min: 30, scene: false },
  ENVIRONMENTAL_PHOTO: { merch: [50, 65], text: [0, 24], empty_max: 10, upper_half_min: 30, scene: false },
  ACQUISITION: { merch: [30, 50], text: [0, 18], empty_max: 22, upper_half_min: 0, scene: false, representative: true },
  COBRANDED: { merch: [48, 62], text: [0, 22], empty_max: 10, upper_half_min: 30, scene: true },
  CLOSING_DAYS: { merch: [40, 60], text: [0, 22], empty_max: 10, upper_half_min: 20, scene: false },
};
const TEXT_PROFILES = { GENERAL: { max_text_blocks: 5, text_pct_max: 18 }, LOGISTICS: { max_text_blocks: 7, text_pct_max: 26 }, TEASER: { max_text_blocks: 3, text_pct_max: 12 } };

function bandFor(family, index) {
  const base = Object.assign({}, FAMILY_BANDS[family] || FAMILY_BANDS.CENTERED_WHITE);
  // Intersect with the library's observed band for the family where one exists (calibration evidence).
  const prof = index && index.principle_profiles_by_advantage_family && index.principle_profiles_by_advantage_family[family];
  if (prof && prof.est_merchandise_share_pct && prof.est_merchandise_share_pct[0] < 999) {
    const lo = Math.max(base.merch[0], Math.min(prof.est_merchandise_share_pct[0], base.merch[1]));
    const hi = Math.min(Math.max(base.merch[1], prof.est_merchandise_share_pct[0]), Math.max(prof.est_merchandise_share_pct[1], base.merch[0]));
    if (hi > lo) base.merch = [lo, hi];
    base.library_band = { merchandise: prof.est_merchandise_share_pct, text: prof.est_text_share_pct, text_blocks: prof.text_block_count, references: prof.references };
  }
  return base;
}

const HEX_RE = /#[0-9a-f]{3,8}\b/i, PX_RE = /\b\d+(\.\d+)?\s*px\b/i;
// Phase 3P.2 anti-averaging: the collaborator prop checklist and any logo-style lesson never leave the extractor.
const PROP_TERMS = ['bronze horse', 'rearing horse', 'blue-and-white', 'blue and white vase', 'category spine', 'category-spine', 'spine books', 'laptop', 'mug', 'chalkboard'];
const LOGO_STYLE = /\blogo\b[^.;]{0,40}\b(style|font|typeface|typeset|colou?r|shape|design|lettering|rendering|redraw)|\b(typeset|redraw|recreate|render)[^.;]{0,30}\blogo\b/i;
const COPY_LESSON = /\b(copy|headline|wording|message|messages|cta|slogan|phrase|tagline|text|words?)\b/i;
function trainingFacts() {
  try { return require('../../../docs/marketing/phase3p2/config/notable-lot-contract.json').training_example.facts || []; } catch (_) { return []; }
}
function approvedTexts() {
  try {
    const m = require('../../../docs/marketing/phase3p2/config/campaign-messages.json');
    return [...m.approved_messages.map((x) => x.text), ...m.approved_campaign_specific_messages.map((x) => x.text), ...(m.philosophy_lines_owner_authored || [])];
  } catch (_) { return []; }
}
/** Lessons that may leave the extractor for this reference (ranges and attributes only). */
function lessonsFor(r) {
  const facts = trainingFacts().map((f) => f.toLowerCase());
  return (r.transferable_lessons || []).filter((l) => {
    const t = String(l); const lo = t.toLowerCase();
    if (PROP_TERMS.some((w) => lo.includes(w))) return false;           // prop-checklist ban
    if (LOGO_STYLE.test(t)) return false;                                 // no logo-style lessons (placement/prominence only)
    if (r.imagery_only && COPY_LESSON.test(t)) return false;              // imagery/layout evidence only for this class
    if (r.training_example && (facts.some((f) => lo.includes(f.toLowerCase())) || /\blot\s*\d+/i.test(t) || /\b(1[0-9]|20)(th|st|nd|rd)\s+century\b/i.test(t))) return false;
    return true;
  });
}
/** Scan a calibration block for leaked identity or coordinates. Returns [] when clean. */
function leakScan(obj, sellerMarks) {
  const s = JSON.stringify(obj.principle_profile || obj);
  const hits = [];
  if (HEX_RE.test(s)) hits.push('hex colour');
  for (const w of PROP_TERMS) if (s.toLowerCase().includes(w)) hits.push('collaborator prop: ' + w);
  if (LOGO_STYLE.test(s)) hits.push('logo-style lesson');
  for (const f of trainingFacts()) if (f && s.toLowerCase().includes(f.toLowerCase())) hits.push('fictional training fact: ' + f);
  if (PX_RE.test(s)) hits.push('pixel value');
  for (const f of lib.FONT_NAMES) if (new RegExp('\\b' + f + '\\b', 'i').test(s)) hits.push('typeface: ' + f);
  for (const m of (sellerMarks || lib.KNOWN_SELLER_MARKS)) if (m && s.toLowerCase().includes(String(m).toLowerCase())) hits.push('seller mark: ' + m);
  return hits;
}

/**
 * Build brief.calibration. need: { campaign_class, seller_hierarchy, event_mode, merchandise_mode, family, text_profile,
 * families_allowed[], cobrand_seller }. retrieval: retriever.retrieve() output. sellerMarks: library seller marks.
 */
function buildCalibration(index, retrieval, need, sellerMarks) {
  const family = need.family || (need.families_allowed && need.families_allowed[0]) || 'CENTERED_WHITE';
  const band = bandFor(family, index);
  const profile = TEXT_PROFILES[need.text_profile || 'GENERAL'] || TEXT_PROFILES.GENERAL;
  const used = retrieval.empty_class ? retrieval.neutral_fallback : retrieval.retrieved;
  const lessons = [...new Set(used.flatMap((r) => lessonsFor(r)))];
  const negatives = retrieval.negatives.flatMap((n) => n.anti_patterns || []);
  const hierarchy = [];
  if (need.seller_hierarchy === 'seller_led_cobranded') hierarchy.push('presenter (the Professional Seller) leads; Advantage.Bid is the visible marketplace partner, subordinate; navy band closes');
  else hierarchy.push('Advantage.Bid leads; one message; navy band closes');
  hierarchy.push('one event or message title of 2–6 words' + (need.event_mode === 'on_site' ? '; the place name may be the largest word for an on-site sale' : ''));
  if (['estate_sale', 'auction', 'closing_soon', 'geographic_event_promotion'].includes(need.campaign_class)) hierarchy.push('date larger than time');
  const merchandise = {
    mode: need.merchandise_mode, share_band_pct: band.merch,
    treatment: need.merchandise_mode === 'photograph' ? 'environmental — the actual site photograph, event-bound; no extraction; no stock'
      : need.merchandise_mode === 'representative' ? 'representative Advantage.Bid-owned items, visibly disclosed as representative — never presented as lots'
      : 'CLEAN extracted objects of THIS auction only; grounded; one anchor; scale variation',
  };
  const calibration = {
    campaign_class: need.campaign_class, family,
    reference_ids: used.map((r) => r.reference_id), reference_versions: Object.fromEntries(used.map((r) => [r.reference_id, r.sidecar_hash])),
    index_version: retrieval.index_version, confidence: retrieval.confidence, owner_review_required: retrieval.owner_review_required,
    empty_class: retrieval.empty_class, strip_seller_identity: retrieval.strip_seller_identity,
    principle_profile: {
      hierarchy, merchandise,
      copy: { budget_blocks: profile.max_text_blocks, text_share_max_pct: Math.max(profile.text_pct_max, band.text[1]), supporting_line: 'category line ≤ 6 words or none', cta: 'none or one factual', logistics_block: need.event_mode === 'on_site' ? 'allowed: date + hours + neighbourhood' : 'date + closing' },
      typography: { expressive_allowed: true, rule: 'one element may express contrast or material when truthful; brand faces only' },
      ground: band.scene || family === 'ENVIRONMENTAL_PHOTO' || family === 'ACQUISITION' ? 'white | very_light' : 'family rule',
      composition: { families_allowed: need.families_allowed || [family], title_position: need.event_mode === 'on_site' ? ['top', 'panel'] : ['top', 'bottom', 'panel'], largest_empty_max_pct: band.empty_max, upper_half_merchandise_min_pct: band.upper_half_min },
      transferable_lessons: lessons,
      anti_patterns: negatives,
      brand_frame: BRAND_FRAME,
      variation_required_from: need.variation_required_from || [],
      // Phase 3P.2: attribute RANGES + the set of structures the Owner's references show — never a mean layout.
      structures_seen: retrieval.structures_seen || [],
      structure_rule: 'name the structure chosen and why; consecutive creatives for the same objective rotate structure; a Gold is evidence, not a template',
      imagery_only_references: retrieval.imagery_only || [],
    },
    do_not_copy: {
      seller_marks: (sellerMarks && sellerMarks.seller_marks) || lib.KNOWN_SELLER_MARKS,
      palettes: 'any reference palette', typefaces: 'any reference typeface', ornaments: 'flourishes, decorative frames, stars, crests, gold borders, icon logistics rows',
      wording: ((sellerMarks && sellerMarks.wording) || []).filter((w) => !approvedTexts().some((a) => a.toLowerCase().replace(/[.!?]+$/, '') === String(w).toLowerCase().replace(/[.!?]+$/, ''))),
      layout_signatures: used.map((r) => r.sha256),
    },
    library_band: band.library_band || null,
  };
  const leaks = leakScan(calibration, calibration.do_not_copy.seller_marks);
  if (leaks.length) { const e = new Error('calibration leak: ' + leaks.join(', ')); e.code = 'CALIBRATION_LEAK'; throw e; }
  return calibration;
}

module.exports = { buildCalibration, bandFor, leakScan, lessonsFor, FAMILY_BANDS, TEXT_PROFILES, BRAND_FRAME, PROP_TERMS };
