'use strict';

/**
 * pickupPlanService — Buyer-Centric Global Pickup Scheduling (Launch).
 *
 * Generated automatically AT AUCTION CLOSE over ALL winning buyers (winners are known at
 * close, before payment), so buyers see their slot immediately and there is no fragile
 * "must generate before payment / no backfill" dependency. Payment still gates pickup
 * EXECUTION, not the plan.
 *
 * Principle: schedule by BUYER, not by lot. One consolidated appointment per buyer, timed by
 * their LARGEST won item (assignedTier: any C -> C, else any B -> B, else A). Drives off the
 * clean `size_category` field; `pickup_category` is retired from scheduling.
 *
 * Tier ordering A -> B -> C (small/fragile released first; large furniture moved last, after
 * fragile items are gone). Tier windows sized PROPORTIONALLY to each tier's load; buyers
 * load-balanced across sub-slots to reduce congestion. Idempotent (regenerates cleanly).
 */

const db = require('../db');
const { assignedTier, normTier } = require('../lib/pickupTiers');

const TIER_WEIGHT = { A: 1, B: 2, C: 3 }; // handling-effort proxy (drives load + tier window size)
const GRACE_MS = 300000;                  // 5 min buffer between tiers
const TARGET_LOAD_PER_SLOT = 10;          // congestion target per sub-slot

