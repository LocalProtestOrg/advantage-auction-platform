'use strict';

/**
 * ownedPlacementExecutor — Phase 3O Wave 2, blocker 1. Real production fulfilment for OWNED Advantage.Bid
 * surfaces (MARKETPLACE channel): featured badge / listing priority, category prominence, notable-lot
 * spotlight, Closing Soon, homepage module, homepage hero, onsite targeted placement.
 *
 * These surfaces are ACTIVE (owned, live). The executor: (1) reserves capacity on an inventory calendar with
 * AUTOMATED collision resolution (shift to the next free slot — capacity is never a hidden package-refusal),
 * (2) activates the placement, (3) collects first_seen / last_seen / duration + impression / click counts,
 * (4) exposes an evidence gate that COMPLETED requires. A RESERVATION ALONE NEVER COMPLETES AN OBLIGATION —
 * qualifying evidence (duration met, or measured impressions) is mandatory. Reconciliation reports gaps.
 *
 * Configurable defaults preserved: homepage module = 4 days, homepage hero = 2 days.
 */

const db = require('../db');
const obligationEngine = require('./marketingObligationEngine');
const { runLadder } = require('./resilienceLadderService');

// Feature → surface capacity (concurrent slots) + default duration (days). Capacity>1 means several auctions
// may occupy the surface at once; collision only when all slots for an overlapping window are taken.
const SURFACE = {
  featured_badge_priority: { capacity: 999, days: null,  measured: true },   // per-listing badge, effectively unbounded
  category_prominence:     { capacity: 12,  days: null,  measured: true },
  notable_lot_spotlight:   { capacity: 8,   days: null,  measured: true },
  closing_soon_exposure:   { capacity: 20,  days: null,  measured: true },
  closing_soon_extension:  { capacity: 20,  days: null,  measured: true },
  homepage_module_run:     { capacity: 6,   days: 4,     measured: true },   // DEFAULT 4 days (configurable)
  homepage_hero_days:      { capacity: 1,   days: 2,     measured: true },   // DEFAULT 2 days (configurable); single slot
  additional_wave:         { capacity: 999, days: null,  measured: true },
  onsite_targeted:         { capacity: 999, days: null,  measured: true },
};

function handles(featureKey) { return Object.prototype.hasOwnProperty.call(SURFACE, featureKey); }

// Resolve capacity/days honoring per-obligation parameter overrides (admin-configurable), preserving defaults.
function resolveConfig(featureKey, params = {}) {
  const base = SURFACE[featureKey] || { capacity: 999, days: null, measured: true };
  const days = params.days != null ? Number(params.days) : base.days;
  return { capacity: base.capacity, days, measured: base.measured };
}

// Count overlapping ACTIVE/RESERVED holds on a surface within [start,end). Used for automated collision.
async function overlapCount(r, featureKey, startAt, endAt, excludeId) {
  const q = await r.query(
    `SELECT slot_index FROM marketing_placement_reservations
      WHERE feature_key=$1 AND status IN ('reserved','active')
        AND ($4::uuid IS NULL OR id <> $4)
        AND start_at < $3 AND (end_at IS NULL OR end_at > $2)`,
    [featureKey, startAt, endAt, excludeId || null]);
  return q.rows.map((x) => x.slot_index);
}

/**
 * Reserve capacity on the inventory calendar. Automated collision resolution: if the requested window is full,
 * shift forward day-by-day until a slot is free (never refuses the package — capacity pressure delays, it does
 * not deny). Returns the reservation row (with resolved slot + possibly shifted window).
 */
async function reserve(obligation, { auctionId, startAt, endAt, lotIds = [] }, runner) {
  const r = runner || db;
  const cfg = resolveConfig(obligation.feature_key, obligation.parameters || {});
  let start = new Date(startAt);
  const durMs = (cfg.days ? cfg.days : 1) * 86400000;
  const maxShift = 60; // days; bounded search
  for (let shift = 0; shift <= maxShift; shift++) {
    const s = new Date(start.getTime() + shift * 86400000);
    const e = endAt && !cfg.days ? new Date(endAt) : new Date(s.getTime() + durMs);
    const taken = await overlapCount(r, obligation.feature_key, s.toISOString(), e.toISOString());
    if (taken.length < cfg.capacity) {
      let slot = 0; while (taken.indexOf(slot) !== -1) slot++;
      const ins = await r.query(
        `INSERT INTO marketing_placement_reservations
           (obligation_id, feature_key, auction_id, lot_ids, slot_index, start_at, end_at, days, status)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,'reserved') RETURNING *`,
        [obligation.id || null, obligation.feature_key, auctionId, JSON.stringify(lotIds), slot,
         s.toISOString(), e.toISOString(), cfg.days || null]);
      return { ...ins.rows[0], shifted_days: shift };
    }
  }
  return null; // fully saturated for 60d — caller routes to resilience (reschedule), never silent refusal
}

