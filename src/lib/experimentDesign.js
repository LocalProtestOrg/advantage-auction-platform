'use strict';

/**
 * experimentDesign — deterministic MDE / required-exposure gate. Decides whether a proposed experiment can
 * PLAUSIBLY learn what it claims. Replaceable/evolvable as real data grows (method is versioned). Does NOT
 * pretend statistical certainty the current sample can't support: if exposure is insufficient it returns
 * UNDERPOWERED_EXPERIMENT (never silently shrinks the sample to fit a budget).
 */
const METHOD = 'mde-approx-v1';

// Approx per-arm sample for a two-proportion test at ~80% power / 95% two-sided: n ≈ 16·p(1-p)/d².
function requiredExposure({ baselineRate, minimumDetectableEffect }) {
  const p = Number(baselineRate); const d = Number(minimumDetectableEffect);
  if (!(p > 0 && p < 1) || !(d > 0)) return null;
  return Math.ceil((16 * p * (1 - p)) / (d * d));
}

/**
 * @returns {{status, reason, method, required_exposure?, available_exposure?, inputs?, assumptions?, confidence_limitations?}}
 * status ∈ adequately_powered | underpowered_experiment | insufficient_baseline | insufficient_audience
 */
function assess({ primaryMetric, baselineRate, minimumDetectableEffect, availableExposure, requiredExposureOverride } = {}) {
  if (!primaryMetric) return { status: 'insufficient_baseline', reason: 'primary_metric_required', method: METHOD };
  if (baselineRate == null) return { status: 'insufficient_baseline', reason: 'baseline_required', method: METHOD, inputs: { minimumDetectableEffect } };
  const req = requiredExposureOverride != null ? Number(requiredExposureOverride) : requiredExposure({ baselineRate, minimumDetectableEffect });
  if (req == null || !(req > 0)) return { status: 'insufficient_baseline', reason: 'invalid_mde_or_baseline', method: METHOD, inputs: { baselineRate, minimumDetectableEffect } };
  const avail = Number(availableExposure);
  if (!(avail > 0)) return { status: 'insufficient_audience', reason: 'no_available_exposure', method: METHOD, required_exposure: req };
  if (avail < req * 2) {
    return { status: 'underpowered_experiment', reason: 'available_exposure_below_required', method: METHOD, required_exposure: req, available_exposure: avail, assumptions: { power: 0.8, alpha: 0.05, arms: 2 }, confidence_limitations: 'small-sample regime; method is replaceable as marketplace data grows' };
  }
  return { status: 'adequately_powered', method: METHOD, required_exposure: req, available_exposure: avail, assumptions: { power: 0.8, alpha: 0.05, arms: 2 } };
}

/**
 * EMAIL INVARIANT (future 3F): an underpowered email experiment may NEVER enlarge its audience by weakening
 * permission, suppression, geography, eligibility, or deliverability. Returns false if any rule is weakened.
 */
function emailAudienceExpansionAllowed({ weakensPermission, weakensSuppression, weakensGeography, weakensEligibility, weakensDeliverability } = {}) {
  return !(weakensPermission || weakensSuppression || weakensGeography || weakensEligibility || weakensDeliverability);
}

module.exports = { METHOD, requiredExposure, assess, emailAudienceExpansionAllowed };
