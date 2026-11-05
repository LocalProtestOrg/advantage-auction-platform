'use strict';

/**
 * Auction shipping policy (owner decisions 2026-11-04 and 2026-11-05; spec docs/projects/auction-shipping-spec.md).
 * The ONE place that holds the shipping constants, the buyer label rule, the payout-release date rule and the
 * "may this seller offer shipping?" rule. Pure (no database): callers supply the facts.
 *
 *   • Off by default: nothing here is used publicly unless AUCTION_SHIPPING_ENABLED=true.
 *   • Local Pickup is the default. A lot ships only when it was explicitly marked eligible.
 *   • Labels come from the lots' eligibility, never from the auction toggle alone.
 *   • $500 total item value per shipment for a newly approved shipping seller (admin-adjustable per seller).
 *   • Tracking on every shipment; signature confirmation above $500 total item value (admin override, audited).
 *   • Shipped-lot payout hold: confirmed delivery + 3 US Eastern business days (subject to risk review, the payment
 *     provider's requirements and final legal review).
 */

const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');

const DEFAULT_PER_SHIPMENT_LIMIT_CENTS = 50000;   // $500 total item value per shipment
const SIGNATURE_THRESHOLD_CENTS = 50000;          // signature required ABOVE $500 total item value
const PAYOUT_HOLD_BUSINESS_DAYS = 3;              // after confirmed delivery
const BUSINESS_TIMEZONE = 'America/New_York';
const EDUCATION_VERSION = '2026-11-05';
const MAX_RESTRICTION_LENGTH = 300;

function auctionShippingEnabled(env = process.env) {
  return String(env.AUCTION_SHIPPING_ENABLED || '').trim().toLowerCase() === 'true';
}

// ── Labels ───────────────────────────────────────────────────────────────────────────────────────────────────
const LABELS = Object.freeze({ SHIPPING_AVAILABLE: 'shipping_available', LIMITED_SHIPPING: 'limited_shipping', LOCAL_PICKUP: 'local_pickup' });
const LABEL_TEXT = Object.freeze({
  shipping_available: 'Shipping Available',
  limited_shipping: 'Limited Shipping',
  local_pickup: 'Local Pickup',
});

const usd = (cents) => '$' + (Number(cents) / 100).toFixed(2);

function localPickupSummary() {
  return {
    label: LABELS.LOCAL_PICKUP,
    label_text: LABEL_TEXT.local_pickup,
    ships: false,
    local_pickup: true,
    terms: ['Local pickup only. This lot does not ship.'],
  };
}

/**
 * Buyer-facing shipping summary for ONE lot.
 *   lot:     { shipping_eligible, shipping_quote_required, shipping_restriction }
 *   profile: the lot's shipping profile { method, flat_rate_cents, handling_days, excluded_states, archived_at } or null
 *   options: { maxItemValueCents } the seller's per-shipment limit (shown so a buyer never assumes a large order ships)
 * A lot without eligibility, or whose shipping settings are missing, is Local Pickup.
 * Shipping Available = ships at a shown rate with no restriction. Any restriction (quote required, excluded states,
 * restriction text) = Limited Shipping.
 */
function lotShippingSummary(lot, profile, options = {}) {
  if (!lot || lot.shipping_eligible !== true || !profile) return localPickupSummary();
  const quoteRequired = lot.shipping_quote_required === true || profile.method === 'quote_required' || profile.flat_rate_cents == null;
  const excluded = Array.isArray(profile.excluded_states) ? profile.excluded_states.filter(Boolean) : [];
  const restriction = typeof lot.shipping_restriction === 'string' && lot.shipping_restriction.trim() ? lot.shipping_restriction.trim() : null;
  const limited = quoteRequired || excluded.length > 0 || !!restriction;
  const label = limited ? LABELS.LIMITED_SHIPPING : LABELS.SHIPPING_AVAILABLE;
  const maxItemValueCents = options.maxItemValueCents == null ? DEFAULT_PER_SHIPMENT_LIMIT_CENTS : Number(options.maxItemValueCents);

  const terms = [];
  terms.push(excluded.length ? 'Ships within the United States, except to: ' + excluded.join(', ') + '.' : 'Ships within the United States.');
  terms.push(quoteRequired ? 'Shipping cost is quoted after the auction closes.' : 'Estimated shipping: ' + usd(profile.flat_rate_cents) + '.');
  if (profile.handling_days) terms.push('Ships within ' + profile.handling_days + ' business day' + (Number(profile.handling_days) === 1 ? '' : 's') + ' after payment.');
  if (restriction) terms.push(restriction);
  terms.push('Shipping is offered on orders up to ' + usd(maxItemValueCents) + ' in total item value. Larger orders are local pickup only.');
  terms.push('Every shipment has tracking. Orders above ' + usd(SIGNATURE_THRESHOLD_CENTS) + ' in total item value need a signature on delivery.');
  terms.push('Local pickup is also available.');

  return {
    label,
    label_text: LABEL_TEXT[label],
    ships: true,
    local_pickup: true,
    quote_required: quoteRequired,
    flat_rate_cents: quoteRequired ? null : Number(profile.flat_rate_cents),
    handling_days: profile.handling_days == null ? null : Number(profile.handling_days),
    excluded_states: excluded,
    restriction,
    max_item_value_cents: maxItemValueCents,
    terms,
  };
}