/** Generate/regenerate the buyer-centric plan for an auction. Own-transaction unless a client is passed. */
async function generatePlanAtClose(auctionId, extClient) {
  const client = extClient || await db.connect();
  const ownTx = !extClient;
  try {
    if (ownTx) await client.query('BEGIN');
    const a = (await client.query('SELECT pickup_window_start, pickup_window_end FROM auctions WHERE id=$1', [auctionId])).rows[0];
    if (!a || !a.pickup_window_start || !a.pickup_window_end) { if (ownTx) await client.query('COMMIT'); return { ok: false, skipped: 'no_pickup_window' }; }
    const winStart = new Date(a.pickup_window_start).getTime();
    const winEnd = new Date(a.pickup_window_end).getTime();
    if (!(winEnd > winStart)) { if (ownTx) await client.query('COMMIT'); return { ok: false, skipped: 'invalid_window' }; }

    const lots = (await client.query(
      `SELECT winning_buyer_user_id AS buyer, id AS lot_id, size_category
         FROM lots WHERE auction_id=$1 AND state='closed' AND winning_buyer_user_id IS NOT NULL`, [auctionId])).rows;
    if (lots.length === 0) { if (ownTx) await client.query('COMMIT'); return { ok: false, skipped: 'no_winners' }; }

    // Group lots by buyer → consolidated tier + load.
    const buyers = new Map();
    for (const l of lots) {
      if (!buyers.has(l.buyer)) buyers.set(l.buyer, { buyer: l.buyer, sizes: [], lots: [] });
      const b = buyers.get(l.buyer); b.sizes.push(l.size_category); b.lots.push(l.lot_id);
    }
    const buyerList = [];
    for (const b of buyers.values()) {
      const tier = assignedTier(b.sizes) || 'A'; // unset sizes → treat as small so the buyer still gets a slot
      const load = b.sizes.reduce((s, sz) => s + (TIER_WEIGHT[normTier(sz)] || 1), 0);
      buyerList.push({ buyer: b.buyer, lots: b.lots, tier, load });
    }

    const tierLoad = { A: 0, B: 0, C: 0 };
    for (const b of buyerList) tierLoad[b.tier] += b.load;
    const usedTiers = ['A', 'B', 'C'].filter((t) => tierLoad[t] > 0);
    const totalLoad = usedTiers.reduce((s, t) => s + tierLoad[t], 0);
    const totalMs = winEnd - winStart;
    const availMs = Math.max(totalMs - (usedTiers.length - 1) * GRACE_MS, usedTiers.length * 60000);

    // Reset the auction's schedule (idempotent regenerate).
    const scheduleId = (await client.query(
      `INSERT INTO pickup_schedules (auction_id, schedule, generated_at) VALUES ($1,$2, now())
       ON CONFLICT (auction_id) DO UPDATE SET schedule=EXCLUDED.schedule, generated_at=now() RETURNING id`,
      [auctionId, JSON.stringify({ model: 'buyer_centric_global', generated: 'at_close' })])).rows[0].id;
    await client.query('DELETE FROM slots_capacity WHERE pickup_schedule_id=$1', [scheduleId]);
    await client.query('DELETE FROM pickup_assignments WHERE pickup_schedule_id=$1', [scheduleId]);

    const perTier = {};
    let tierStart = winStart;
    for (const tier of usedTiers) {
      const tierMs = availMs * (tierLoad[tier] / totalLoad);
      const tStart = tierStart; const tEnd = tStart + tierMs; tierStart = tEnd + GRACE_MS;
      const inTier = buyerList.filter((b) => b.tier === tier).sort((x, y) => x.load - y.load); // heavier buyers later
      const numSlots = Math.max(1, Math.ceil(tierLoad[tier] / TARGET_LOAD_PER_SLOT));
      const slotMs = tierMs / numSlots;
      const perSlotTarget = tierLoad[tier] / numSlots;
      const slots = Array.from({ length: numSlots }, (_, i) => ({
        slot_number: i + 1, slot_start: new Date(tStart + i * slotMs), slot_end: new Date(tStart + (i + 1) * slotMs), buyers: [], load: 0,
      }));
      let si = 0;
      for (const b of inTier) {
        while (si < numSlots - 1 && slots[si].load >= perSlotTarget) si++;
        slots[si].buyers.push(b); slots[si].load += b.load;
      }
      for (const slot of slots) {
        await client.query(
          `INSERT INTO slots_capacity (pickup_schedule_id, category, slot_number, slot_start, slot_end, capacity, assigned)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [scheduleId, tier, slot.slot_number, slot.slot_start, slot.slot_end, Math.max(TARGET_LOAD_PER_SLOT, slot.load), slot.buyers.length]);
        for (const b of slot.buyers) {
          for (const lotId of b.lots) {
            await client.query(
              `INSERT INTO pickup_assignments (pickup_schedule_id, lot_id, buyer_user_id, slot_start, slot_end, assigned_tier, pickup_status)
               VALUES ($1,$2,$3,$4,$5,$6,'scheduled')`,
              [scheduleId, lotId, b.buyer, slot.slot_start, slot.slot_end, tier]);
          }
        }
      }
      perTier[tier] = { buyers: inTier.length, slots: numSlots, window_start: new Date(tStart).toISOString(), window_end: new Date(tEnd).toISOString() };
    }
    await client.query('UPDATE pickup_schedules SET schedule=$2 WHERE id=$1',
      [scheduleId, JSON.stringify({ model: 'buyer_centric_global', generated: 'at_close', tiers: perTier })]);

    // One PICKUP_SCHEDULED notification per buyer via the proven notifications_queue path.
    for (const b of buyerList) {
      const slot = (await client.query('SELECT slot_start, slot_end FROM pickup_assignments WHERE pickup_schedule_id=$1 AND buyer_user_id=$2 LIMIT 1', [scheduleId, b.buyer])).rows[0];
      if (slot) await client.query(
        `INSERT INTO notifications_queue (user_id, type, payload) VALUES ($1,'PICKUP_SCHEDULED',$2)`,
        [b.buyer, JSON.stringify({
          auction_id: auctionId, tier: b.tier,
          slot_start: slot.slot_start, slot_end: slot.slot_end,     // RECOMMENDED arrival window (advisory)
          window_start: a.pickup_window_start, window_end: a.pickup_window_end, // published window (buyer may arrive anytime within)
        })]);
    }

    if (ownTx) await client.query('COMMIT');
    return { ok: true, schedule_id: scheduleId, buyers: buyerList.length, tiers: perTier };
  } catch (e) {
    if (ownTx) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
    throw e;
  } finally {
    if (ownTx) client.release();
  }
}

/** Admin marks a buyer's consolidated pickup complete (all their lots for the auction). */
async function markCompleted(adminId, auctionId, buyerUserId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const admin = (await client.query('SELECT role FROM users WHERE id=$1', [adminId])).rows[0];
    if (!admin || admin.role !== 'admin') { await client.query('ROLLBACK'); const e = new Error('Admin only'); e.code = 'FORBIDDEN'; e.status = 403; throw e; }
    const sched = (await client.query('SELECT id FROM pickup_schedules WHERE auction_id=$1', [auctionId])).rows[0];
    if (!sched) { await client.query('ROLLBACK'); const e = new Error('No pickup schedule'); e.code = 'NO_SCHEDULE'; e.status = 404; throw e; }
    const r = await client.query(
      `UPDATE pickup_assignments SET pickup_status='completed', completed_at=now(), completed_by=$3
        WHERE pickup_schedule_id=$1 AND buyer_user_id=$2 AND pickup_status <> 'completed'`,
      [sched.id, buyerUserId, adminId]);
    await client.query('COMMIT');
    return { ok: true, lots_completed: r.rowCount };
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } throw e; } finally { client.release(); }
}

/**
 * Detect no-shows. A recommended arrival window is ADVISORY — buyers may arrive anytime during
 * the auction's PUBLISHED pickup window. So a no-show is judged against the published window END
 * (the whole window has passed without completion), NOT the recommended slot. This preserves the
 * buyer flexibility they agreed to before bidding.
 */
async function detectMissed() {
  const due = (await db.query(
    `SELECT pa.buyer_user_id, pa.lot_id, pa.slot_start, pa.slot_end
       FROM pickup_assignments pa
       JOIN pickup_schedules ps ON ps.id = pa.pickup_schedule_id
       JOIN auctions a         ON a.id = ps.auction_id
      WHERE pa.pickup_status='scheduled' AND a.pickup_window_end < now()`)).rows;
  let marked = 0;
  for (const d of due) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE pickup_assignments SET pickup_status='missed' WHERE lot_id=$1 AND pickup_status='scheduled'", [d.lot_id]);
      const existing = await client.query("SELECT 1 FROM missed_pickups WHERE lot_id=$1 AND status IN ('missed','rescheduled') LIMIT 1", [d.lot_id]);
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO missed_pickups (lot_id, buyer_user_id, scheduled_slot_start, scheduled_slot_end, status)
           VALUES ($1,$2,$3,$4,'missed')`,
          [d.lot_id, d.buyer_user_id, d.slot_start, d.slot_end]);
      }
      await client.query('COMMIT'); marked++;
    } catch (e) { console.error('[pickup] detectMissed row failed for lot', d.lot_id, '-', e.message); try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } } finally { client.release(); }
  }
  return { marked };
}

module.exports = { generatePlanAtClose, markCompleted, detectMissed, TIER_WEIGHT, TARGET_LOAD_PER_SLOT };