async function activate(reservationId, whenIso, runner) {
  const r = runner || db;
  const up = await r.query(
    `UPDATE marketing_placement_reservations SET status='active', activated_at=$2 WHERE id=$1 AND status='reserved' RETURNING *`,
    [reservationId, whenIso]);
  const res = up.rows[0];
  if (!res) return null;
  // Open the evidence row at first_seen (activation is the first exposure).
  await r.query(
    `INSERT INTO marketing_placement_evidence (obligation_id, feature_key, auction_id, lot_ids, reservation_id, first_seen_at, shadow)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,false)`,
    [res.obligation_id, res.feature_key, res.auction_id, JSON.stringify(res.lot_ids || []), res.id, whenIso]);
  return res;
}

// Record measured exposure. In production these increments are fed by the analytics pipeline (placement-tagged
// analytics_events); here they are the counting mechanism the pipeline drives. last_seen advances with activity.
async function recordExposure(reservationId, { impressions = 0, clicks = 0, atIso }, runner) {
  const r = runner || db;
  await r.query(
    `UPDATE marketing_placement_evidence
        SET impressions = impressions + $2, clicks = clicks + $3,
            last_seen_at = GREATEST(COALESCE(last_seen_at, first_seen_at), $4::timestamptz),
            days = GREATEST(COALESCE(days,0), CEIL(EXTRACT(EPOCH FROM ($4::timestamptz - first_seen_at))/86400.0)::int)
      WHERE reservation_id=$1`,
    [reservationId, impressions, clicks, atIso]);
}

/**
 * Evidence gate — the ONLY thing that authorizes COMPLETED. Qualifying evidence = the placement actually ran:
 * measured impressions > 0, OR the configured duration was served (days met). A bare reservation fails this.
 */
async function evidenceComplete(obligation, runner) {
  const r = runner || db;
  const cfg = resolveConfig(obligation.feature_key, obligation.parameters || {});
  const ev = (await r.query(
    `SELECT reservation_id, first_seen_at, last_seen_at, days, impressions, clicks
       FROM marketing_placement_evidence WHERE obligation_id=$1 AND shadow=false ORDER BY created_at DESC LIMIT 1`,
    [obligation.id])).rows[0];
  if (!ev || !ev.first_seen_at) return { ok: false, reason: 'no_activation_evidence' };
  const durationMet = cfg.days ? (Number(ev.days || 0) >= cfg.days) : true;
  const measured = Number(ev.impressions || 0) > 0;
  const ok = durationMet && (measured || cfg.days != null);
  return { ok, reason: ok ? 'qualified' : 'insufficient_evidence',
           evidence: { reservation_id: ev.reservation_id, first_seen_at: ev.first_seen_at,
                       last_seen_at: ev.last_seen_at, days: ev.days, impressions: ev.impressions, clicks: ev.clicks } };
}

/**
 * Execute an owned-placement obligation end-to-end. Owned surfaces are ACTIVE, so a fully-evidenced placement
 * is COMPLETED for real. Without qualifying evidence it stays LIVE (reconciliation will re-check) — it is never
 * completed on the reservation alone. If the calendar is saturated, resilience (reschedule) is invoked.
 */
async function execute(obligation, { auctionId, startAt, endAt, lotIds, now }, runner) {
  const r = runner || db;
  if (!handles(obligation.feature_key)) return { ok: false, error: 'not_an_owned_placement' };
  const res = await reserve(obligation, { auctionId, startAt, endAt, lotIds }, r);
  if (!res) {
    const ladder = runLadder('L_placement_soft', { readiness: 'ACTIVE', capacity: 'SATURATED' }, { shadow: false });
    await obligationEngine.block(obligation.id, { reason: 'placement_calendar_saturated', retryAfter: '2 days' }, r).catch(() => {});
    return { ok: false, error: 'saturated', ladder };
  }
  await activate(res.id, now || res.start_at, r);
  const gate = await evidenceComplete({ ...obligation }, r);
  return { ok: true, reservation: res, evidence_gate: gate, completed: false,
           note: 'activated; COMPLETED awaits qualifying evidence (never the reservation alone)' };
}

/** Reconcile a purchase's owned placements: for each, is the evidence gate satisfied? Advance the qualified. */
async function reconcile(obligations, runner) {
  const r = runner || db;
  const out = [];
  for (const ob of obligations) {
    if (!handles(ob.feature_key)) continue;
    const gate = await evidenceComplete(ob, r);
    if (gate.ok) {
      await obligationEngine.transition(ob.id, 'COMPLETED',
        { proof: gate.evidence, reason: 'owned_placement_evidence', shadow: false }, null, r).catch(() => {});
    }
    out.push({ obligation_id: ob.id, feature_key: ob.feature_key, completed: gate.ok, gate });
  }
  return out;
}

module.exports = { SURFACE, handles, resolveConfig, reserve, activate, recordExposure, evidenceComplete, execute, reconcile, overlapCount };
