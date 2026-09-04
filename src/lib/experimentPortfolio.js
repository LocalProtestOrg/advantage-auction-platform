'use strict';

/**
 * experimentPortfolio — bands (spending CEILINGS, never quotas) + the rung ladder. First positive pilot →
 * replicate (NOT a budget increase); replication required before extension; correlational/tracked evidence
 * cannot skip credibility rules; inconclusive doesn't promote; negative stops; repeated negative retires the
 * family; proven approaches may be demoted when performance decays. There is NO authority-utilization KPI.
 */
const attribution = require('./attribution');

const BANDS = Object.freeze(['proven', 'incremental', 'exploratory', 'novel']);
const RUNGS = Object.freeze(['design', 'pilot', 'replicate', 'extend', 'standing']);
const rungIndex = (r) => (typeof r === 'number' ? r : RUNGS.indexOf(String(r)));

// Given a rung + verdict + attribution, return the next ladder action. Never scales on a first positive.
function nextRung({ rung, verdict, attributionGrade } = {}) {
  const idx = rungIndex(rung);
  if (verdict === 'negative') return { rung: idx, action: 'stop', reason: 'negative_result' };
  if (verdict === 'inconclusive' || verdict === 'no_conclusion_yet' || verdict === 'invalidated') return { rung: idx, action: 'hold', reason: 'not_promotable' };
  if (verdict === 'positive') {
    if (idx <= 1) return { rung: 2, action: 'replicate', reason: 'first_positive_requires_replication' }; // design/pilot → replicate
    if (idx === 2) {
      if (!attribution.canScaleUp(attributionGrade)) return { rung: 2, action: 'hold', reason: 'attribution_insufficient_for_scale' };
      return { rung: 3, action: 'extend', reason: 'replicated_positive' };
    }
    if (idx === 3) return { rung: 4, action: 'promote_standing', reason: 'extended_positive' };
    return { rung: 4, action: 'hold', reason: 'already_standing' };
  }
  return { rung: idx, action: 'hold', reason: 'no_change' };
}

// A proven/standing approach may be DEMOTED when performance decays.
function demoteIfDecayed({ rung, decayed }) { return decayed && rungIndex(rung) >= 4 ? { rung: 3, action: 'demote', reason: 'performance_decay' } : null; }

// Repeated negatives retire the hypothesis family.
function retireFamily({ consecutiveNegatives }) { return Number(consecutiveNegatives) >= 2; }

// GUARD: an "authority utilization %" style KPI is forbidden — unspent authority is a normal success.
function isForbiddenUtilizationKpi(name) {
  const n = String(name || '');
  return /authority[_ ]?utilization|budget[_ ]?used|utilization/i.test(n)
    || /(percent|%)[_ ]?of[_ ]?(budget|authority)/i.test(n)
    || /(budget|authority|spend)[_ ]?(used|utilization)/i.test(n)
    || /%[_ ]?(of|used)/i.test(n);
}

module.exports = { BANDS, RUNGS, rungIndex, nextRung, demoteIfDecayed, retireFamily, isForbiddenUtilizationKpi };
