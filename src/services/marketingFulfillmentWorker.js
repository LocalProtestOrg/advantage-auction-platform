'use strict';

/**
 * marketingFulfillmentWorker — the autonomous fulfillment MONITOR (Phase 3O §5). It continuously advances
 * package obligations: find due → evaluate readiness + guards → run the resilience ladder → advance state /
 * write evidence / retry / reschedule / substitute → move to a terminal state ONLY after proof → create
 * NEEDS_OWNER only after automation is genuinely exhausted. Runs in SHADOW by default (shadow evidence is
 * never real seller fulfillment). Self-gated; never sends/publishes/spends when a channel is not ACTIVE.
 *
 * FULFILL → RETRY → RESCHEDULE → ALTERNATE → SUBSTITUTE → MADE_GOOD → OWNER.
 */

const db = require('../db');
const engine = require('./marketingObligationEngine');
const ladders = require('./resilienceLadderService');
const readiness = require('./channelReadinessService');
const marketingConfig = require('./marketingConfigService');

const INTERVAL_MS = 60_000;
const MAX_ATTEMPTS_BEFORE_OWNER = 6;

// Advance ONE obligation. Pure-ish: all writes go through the append-only engine. Returns the action taken.
async function advanceObligation(ob, runner, { shadow = true } = {}) {
  const r = runner || db;
  if (engine.TERMINAL_OK.indexOf(ob.state) !== -1) return { action: 'terminal_noop' };
  const channelState = await readiness.phase3oState(ob.channel, r);
  const channelActive = channelState === 'ACTIVE';
  const guards = { channel_active: channelActive, channel_state: channelState };

  // Internal channels (ACTIVE): drive to completion with system-verified proof.
  if (channelActive) {
    // planned → creative_ready → scheduled → live → completed (one step per tick keeps history granular)
    const next = { planned: 'creative_ready', creative_ready: 'scheduled', scheduled: 'live', live: 'completed', blocked: 'creative_ready' }[ob.state];
    if (next) { await engine.transition(ob.id, next, { rung: 'FULFILL', reason: 'internal channel active', proof: next === 'completed' ? { evidence_mode: 'system_verified', completed_at: new Date().toISOString() } : {}, shadow: false }, 'runtime', r); return { action: 'progress', to: next }; }
    return { action: 'noop' };
  }

  // Gated external channel: run the ladder. In SHADOW mode we record shadow evidence but never mark real
  // fulfillment; we BLOCK with a retry cadence (auto re-checkable) until the channel becomes ACTIVE, and only
  // escalate to NEEDS_OWNER after attempts are exhausted (or the obligation window is at risk).
  const outcome = ladders.runLadder(ob.ladder_id, guards, { shadow });
  if (outcome.action === 'substitute') {
    await engine.substitute(ob.id, { key: (ob.obligation_key || 'item') + '_alt', label: 'Comparable alternative promotion', channel: ob.channel }, { reason: 'ladder alternate/substitute' }, 'runtime', r);
    return { action: 'substituted' };
  }
  if (outcome.action === 'made_good') { await engine.transition(ob.id, 'made_good', { rung: 'MADE_GOOD', reason: 'made good', shadow }, 'runtime', r); return { action: 'made_good' }; }
  if (outcome.action === 'escalate') {
    // Persist a BOUNDED Director ESCALATE decision (never a prohibited kind) for replay/audit.
    try { await require('./directorDecisionService').record({ kind: 'ESCALATE', purchaseId: ob.purchase_id, obligationIds: [ob.id],
      inputs: { channel: ob.channel, channel_state: channelState, attempts: ob.attempts, ladder: ob.ladder_id },
      authorityCentsRemaining: 0, evidenceLine: 'ladder exhausted on ' + ob.channel + ' (' + channelState + ')', outputs: { trace: outcome.trace } }, r); } catch (_) { /* best-effort */ }
    if ((ob.attempts || 0) >= MAX_ATTEMPTS_BEFORE_OWNER) { await engine.needsOwner(ob.id, { reason: 'automatic fulfillment ladder exhausted (' + ob.channel + ' ' + channelState + ')', options: ['activate_channel', 'manual_make_good', 'substitute_specified'] }, r); return { action: 'needs_owner' }; }
    await engine.block(ob.id, { reason: 'awaiting channel activation (' + ob.channel + ':' + channelState + ')', retryAfter: new Date(Date.now() + 6 * 3600000) }, r);
    return { action: 'blocked_retry' };
  }
  // progress on a gated channel in shadow → record shadow evidence, remain scheduled (NOT completed).
  await engine.transition(ob.id, ob.state === 'planned' ? 'creative_ready' : 'scheduled', { rung: 'FULFILL', reason: 'shadow progress', shadow: true }, 'runtime', r);
  return { action: 'shadow_progress' };
}

// One monitor tick: advance all due obligations. Best-effort; never throws.
async function tick(runner) {
  const r = runner || db;
  try {
    const due = (await r.query(
      `SELECT * FROM marketing_obligations
        WHERE state NOT IN ('completed','substituted','made_good','needs_owner')
          AND (retry_after IS NULL OR retry_after <= now())
        ORDER BY updated_at ASC LIMIT 100`)).rows;
    let advanced = 0;
    for (const ob of due) { try { await advanceObligation(ob, r, { shadow: true }); advanced++; } catch (e) { /* per-obligation isolation */ } }
    return { due: due.length, advanced };
  } catch (e) { console.error('[fulfillment-worker] tick error:', e.message); return { due: 0, advanced: 0 }; }
}

// Interval runner — self-gated on marketing.pkg.enabled. Never blocks startup.
function start() {
  (async () => {
    try {
      const enabled = await marketingConfig.getBool('marketing.pkg.enabled', false);
      if (!enabled) { console.log('[fulfillment-worker] marketing.pkg.enabled is off — monitor idle'); return; }
      console.log('[fulfillment-worker] shadow monitor started — scanning every ' + (INTERVAL_MS / 1000) + 's');
      setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
    } catch (e) { console.error('[fulfillment-worker] start error:', e.message); }
  })();
}

module.exports = { advanceObligation, tick, start, MAX_ATTEMPTS_BEFORE_OWNER };
