'use strict';

/**
 * marketingIdeaGate — idea → hypothesis promotion. An idea creates NO authority. Promotion requires a full
 * falsifiable contract; missing fields prevent promotion. Novelty = MORE scrutiny. Analogy is NOT
 * authorization. Retry of a retired hypothesis requires evidence that a recorded invalidating condition
 * actually changed. A deterministic family key catches rephrased re-entry of the same retired hypothesis.
 */
const REQUIRED = Object.freeze(['named_constraint', 'mechanism', 'primary_objective', 'primary_metric', 'guardrails', 'minimum_detectable_effect', 'required_exposure', 'decision_thresholds', 'analysis_window_days', 'estimated_cost', 'risk_class', 'invalidating_conditions']);
const OBJECTIVES = Object.freeze(['buyer', 'individual_seller', 'professional_seller']);

function canPromote(idea = {}) {
  const missing = REQUIRED.filter((k) => {
    const v = idea[k];
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'string') return v.trim() === '';
    return false;
  });
  const objectiveValid = OBJECTIVES.indexOf(idea.primary_objective) !== -1;
  return { ok: missing.length === 0 && objectiveValid, missing, objectiveValid };
}

// Deterministic similarity key over metadata (not AI). Two ideas with the same key are the same family.
function familyKey(m = {}) {
  return [m.primary_objective, m.named_constraint || m.constraint, m.mechanism, m.market || m.market_id || '', m.segment || '', m.channel || '', m.category || '']
    .map((x) => String(x == null ? '' : x).toLowerCase().trim()).join('|');
}

// Retry a retired/negative family only if a recorded invalidating condition actually changed.
function retryAllowed({ retired, changedInvalidatingCondition } = {}) {
  if (!retired) return { allowed: true, reason: 'not_retired' };
  return { allowed: !!changedInvalidatingCondition, reason: changedInvalidatingCondition ? 'invalidating_condition_changed' : 'retired_no_change' };
}

module.exports = { REQUIRED, OBJECTIVES, canPromote, familyKey, retryAllowed };
