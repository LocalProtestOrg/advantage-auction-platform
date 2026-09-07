'use strict';

/**
 * resilienceLadderService — executes the Phase 3O resilience ladders (data-driven, from the schema pack:
 * one ladder per obligation family). Rung order: FULFILL → RETRY → RESCHEDULE → ALTERNATE → SUBSTITUTE →
 * MADE_GOOD → ESCALATE. A rung that would violate consent / suppression / frequency caps / health budget /
 * channel readiness / package authority is SKIPPED (never forced) with a recorded reason. ESCALATE (rung 7)
 * is never the first response. Comparable-or-greater substitution creates its own evidenced obligation.
 * Runs in SHADOW by default — shadow evidence never counts as real seller fulfillment.
 */

const contract = require('./phase3oContract');

const RUNGS = ['FULFILL', 'RETRY', 'RESCHEDULE', 'ALTERNATE', 'SUBSTITUTE', 'MADE_GOOD', 'ESCALATE'];

// A guard result for a rung: { allowed:boolean, reason?:string }. Guards reflect authoritative runtime facts.
function evaluateGuards(rung, guards) {
  const g = guards || {};
  // Hard safety guards apply to any send/publish/spend rung.
  if (g.consent === false) return { allowed: false, reason: 'consent absent' };
  if (g.suppressed === true) return { allowed: false, reason: 'recipient/audience suppressed' };
  if (g.frequency_capped === true) return { allowed: false, reason: 'frequency cap reached' };
  if (g.health_budget_exhausted === true) return { allowed: false, reason: 'audience health budget exhausted' };
  if (g.authority_exhausted === true && (rung === 'FULFILL' || rung === 'ALTERNATE')) return { allowed: false, reason: 'package authority exhausted' };
  // FULFILL requires the channel to be executable (ACTIVE). Otherwise fall through the ladder.
  if (rung === 'FULFILL' && g.channel_active === false) return { allowed: false, reason: 'channel not ACTIVE (' + (g.channel_state || 'gated') + ')' };
  return { allowed: true };
}

// Ladder definition (rungs enabled) from the pack; falls back to the full ladder.
function ladderRungs(ladderId) {
  const ladders = contract.ladders();
  const def = ladders && ladders[ladderId];
  if (def && Array.isArray(def.rungs) && def.rungs.length) return def.rungs;
  if (Array.isArray(def) && def.length) return def;
  return RUNGS;
}

// Attempt the ladder for an obligation given the current guards. Returns the outcome + a per-rung trace.
// Does NOT itself persist obligation state — the caller (worker) applies the resulting action so all writes
// go through the append-only engine. `shadow` marks certification runs.
function runLadder(ladderId, guards, { shadow = true } = {}) {
  const rungs = ladderRungs(ladderId === 'none' || !ladderId ? 'L_placement_soft' : ladderId).filter((x) => RUNGS.indexOf(x) !== -1);
  const trace = [];
  for (const rung of rungs) {
    const guard = evaluateGuards(rung, guards);
    if (!guard.allowed) { trace.push({ rung, action: 'skipped', reason: guard.reason }); continue; }
    // First allowed rung is taken. FULFILL/RETRY/RESCHEDULE → progress; ALTERNATE/SUBSTITUTE → substitute;
    // MADE_GOOD → made_good; ESCALATE → needs_owner.
    let action;
    if (rung === 'FULFILL' || rung === 'RETRY' || rung === 'RESCHEDULE') action = 'progress';
    else if (rung === 'ALTERNATE' || rung === 'SUBSTITUTE') action = 'substitute';
    else if (rung === 'MADE_GOOD') action = 'made_good';
    else action = 'escalate';
    trace.push({ rung, action, reason: 'taken' });
    return { rung, action, shadow, trace };
  }
  // Nothing allowed → escalate.
  return { rung: 'ESCALATE', action: 'escalate', shadow, trace };
}

module.exports = { RUNGS, evaluateGuards, ladderRungs, runLadder };
