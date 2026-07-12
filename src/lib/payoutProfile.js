'use strict';

/**
 * payoutProfile — PURE Seller Payout Profile helpers (Increment 5). No DB, no secrets.
 *
 * Security invariant: maskedPayoutSummary() is the ONLY shape returned to any client
 * (seller or admin). It NEVER includes a routing number, account number, full account
 * identifier, or the Stripe-managed reference/token — only safe display data.
 */

const PAYOUT_STATUS = Object.freeze({ INCOMPLETE: 'incomplete', NEEDS_ATTENTION: 'needs_attention', READY: 'ready' });
const PAYOUT_STATUS_LABEL = Object.freeze({ incomplete: 'Incomplete', needs_attention: 'Needs Attention', ready: 'Ready for Payment' });

// Future-ready placeholder only. No functional impact today.
const TAX_STATUS = Object.freeze({ NOT_STARTED: 'not_started', IN_PROGRESS: 'in_progress', COMPLETED: 'completed' });
const TAX_STATUS_LABEL = Object.freeze({ not_started: 'Not Started', in_progress: 'In Progress', completed: 'Completed' });

function isCheckComplete(p) {
  return !!(p && p.check_payee_name && p.check_address_line1 && p.check_city && p.check_state && p.check_postal_code);
}
function isAchComplete(p) {
  return !!(p && p.stripe_bank_account_ref); // Stripe-managed reference present = ready
}

/** Overall readiness: does enough information exist to complete a payout? */
function payoutProfileStatus(pref) {
  if (!pref || !pref.payout_method) return PAYOUT_STATUS.INCOMPLETE;
  if (pref.payout_method === 'check') return isCheckComplete(pref) ? PAYOUT_STATUS.READY : PAYOUT_STATUS.NEEDS_ATTENTION;
  if (pref.payout_method === 'ach') return isAchComplete(pref) ? PAYOUT_STATUS.READY : PAYOUT_STATUS.NEEDS_ATTENTION;
  return PAYOUT_STATUS.INCOMPLETE;
}

/**
 * SAFE masked summary. Deliberately builds a NEW object with an allowlist of display
 * fields — it never spreads the raw row, so a routing/account number or Stripe ref can
 * never leak even if present on the input.
 */
function maskedPayoutSummary(pref) {
  if (!pref || !pref.payout_method) return { method: null, status: PAYOUT_STATUS.INCOMPLETE };
  const status = payoutProfileStatus(pref);
  if (pref.payout_method === 'ach') {
    return {
      method: 'ach',
      status,
      bank_name: pref.bank_name || null,
      account_type: pref.ach_account_type || null, // 'checking' | 'savings'
      last4: pref.ach_account_last4 || null,        // display only, e.g. 4831
      verified: !!pref.is_verified,
    };
  }
  return {
    method: 'check',
    status,
    payee_name: pref.check_payee_name || null,
    address_line1: pref.check_address_line1 || null,
    address_line2: pref.check_address_line2 || null,
    city: pref.check_city || null,
    state: pref.check_state || null,
    postal_code: pref.check_postal_code || null,
  };
}

/**
 * Map a Stripe us_bank_account PaymentMethod (+ SetupIntent status) to the SAFE fields we
 * store. PURE — no Stripe/DB. The stored reference is the Stripe PaymentMethod id (pm_…),
 * never a routing/account number. Throws if the PaymentMethod is not a usable bank account.
 */
function usBankAccountDisplay(paymentMethod, setupIntentStatus) {
  const pm = paymentMethod || {};
  const uba = pm.us_bank_account;
  if (!pm.id || !uba) throw new Error('No US bank account found on this setup');
  return {
    stripe_bank_account_ref: pm.id, // Stripe-managed reference; NOT a routing/account number
    bank_name: uba.bank_name || null,
    ach_account_type: uba.account_type || null,
    ach_account_last4: uba.last4 || null,
    is_verified: setupIntentStatus === 'succeeded',
  };
}

module.exports = {
  PAYOUT_STATUS, PAYOUT_STATUS_LABEL, TAX_STATUS, TAX_STATUS_LABEL,
  payoutProfileStatus, maskedPayoutSummary, isCheckComplete, isAchComplete,
  usBankAccountDisplay,
};