/**
 * Auction label from its lots' summaries (withdrawn lots excluded by the caller).
 * No lot ships → Local Pickup. EVERY lot is Shipping Available → Shipping Available. Anything in between (some lots
 * pickup only, or any lot with a restriction) → Limited Shipping. An auction can never claim Shipping Available while
 * any lot is pickup only.
 */
function auctionShippingLabel(lotSummaries) {
  const list = Array.isArray(lotSummaries) ? lotSummaries : [];
  const shipping = list.filter((s) => s && s.ships === true).length;
  let label;
  if (!list.length || shipping === 0) label = LABELS.LOCAL_PICKUP;
  else if (list.every((s) => s && s.label === LABELS.SHIPPING_AVAILABLE)) label = LABELS.SHIPPING_AVAILABLE;
  else label = LABELS.LIMITED_SHIPPING;
  return { label, label_text: LABEL_TEXT[label], shipping_lot_count: shipping, lot_count: list.length };
}

// ── Who may offer shipping ──────────────────────────────────────────────────────────────────────────────────
/**
 * facts: { sellerType, capabilities, verificationBlocked (publicationGate.blocked), isActive, acknowledgedAt }
 *   Professional Seller: allowed when the verification publication gate is not blocked.
 *   Individual Seller:   allowed only with the admin-set, audited capabilities.shipping_enabled approval.
 *   Either way the seller must have acknowledged the payout and fraud education once before turning shipping on.
 * Returns { eligible, can_enable, reason, needs_acknowledgment }. Admin overrides are handled by the caller (audited).
 */
function sellerShippingEligibility(facts = {}) {
  const professional = PROFESSIONAL_SELLER_TYPES.includes(facts.sellerType);
  let eligible = false; let reason;
  if (facts.isActive === false) reason = 'seller_inactive';
  else if (professional) {
    if (facts.verificationBlocked === true) reason = 'verification_required';
    else { eligible = true; reason = 'professional_verified'; }
  } else {
    const caps = facts.capabilities && typeof facts.capabilities === 'object' ? facts.capabilities : {};
    if (caps.shipping_enabled === true) { eligible = true; reason = 'individual_approved'; }
    else reason = 'approval_required';
  }
  const acknowledged = !!facts.acknowledgedAt;
  return { eligible, can_enable: eligible && acknowledged, reason, needs_acknowledgment: eligible && !acknowledged, professional };
}

const ELIGIBILITY_MESSAGES = {
  seller_inactive: 'Your seller account is not active, so shipping cannot be offered.',
  verification_required: 'Shipping becomes available once Advantage.Bid has verified your business.',
  approval_required: 'Shipping is available to Individual Sellers only after Advantage.Bid approves it for your account. Local Pickup stays the default.',
  needs_acknowledgment: 'Please review and acknowledge how shipping affects your payout before you turn shipping on.',
};

function perShipmentLimitCents(storedLimit) {
  const n = storedLimit == null ? NaN : Number(storedLimit);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_PER_SHIPMENT_LIMIT_CENTS;
}

function signatureRequired(totalItemValueCents) {
  return Number(totalItemValueCents) > SIGNATURE_THRESHOLD_CENTS;
}

/**
 * Shipment rule check (enforced at fulfillment time in Phase 3; defined now so the rule has one home).
 * shipment: { itemValueCents, limitCents, trackingNumber, signatureConfirmation, adminSignatureOverride, adminLimitOverride }
 * Returns a list of violation codes (empty = allowed).
 */
function shipmentViolations(shipment = {}) {
  const v = [];
  const value = Number(shipment.itemValueCents) || 0;
  if (value > perShipmentLimitCents(shipment.limitCents) && !shipment.adminLimitOverride) v.push('over_per_shipment_limit');
  if (!shipment.trackingNumber || !String(shipment.trackingNumber).trim()) v.push('tracking_required');
  if (signatureRequired(value) && !shipment.signatureConfirmation && !shipment.adminSignatureOverride) v.push('signature_required');
  return v;
}

// ── Payout release date: confirmed delivery + 3 US Eastern business days ──────────────────────────────────────────
// Business day = Monday to Friday, excluding US federal holidays (observed dates: a Saturday holiday is observed on
// Friday, a Sunday holiday on Monday), the days the banking system and the payment provider's payouts do not move.
// The rule: take the delivery's Eastern calendar date, count 3 business days AFTER it, and release at the END of the
// third one (00:00 Eastern the following day). So a seller is always held at least 3 full business days, whatever the
// delivery hour. Example: delivered any time Monday (no holiday) → release Friday 00:00 Eastern.

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);

