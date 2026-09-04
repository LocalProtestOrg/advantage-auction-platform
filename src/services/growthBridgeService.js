'use strict';

/**
 * growthBridgeService — the safe path for A1/Desktop Marketing to pre-register an eligible experiment into
 * the EXISTING Growth Lab (Phase 4B), preserving prereg hash/freeze, MDE/power, holdout/exposure,
 * attribution grade, stop rules, and frozen conditions. Underpowered or audience-widening requests are
 * REFUSED — never widened to hit power. This module validates; the Growth Lab services do the writing.
 */
const marketingExperimentService = require('./marketingExperimentService');
const experimentPreregService = require('./experimentPreregService');
const experimentPrereg = require('../lib/experimentPrereg');

const MIN_VIABLE_AUDIENCE = 50;   // minimum viable size for a powered experiment (config-tunable)

// Pure validation — returns { ok, refuse_reason?, missing?[] }.
function validate({ preregFields = {}, audienceSize = 0 } = {}) {
  const missing = experimentPrereg.missingRequired(experimentPrereg.freeze(preregFields));
  if (missing.length) return { ok: false, refuse_reason: 'prereg_incomplete', missing };
  // Power inputs must be present + concrete (no widening to hit power).
  if (!preregFields.minimum_detectable_effect) return { ok: false, refuse_reason: 'underpowered', missing: ['minimum_detectable_effect'] };
  if (!preregFields.required_exposure) return { ok: false, refuse_reason: 'underpowered', missing: ['required_exposure'] };
  if (Number(audienceSize) < MIN_VIABLE_AUDIENCE) return { ok: false, refuse_reason: 'underpowered', detail: `audience ${audienceSize} < ${MIN_VIABLE_AUDIENCE}` };
  return { ok: true };
}

/**
 * Preregister from the Director. Validates first (REFUSE if underpowered/incomplete), then proposes +
 * preregisters through the existing Growth Lab services.
 * @returns { ok, refuse_reason?, experiment_id?, prereg_hash? }
 */
async function preregister({ hypothesis, objective, campaignClass, audienceKey, audienceSize = 0, channels = [],
  proposedByAgent = 'A1', preregFields = {} } = {}, runner) {
  const v = validate({ preregFields, audienceSize });
  if (!v.ok) return { ok: false, refuse_reason: v.refuse_reason, missing: v.missing || null, detail: v.detail || null };
  // Propose the experiment (reuses marketing_experiments; audience carries the audience_key).
  const proposed = await marketingExperimentService.propose({
    hypothesis, objective, campaignClass, audience: audienceKey, channels, proposedByAgent,
    primaryMetric: preregFields.primary_metric,
  }, runner);
  const experimentId = proposed && (proposed.id || (proposed.experiment && proposed.experiment.id));
  if (!experimentId) return { ok: false, refuse_reason: 'propose_failed', detail: JSON.stringify(proposed).slice(0, 200) };
  const pre = await experimentPreregService.preregister(experimentId, preregFields, runner);
  return { ok: true, experiment_id: experimentId, prereg_hash: pre && (pre.prereg_hash || pre.hash) };
}

module.exports = { validate, preregister, MIN_VIABLE_AUDIENCE };
