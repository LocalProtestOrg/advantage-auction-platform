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

module.exports = { isInvoicePaid, sellerSettlementsEnabled };
