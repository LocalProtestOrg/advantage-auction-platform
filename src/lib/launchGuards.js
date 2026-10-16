'use strict';

// Small pure guard predicates for launch-stabilization fixes (M2, L1). Kept pure +
// exported so the admin routes and the unit tests share one source of truth.

// M2: an invoice is "paid" if either the invoice row or its linked payment is paid.
// Used to refuse resending the "payment required" email for a paid invoice.
function isInvoicePaid({ invoiceStatus, paymentStatus } = {}) {
  return invoiceStatus === 'paid' || paymentStatus === 'paid';
}

// L1: seller settlements (and the payout-bearing final report) are OFF unless the
// SELLER_SETTLEMENTS_ENABLED env flag is exactly 'true'. Default (unset) = disabled.
function sellerSettlementsEnabled(env = process.env) {
  return env && env.SELLER_SETTLEMENTS_ENABLED === 'true';
}

// Design C: combined per-buyer invoicing + off-session auto-charge + held seller closeout is OFF
// unless COMBINED_INVOICING_ENABLED is exactly 'true'. Default (unset) = disabled, so auction
// close keeps using the proven per-lot invoice + on-session Pay Now path until this is validated.
function combinedInvoicingEnabled(env = process.env) {
  return !!(env && env.COMBINED_INVOICING_ENABLED === 'true');
}

// V1.0 Stripe Connect manual-control Direct Deposit is OFF unless STRIPE_CONNECT_ENABLED is
// exactly 'true'. Default (unset) = disabled: no Connect account is created, the seller
// Direct Deposit UI is hidden, and Admin "Pay Seller" (Stripe transfer) is unavailable — so
// deploying this code changes nothing until the owner enables Connect in the Stripe Dashboard
// AND sets this flag. Real seller-money movement stays gated behind BOTH this and
// SELLER_SETTLEMENTS_ENABLED.
function stripeConnectEnabled(env = process.env) {
  return !!(env && env.STRIPE_CONNECT_ENABLED === 'true');
}

// Fixed-price Marketplace Buy Now checkout is OFF unless MARKETPLACE_CHECKOUT_ENABLED is exactly 'true'.
// Default (unset) = disabled: the public item page keeps the "Contact Seller" path and the checkout API
// refuses to create orders/PaymentIntents. Deploying the commerce code changes nothing for real buyers
// until the owner sets this flag. Stripe LIVE is a SEPARATE gate (STRIPE_SECRET_KEY mode) — this flag
// never activates live money on its own.
function marketplaceCheckoutEnabled(env = process.env) {
  return !!(env && env.MARKETPLACE_CHECKOUT_ENABLED === 'true');
}

// Individual "$39 Estate Sale Promotion" (Phase 2B, commit 4e52997) is DISABLED by owner decision
// (2026-10-12: never owner-approved, zero purchases). This is a hard-coded constant on purpose, NOT an
// env flag: no environment variable (including STRIPE_ESTATE_SALE_PRICE_ID) can re-open purchase.
// Re-enabling requires a deliberate code change + owner approval. Historical purchase records, the
// service, migration 105 tables and webhook handling are intentionally kept so old data stays readable.
// See docs/archive/estate-sale-promotion/README.md.
const ESTATE_SALE_PROMOTION_ENABLED = false;
function estateSalePromotionEnabled() {
  return ESTATE_SALE_PROMOTION_ENABLED === true;
}

// Professional Seller staff accounts (migration 199) are OFF unless SELLER_STAFF_ENABLED is exactly 'true'. Default (unset)
// = disabled: no invitation can be sent or accepted and every seller route resolves the company OWNER only, exactly as
// before. Turning it off again immediately stops every staff member's access (memberships are checked on each request).
function sellerStaffEnabled(env = process.env) {
  return !!(env && env.SELLER_STAFF_ENABLED === 'true');
}

// One-company pilot (owner-approved 2026-10-16): while SELLER_STAFF_ENABLED is off, staff accounts work ONLY for the seller
// companies (seller_profiles ids) listed in SELLER_STAFF_PILOT_SELLER_IDS (comma-separated). Every other company behaves
// exactly as if staff accounts were off. Unset / empty = no pilot.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function sellerStaffPilotIds(env = process.env) {
  return String((env && env.SELLER_STAFF_PILOT_SELLER_IDS) || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter((s) => UUID_RE.test(s));
}
function sellerStaffEnabledFor(sellerId, env = process.env) {
  if (sellerStaffEnabled(env)) return true;
  return !!sellerId && sellerStaffPilotIds(env).includes(String(sellerId).toLowerCase());
}
// Whether staff accounts can be in use anywhere (general switch on, or a pilot company configured).
function sellerStaffAvailableAnywhere(env = process.env) { return sellerStaffEnabled(env) || sellerStaffPilotIds(env).length > 0; }

module.exports = { sellerStaffEnabled, sellerStaffEnabledFor, sellerStaffPilotIds, sellerStaffAvailableAnywhere, isInvoicePaid, sellerSettlementsEnabled, combinedInvoicingEnabled, stripeConnectEnabled, marketplaceCheckoutEnabled, ESTATE_SALE_PROMOTION_ENABLED, estateSalePromotionEnabled };
