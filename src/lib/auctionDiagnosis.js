'use strict';

/**
 * auctionDiagnosis — deterministic diagnosis FOUNDATION. Names the believed constraint from authoritative
 * signals; returns INSUFFICIENT_EVIDENCE (a SUCCESSFUL output) when data is too thin for a conclusion.
 * Observation, not valuation: never predicts realized price, never fabricates comparables. A1 may not
 * request discretionary Growth spend just because "an auction is underperforming" — it must name the
 * constraint + evidence, and only MARKETING-correctable constraints justify marketing spend.
 */
const MARKETING_CORRECTABLE = Object.freeze(['insufficient_qualified_exposure', 'geographic_reach_constraint']);
const NON_MARKETING = Object.freeze(['registration_friction', 'audience_mismatch', 'merchandise_demand', 'catalog_presentation', 'reserve_expectation_gap', 'pickup_shipping_constraint']);

function diagnose(signals = {}) {
  const s = signals;
  const minSample = s.minSample || 5;
  if (s.sample == null || Number(s.sample) < minSample) {
    return { constraint: 'INSUFFICIENT_EVIDENCE', category: 'unknown', marketing_correctable: false, evidence: s };
  }
  if (s.qualifiedExposure != null && Number(s.qualifiedExposure) < (s.exposureFloor || 1)) {
    return { constraint: 'insufficient_qualified_exposure', category: 'marketing_correctable', marketing_correctable: true, evidence: s };
  }
  if (s.buyersOutsideRadius === true && s.reachRadiusMiles != null) {
    return { constraint: 'geographic_reach_constraint', category: 'marketing_correctable', marketing_correctable: true, evidence: s };
  }
  if (s.registrationDropoff != null && Number(s.registrationDropoff) > 0.7) {
    return { constraint: 'registration_friction', category: 'non_marketing', marketing_correctable: false, recommendation: { observation: true, note: 'High registration drop-off — likely friction, not reach.' }, evidence: s };
  }
  if (s.reserveAboveMarket === true) {
    return { constraint: 'reserve_expectation_gap', category: 'non_marketing', marketing_correctable: false, recommendation: { observation: true, note: 'Reserve appears above observed clearing range (observation only; no valuation).' }, evidence: s };
  }
  if (s.catalogQuality != null && Number(s.catalogQuality) < 0.5) {
    return { constraint: 'catalog_presentation', category: 'non_marketing', marketing_correctable: false, recommendation: { observation: true, note: 'Catalog completeness/quality signals are low.' }, evidence: s };
  }
  return { constraint: 'INSUFFICIENT_EVIDENCE', category: 'unknown', marketing_correctable: false, evidence: s };
}

// Guard for A1: discretionary Growth spend needs a MARKETING-correctable named constraint + evidence.
function justifiesGrowthSpend(diagnosis) {
  return !!(diagnosis && diagnosis.marketing_correctable === true && diagnosis.constraint !== 'INSUFFICIENT_EVIDENCE');
}

module.exports = { MARKETING_CORRECTABLE, NON_MARKETING, diagnose, justifiesGrowthSpend };
