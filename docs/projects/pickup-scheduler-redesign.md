# Pickup Scheduler Redesign — Buyer-Centric Global Scheduling (PROPOSED — awaiting approval)

**Governing objective:** the smoothest possible pickup for buyers, sellers, and staff — while protecting purchased items.
**Status:** design only. Major architectural decision — no implementation until approved.

## Why the current scheduler is replaced
Evidence (prod, 2026-07-06): `pickup_schedules=0 / pickup_assignments=0` (never run in prod); `pickup_category` dirty (`S/large/medium/M/small` on 9 lots) and **divergent from `size_category` on 29 lots**; assignment is **per-lot, payment-order, keyed on the dirty field, with no backfill and no global plan**. It cannot deliver consolidation, ordering, or congestion goals. (Confirms `pickup-scheduling-phase3.md` §4–5.)

## Core principle
**Schedule by BUYER, not by lot.** Each buyer gets **one consolidated appointment**, timed by their **largest item** (`assignedTier`: any C → C, else any B → B, else A). The whole schedule is computed **globally at auction close** over all winning buyers, driven by the **clean `size_category`** field. `pickup_category` is retired as the scheduler key.

## How it meets every stated goal
- **A generally first, B next, C later** → tiers occupy the window in order A → B → C.
- **A+C buyer gets a later slot** → their `assignedTier` = C (largest wins) → one C-tier appointment. (Exactly the requested behavior.)
- **Global, not independent** → one pass over all winning buyers builds the plan; not greedy-by-payment.
- **Reduce furniture-around-fragile** → small/fragile (A/B) released **before** large furniture (C) is moved, so big items are never dragged past fragile items still on the floor.
- **Reduce congestion / buyer waiting / seller workload** → one trip per buyer; buyers balanced across sub-slots by load, not clustered.

## Algorithm (computed at close; re-balanceable)
1. **Gather** every winning buyer for the auction and their won lots' `size_category`.
2. **Per buyer:** `tier = max(category)` (C>B>A); `load = Σ weight(cat)` with A=1, B=2, C=3 (proxy for handling effort/time).
3. **Partition** the auction pickup window into three tier windows A/B/C, sized **proportionally to each tier's total load** (not blind equal thirds), with a grace buffer between tiers.
4. **Within a tier:** create sub-slots and assign buyers via **balanced bin-packing** (fill to a target load per slot, keep each buyer whole) so no slot is congested; order buyers within a tier by load (heaviest later).
5. **Persist:** one appointment per buyer; every one of that buyer's lots points to the buyer's single slot (keeps the per-lot `pickup_assignments` schema; all a buyer's lots share one slot_start/slot_end).
6. **Payment interaction:** the plan is computed at **close** (winners are known at close, before payment), so buyers see their slot immediately (in the won email / invoice / packet). Pickup **execution** still requires the lot to be paid (existing `_ensurePaymentPaid` guard). Refund/withdrawal triggers a re-balance. This removes the fragile "must generate before payment" ordering + the no-backfill gap.

## Data / integrity (additive, non-breaking)
- Drive scheduling off **`size_category`** (clean). Add a CHECK + one-time cleanup mapping dirty `pickup_category` (`small→A, medium→B, large→C, S→A, M→B`) — or simply stop reading it.
- Likely a small migration: a `pickup_slot_id`/`slot_start`/`slot_end` per assignment already exist; add `buyer_user_id` to `pickup_assignments` if not present so a buyer's slot is first-class. (Finalize during build.)
- Bring the **Phase 3 buyer-facing display + packet to production** (currently staging-only) so buyers actually see accurate, size-based pickup times.

## Also folded in (P1s from the broader audit)
- **`markPickupCompleted`** (currently missing) — record release (staff, time, condition).
- **Missed-pickup / no-show** detection worker + a defined follow-up (re-slot; penalty is a separate owner decision).
- **Pickup-scheduled + reminder** notifications via the proven `notifications_queue → notificationWorker` path.

## Out of scope (P2/P3 — deferred per "fix only P0/P1")
Handling flags (fragile/forklift/two-person), auction timezone capture, full `pickup_category` column removal, per-item appointment splitting.

## Rollout
Additive migration + new `pickupPlanService` (global planner) alongside the existing service; generate at close (auto) with an admin "regenerate/re-balance" control; Tier 1 (scratch) → Tier 2 (staging, real multi-buyer A+C scenarios) → prod gate.
