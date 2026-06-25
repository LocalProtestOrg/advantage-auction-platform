'use strict';

/**
 * pickupTiers — pure pickup-tier helpers (Phase 3). size_category (A/B/C) IS the
 * tier (A=small, B=medium, C=large). Time windows are the auction pickup window
 * split into THREE EQUAL parts (A earliest → C latest); never hardcoded. Size is
 * never inferred — unset → null/"Not specified".
 *
 * NOTE: This drives the buyer-facing pickup-time display + the packet's computed
 * "Assigned Pickup Time" (largest item wins). It is a computed OVERLAY and does
 * NOT modify the existing slot-based pickup_assignments (which keys off
 * pickup_category). See docs/projects/pickup-scheduling-phase3.md.
 */

const TIER_ORDER = { A: 1, B: 2, C: 3 };
const SIZE_ITEM_LABEL = { A: 'Small Items', B: 'Medium Items', C: 'Large Items' };

function normTier(sizeCategory) {
  return (sizeCategory === 'A' || sizeCategory === 'B' || sizeCategory === 'C') ? sizeCategory : null;
}
function timeLabel(tier) { return tier ? ('Pickup Time ' + tier) : 'Not specified'; }
function itemLabel(tier) { return tier ? SIZE_ITEM_LABEL[tier] : null; }

// Largest item determines the buyer's assigned tier (any C → C; else any B → B; else A).
function assignedTier(sizeCategories) {
  let best = null;
  for (const s of (sizeCategories || [])) {
    const t = normTier(s);
    if (t && (!best || TIER_ORDER[t] > TIER_ORDER[best])) best = t;
  }
  return best;
}

// Split [start,end] into three equal windows. Returns { A:{start,end}, B, C } as
// Date objects, or null if the window is missing/invalid.
function splitWindow(start, end) {
  if (!start || !end) return null;
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || !(e > s)) return null;
  const third = (e - s) / 3;
  const mk = (i) => ({ start: new Date(s + third * i), end: new Date(s + third * (i + 1)) });
  return { A: mk(0), B: mk(1), C: mk(2) };
}

function fmtTime(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); } catch (_e) { return ''; }
}
function windowLabel(w) { return w ? (fmtTime(w.start) + ' – ' + fmtTime(w.end)) : ''; }

module.exports = { TIER_ORDER, SIZE_ITEM_LABEL, normTier, timeLabel, itemLabel, assignedTier, splitWindow, fmtTime, windowLabel };
