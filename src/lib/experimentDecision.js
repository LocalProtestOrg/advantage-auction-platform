'use strict';

/**
 * experimentDecision — sunk-cost-immune continue/stop boundary + deterministic stopping engine. Cumulative
 * historical spend is STRUCTURALLY unavailable to continueStopDecision: any attempt to pass it throws.
 * Historical spend still lives in the ledger/reporting — it is intentionally omitted from the DECISION.
 */

// The only inputs the continue/stop decision may consider (cost-to-continue is FROM NOW, not cumulative).
const ALLOWED_INPUTS = Object.freeze(['observedEffect', 'remainingRequiredExposure', 'guardrailStatus', 'costToContinueFromNow', 'attributionState', 'windowRemainingDays', 'preconditionValid', 'futilityReachable']);
const FORBIDDEN_INPUT = /cumulative|spent_to_date|sunk|total_spend|already_spent|spend_incurred/i;

function continueStopDecision(input = {}) {
  for (const k of Object.keys(input)) {
    if (FORBIDDEN_INPUT.test(k)) throw new Error('Sunk/cumulative spend must never be an input to the continue/stop decision: ' + k);
  }
  const i = input;
  if (i.preconditionValid === false) return { decision: 'stop', reason: 'precondition_invalidated' };
  if (i.guardrailStatus === 'breach') return { decision: 'stop', reason: 'guardrail_breach' };
  if (Number(i.windowRemainingDays) <= 0) return { decision: 'stop', reason: 'analysis_window_reached' };
  if (i.futilityReachable === false) return { decision: 'stop', reason: 'futility_mde_unreachable' };
  return { decision: 'continue', reason: 'within_design' };
}

// Deterministic stopping engine. Returns which stop condition(s) fired + class-level flag + close verdict.
function evaluateStop(state = {}) {
  const reasons = [];
  if (state.reservationExhausted) reasons.push('reservation_exhausted');
  if (state.mdeUnreachable) reasons.push('futility_mde_unreachable');
  if (state.guardrailBreach) reasons.push('guardrail_breach');
  if (state.qaOrComplianceFinding) reasons.push('qa_compliance_finding');
  if (state.windowReached) reasons.push('analysis_window_reached');
  if (state.preconditionInvalid) reasons.push('precondition_invalidated');
  if (state.providerFailure) reasons.push('provider_channel_failure');
  const stop = reasons.length > 0;
  // Insufficient data at window close → no_conclusion_yet (not a forced verdict).
  const verdictAtClose = (state.windowReached && state.insufficientData) ? 'no_conclusion_yet' : undefined;
  // Guardrail/compliance breaches can trigger a CLASS-LEVEL stop (e.g. all email experiments).
  const classLevel = !!state.classLevel && (state.guardrailBreach || state.qaOrComplianceFinding || state.providerFailure);
  return { stop, reasons, classLevel, verdictAtClose, releaseReservation: stop };
}

module.exports = { ALLOWED_INPUTS, FORBIDDEN_INPUT, continueStopDecision, evaluateStop };
