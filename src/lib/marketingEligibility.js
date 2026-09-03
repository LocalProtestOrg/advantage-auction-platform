'use strict';

/**
 * marketingEligibility — PURE rules governing whether a seller may PURCHASE a marketing package for an
 * auction. No DB, no side effects. Two independent gates:
 *
 *   1. 48-hour cutoff: a package may be purchased until 48h before the auction's authoritative close time
 *      (auctions.end_time). At/after T-48h, purchase is unavailable. (Continued fulfillment of an
 *      already-purchased package is NOT governed by this — only NEW purchases.)
 *   2. Clothing/apparel ratio: if MORE THAN 50% of the valid catalog lots are clothing/apparel, packages
 *      are unavailable. Exactly 50% (and below) remain eligible. Uses integer math (clothing*2 <= total)
 *      so the boundary is exact — no floating-point.
 *
 * Clothing classification is by the existing free-text lot category (server-authoritative), matched
 * case-insensitively; it is NEVER guessed from photographs.
 */

const MARKETING_CUTOFF_HOURS = 48;
const RULE_VERSION = 'mkt-elig-v1(clothing>50%,window=close-48h)';

// Server-authoritative clothing/apparel category matcher. Matches the taxonomy value 'clothing'
// (dashboard lot editor) / 'Clothing & Accessories' and any explicit 'apparel' wording. Deliberately does
// NOT match jewelry, watches, handbags, textiles, linens, or collectibles.
function isClothingCategory(category) {
  const n = String(category == null ? '' : category).toLowerCase().trim();
  if (!n) return false;
  return n.startsWith('clothing') || n.includes('apparel') || n.includes('clothes');
}

// Clothing share in basis points (for the audit snapshot). 0 when there are no valid lots.
function clothingRatioBps(totalValidLots, clothingLots) {
  const t = Math.max(0, Math.trunc(Number(totalValidLots) || 0));
  const c = Math.max(0, Math.trunc(Number(clothingLots) || 0));
  if (t === 0) return 0;
  return Math.round((c / t) * 10000);
}

// Eligible unless clothing is STRICTLY more than half. Integer-exact: clothing/total <= 1/2 ⇔ clothing*2 <= total.
function isClothingEligible(totalValidLots, clothingLots) {
  const t = Math.max(0, Math.trunc(Number(totalValidLots) || 0));
  const c = Math.max(0, Math.trunc(Number(clothingLots) || 0));
  if (t === 0) return true;               // no lots → clothing gate does not block (a separate no-lots reason applies)
  return (c * 2) <= t;                    // >50% clothing ⇒ ineligible; exactly 50% ⇒ eligible
}

// The purchase-window cutoff instant (ms): 48h before close.
function cutoffMs(closeTimeMs) {
  return Number(closeTimeMs) - MARKETING_CUTOFF_HOURS * 3600 * 1000;
}

// Purchase allowed only strictly BEFORE the cutoff. At exactly T-48h (or later) → not allowed.
function isWithinPurchaseWindow(nowMs, closeTimeMs) {
  const close = Number(closeTimeMs);
  if (!Number.isFinite(close)) return false;   // no authoritative close time → cannot offer purchase
  return Number(nowMs) < cutoffMs(close);
}

module.exports = {
  MARKETING_CUTOFF_HOURS, RULE_VERSION,
  isClothingCategory, clothingRatioBps, isClothingEligible, cutoffMs, isWithinPurchaseWindow,
};
