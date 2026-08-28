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

module.exports = { isInvoicePaid, sellerSettlementsEnabled, combinedInvoicingEnabled, stripeConnectEnabled, marketplaceCheckoutEnabled };
