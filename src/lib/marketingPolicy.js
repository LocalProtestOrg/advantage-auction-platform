'use strict';

/**
 * marketingPolicy — single source of truth for Autonomous Marketing Agency financial + targeting policy
 * (owner-approved 2026-09-03). PURE: no DB, no side effects, integer-cents / basis-point safe. Services,
 * routes, and tests share ONE definition (mirrors settlementPolicy.js).
 *
 * Two structurally separate money concepts (NEVER collapsed):
 *   • Concept A — the seller marketing-package charge (package_price_cents). Seller-facing; 100% Advantage
 *     revenue; non-refundable; deducted from seller proceeds. Lives in settlement/accounting.
 *   • Concept B — Advantage.Bid's INTERNAL direct-marketing expenditure ceiling (direct_max_cents), a
 *     percentage (default 60%) of the package price. Internal only; never seller-facing; never collectible.
 *
 * The Growth Pool receives the base remainder (price − direct_max) plus any unused direct capacity.
 * INVARIANT (always): direct_max_cents + growth_base_cents === package_price_cents.
 */

// Code-owned defaults (platform_config overrides these at runtime via marketingConfigService).
const DEFAULT_DIRECT_SPEND_MAX_BPS   = 6000;   // 60.00% internal direct-marketing ceiling
const DEFAULT_EVENT_LOCAL_RADIUS_MILES = 30;   // paid event_local default radius (software-enforced)
const DEFAULT_GROWTH_MONTHLY_ADDITIONAL_AUTHORITY_CENTS = 100000; // $1,000/mo autonomous authority ceiling
const DEFAULT_QA_MAX_CYCLES          = 3;
const MAX_DIRECT_SPEND_MAX_BPS       = 10000;  // 100% ceiling guard

const cents = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };

/**
 * Internal direct-marketing ceiling for a package price. Rounded to whole cents (floor of the fraction so
 * the ceiling can never exceed the intended percentage, and the growth remainder never loses a cent).
 * @param {number} packagePriceCents integer cents (Concept A)
 * @param {number} [bps] direct-spend max in basis points (default 6000 = 60%)
 * @returns {number} direct_max_cents (Concept B) — integer cents
 */
function directMaxCents(packagePriceCents, bps = DEFAULT_DIRECT_SPEND_MAX_BPS) {
  const p = Math.max(0, cents(packagePriceCents));
  const b = Math.min(MAX_DIRECT_SPEND_MAX_BPS, Math.max(0, cents(bps)));
  return Math.floor(p * b / 10000);
}

/**
 * Growth base = REMAINDER after the direct ceiling (never an independent 40% calc — rounding must never
 * lose a cent). growth_base = price − direct_max, so the invariant holds exactly.
 */
function growthBaseCents(packagePriceCents, directMaxCentsValue) {
  const p = Math.max(0, cents(packagePriceCents));
  const d = Math.max(0, cents(directMaxCentsValue));
  return Math.max(0, p - d);
}

/** Full allocation for a package price. Guarantees direct_max + growth_base === price. */
function allocate(packagePriceCents, bps = DEFAULT_DIRECT_SPEND_MAX_BPS) {
  const price = Math.max(0, cents(packagePriceCents));
  const direct_max_cents = directMaxCents(price, bps);
  const growth_base_cents = growthBaseCents(price, direct_max_cents);
  return { package_price_cents: price, direct_max_cents, growth_base_cents };
}

/** Unused direct capacity after a campaign completes (feeds a one-time Growth contribution). */
function unusedDirectCapacityCents(directMaxCentsValue, directSpentCents) {
  return Math.max(0, cents(directMaxCentsValue) - cents(directSpentCents));
}

/** Assert the core allocation invariant (used by services + tests). Returns true or throws. */
function assertAllocationInvariant({ package_price_cents, direct_max_cents, growth_base_cents }) {
  if (cents(direct_max_cents) + cents(growth_base_cents) !== cents(package_price_cents)) {
    throw new Error('Marketing allocation invariant violated: direct_max + growth_base !== package_price');
  }
  return true;
}

// ── Event-local paid targeting policy (software-enforced) ───────────────────────────
/**
 * Resolve the paid event_local radius. Returns the configured default (30mi) unless an explicit approved
 * exception provides a broader radius. NEVER silently broadens. Coordinates are validated by the caller.
 */
function resolveEventLocalRadiusMiles({ defaultMiles = DEFAULT_EVENT_LOCAL_RADIUS_MILES, exceptionMiles = null, exceptionApprovedBy = null } = {}) {
  if (exceptionMiles != null && exceptionApprovedBy) return Math.max(1, cents(exceptionMiles));
  return Math.max(1, cents(defaultMiles));
}

/** Whether real coordinates are present for a paid event_local campaign (else must fail/escalate). */
function hasValidEventCoordinates(lat, lng) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180
    && !(Number(lat) === 0 && Number(lng) === 0);
}

// ── Creative claim provenance (deterministic gate) ──────────────────────────────────
/**
 * A FACTUAL claim is publishable only with a non-null/non-empty authoritative source. Subjective claims
 * need no source. Implied claims (layout/composition) are NOT auto-approved here — they require the future
 * judgment-QA pass, so deterministic validation alone treats an implied claim as needs_review (not pass).
 * @returns {{acceptable:boolean, reason:string}}
 */
function evaluateClaim(claim = {}) {
  const kind = String(claim.claim_kind || 'factual');
  if (kind === 'subjective') return { acceptable: true, reason: 'subjective' };
  if (kind === 'implied') return { acceptable: false, reason: 'needs_judgment_qa' };
  const src = claim.authoritative_source;
  if (src == null || String(src).trim() === '') return { acceptable: false, reason: 'missing_authoritative_source' };
  return { acceptable: true, reason: 'sourced' };
}

module.exports = {
  DEFAULT_DIRECT_SPEND_MAX_BPS, DEFAULT_EVENT_LOCAL_RADIUS_MILES,
  DEFAULT_GROWTH_MONTHLY_ADDITIONAL_AUTHORITY_CENTS, DEFAULT_QA_MAX_CYCLES, MAX_DIRECT_SPEND_MAX_BPS,
  directMaxCents, growthBaseCents, allocate, unusedDirectCapacityCents, assertAllocationInvariant,
  resolveEventLocalRadiusMiles, hasValidEventCoordinates, evaluateClaim,
};
