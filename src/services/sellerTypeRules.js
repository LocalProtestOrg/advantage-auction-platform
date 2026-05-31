'use strict';

/**
 * Seller-Type Rules — Phase C: server-authoritative auction schedule validation.
 *
 * Rule (locked):
 *   pickup_window_start >= auction_end + 48 hours  — for NON-PROFESSIONAL sellers
 *   (private / business / other / NULL). PROFESSIONAL sellers (auction_house /
 *   estate_sale_company / professional_liquidator) are EXEMPT from the 48h gap.
 *   Sanity floor for EVERYONE: pickup may not begin before the auction closes.
 *
 * Gap basis is the configured auction.end_time (not soft-close tail / actual
 * close / payment time).
 *
 * Admin may override (reason required, audited) — see enforceScheduleRule in
 * auctionService. This module stays pure (no DB); classification reuses the
 * single source of truth in constants/sellerTypes.js so the lists never drift.
 */

const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');

const NON_PRO_MIN_PICKUP_GAP_HOURS = 48;

const MESSAGES = {
  // Seller-facing copy (locked by the owner) for the 48h non-professional rule.
  pickup_min_gap:
    'Pickup for non-professional sellers cannot begin less than 48 hours after the auction closes. ' +
    'This helps ensure winning bidders have adequate time to complete payment before pickup begins.',
  // Basic validity floor, applies to all sellers including professionals.
  pickup_after_close: 'Pickup cannot begin before the auction closes.',
};

function isProfessional(sellerType) {
  return PROFESSIONAL_SELLER_TYPES.includes(sellerType);
}

/**
 * Pure validator. Returns { ok, violations: [{ rule, requiredHours?, actualHours?, message }] }.
 * Validates only when BOTH timestamps are present — a missing field yields no
 * violation (supports grandfathering / partial drafts at the caller).
 */
function validateAuctionSchedule({ sellerType, endTime, pickupWindowStart }) {
  const violations = [];
  if (endTime && pickupWindowStart) {
    const gapH = (new Date(pickupWindowStart).getTime() - new Date(endTime).getTime()) / 3.6e6;
    if (Number.isNaN(gapH)) {
      // Unparseable timestamps — never block on bad input here; other layers reject it.
      return { ok: true, violations: [] };
    }
    if (gapH < 0) {
      violations.push({ rule: 'pickup_after_close', message: MESSAGES.pickup_after_close });
    } else if (!isProfessional(sellerType) && gapH < NON_PRO_MIN_PICKUP_GAP_HOURS) {
      violations.push({
        rule:          'pickup_min_gap',
        requiredHours: NON_PRO_MIN_PICKUP_GAP_HOURS,
        actualHours:   Math.round(gapH * 10) / 10,
        message:       MESSAGES.pickup_min_gap,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Thrown by the auctionService chokepoint when a write is blocked by the rule. */
class ScheduleRuleError extends Error {
  constructor(violations, opts = {}) {
    super('Auction schedule violates seller-type rules');
    this.name        = 'ScheduleRuleError';
    this.code        = 'SCHEDULE_RULE_VIOLATION';
    this.violations  = violations || [];
    // True when the actor is an admin who could proceed by supplying an
    // override_reason — lets the route tell admins how to override.
    this.adminOverrideAvailable = !!opts.adminOverrideAvailable;
  }
}

module.exports = {
  NON_PRO_MIN_PICKUP_GAP_HOURS,
  MESSAGES,
  isProfessional,
  validateAuctionSchedule,
  ScheduleRuleError,
};