function nthWeekday(year, month, weekday, n) {      // month 1-12, weekday 0=Sun; n>=1 or -1 for last
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastWd = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((lastWd - weekday + 7) % 7);
}
function observed(year, month, day) {
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dt = new Date(Date.UTC(year, month - 1, day + (wd === 6 ? -1 : wd === 0 ? 1 : 0)));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
const holidayCache = new Map();
function usFederalHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const s = new Set([
    observed(year, 1, 1),                        // New Year's Day
    ymd(year, 1, nthWeekday(year, 1, 1, 3)),     // Birthday of Martin Luther King, Jr.
    ymd(year, 2, nthWeekday(year, 2, 1, 3)),     // Washington's Birthday
    ymd(year, 5, nthWeekday(year, 5, 1, -1)),    // Memorial Day
    observed(year, 6, 19),                       // Juneteenth
    observed(year, 7, 4),                        // Independence Day
    ymd(year, 9, nthWeekday(year, 9, 1, 1)),     // Labor Day
    ymd(year, 10, nthWeekday(year, 10, 1, 2)),   // Columbus Day
    observed(year, 11, 11),                      // Veterans Day
    ymd(year, 11, nthWeekday(year, 11, 4, 4)),   // Thanksgiving Day
    observed(year, 12, 25),                      // Christmas Day
  ]);
  // New Year's Day of the NEXT year observed on Dec 31 of this year.
  const nextNy = observed(year + 1, 1, 1);
  if (nextNy.startsWith(String(year))) s.add(nextNy);
  holidayCache.set(year, s);
  return s;
}

function isBusinessDay(y, m, d) {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !usFederalHolidays(y).has(ymd(y, m, d));
}

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
function easternParts(instant) {
  const p = {};
  for (const x of etFormatter.formatToParts(instant)) p[x.type] = x.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute) };
}
// 00:00 Eastern on a calendar date, as an instant (Eastern midnight is 04:00 or 05:00 UTC; DST changes at 02:00).
function easternMidnight(y, m, d) {
  for (const utcHour of [4, 5]) {
    const t = new Date(Date.UTC(y, m - 1, d, utcHour));
    const p = easternParts(t);
    if (p.y === y && p.m === m && p.d === d && p.h === 0 && p.min === 0) return t;
  }
  throw new Error('could not resolve Eastern midnight for ' + ymd(y, m, d));
}

/** The instant the payout for a shipped lot may be released (before risk review and provider constraints). */
function payoutReleaseAt(deliveredAt, businessDays = PAYOUT_HOLD_BUSINESS_DAYS) {
  const t = deliveredAt instanceof Date ? deliveredAt : new Date(deliveredAt);
  if (Number.isNaN(t.getTime())) throw new Error('payoutReleaseAt: deliveredAt is not a valid date');
  const { y, m, d } = easternParts(t);
  let cur = new Date(Date.UTC(y, m - 1, d));
  let counted = 0;
  while (counted < businessDays) {
    cur = new Date(cur.getTime() + 86400000);
    if (isBusinessDay(cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate())) counted++;
  }
  const next = new Date(cur.getTime() + 86400000);   // end of the last counted business day
  return easternMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

// ── Seller education (shown once before shipping is turned on; acknowledged) ──────────────────────────────────────
const PAYOUT_EXPLANATION =
  'Shipping changes when you are paid. For local pickup, your payout follows the normal schedule. For a shipped lot, '
  + 'your payout for that lot is held until the carrier confirms delivery, plus 3 business days. It can take longer if a '
  + 'sale needs a risk review or the payment processor requires it.';

const EDUCATION_POINTS = [
  PAYOUT_EXPLANATION,
  'New shipping sellers can ship orders up to $500 in total item value per shipment. Advantage.Bid can raise your limit over time.',
  'Every shipment needs a tracking number. Orders above $500 in total item value also need signature confirmation on delivery.',
  'You are responsible for packing items safely and shipping them within the handling time you choose.',
  'Never ship before Advantage.Bid shows the invoice as paid.',
  'Only ship to the address on the Advantage.Bid invoice. Refuse requests to ship somewhere else or to forward a package: that is how reshipping and triangulation scams work.',
  'Never accept payment outside Advantage.Bid.',
  'Photograph each item as you pack it and keep your shipping receipts.',
];

const SHIPPING_PROFILE_DEFAULTS = Object.freeze({
  name: 'Standard shipping', method: 'quote_required', flat_rate_cents: null, handling_days: 3, destinations: 'domestic_us', excluded_states: [], packaging_note: null,
});

const US_STATE_CODES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX',
  'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR'];

module.exports = {
  DEFAULT_PER_SHIPMENT_LIMIT_CENTS, SIGNATURE_THRESHOLD_CENTS, PAYOUT_HOLD_BUSINESS_DAYS, BUSINESS_TIMEZONE, EDUCATION_VERSION,
  MAX_RESTRICTION_LENGTH, LABELS, LABEL_TEXT, ELIGIBILITY_MESSAGES, PAYOUT_EXPLANATION, EDUCATION_POINTS, SHIPPING_PROFILE_DEFAULTS, US_STATE_CODES,
  auctionShippingEnabled, lotShippingSummary, auctionShippingLabel, sellerShippingEligibility, perShipmentLimitCents,
  signatureRequired, shipmentViolations, payoutReleaseAt, usFederalHolidays, isBusinessDay,
};
