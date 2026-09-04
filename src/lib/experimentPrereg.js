'use strict';

/**
 * experimentPrereg — pure pre-registration freeze + deterministic hash. Once an experiment starts
 * executing, these frozen fields become immutable (enforced server-side by experimentPreregService);
 * a change requires a NEW experiment version referencing the prior one.
 */
const crypto = require('crypto');

// The fields frozen at pre-registration (Phase 3G contract).
const FIELDS = Object.freeze([
  'hypothesis', 'mechanism', 'primary_objective', 'primary_metric', 'guardrail_metrics',
  'minimum_detectable_effect', 'required_exposure', 'success_threshold', 'failure_threshold',
  'no_conclusion_conditions', 'analysis_window_days', 'invalidating_conditions', 'attribution_plan',
  'attribution_grade', 'conditions', 'baseline', 'requested_authority',
]);
const REQUIRED = Object.freeze(['hypothesis', 'primary_objective', 'primary_metric', 'analysis_window_days']);

// Deterministic canonical serialization (sorted keys) so the hash is stable regardless of key order.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

function freeze(input = {}) {
  const p = {};
  for (const f of FIELDS) p[f] = input[f] === undefined ? null : input[f];
  return p;
}
function hash(prereg) { return crypto.createHash('sha256').update(canonical(prereg)).digest('hex'); }
function missingRequired(prereg = {}) {
  return REQUIRED.filter((k) => prereg[k] == null || (typeof prereg[k] === 'string' && prereg[k].trim() === ''));
}

module.exports = { FIELDS, REQUIRED, canonical, freeze, hash, missingRequired };
