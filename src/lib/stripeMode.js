'use strict';

/**
 * stripeMode — one place that answers "which payment-provider mode is this server running in?"
 *
 * The mode is DERIVED from the configured keys (never a separate flag that could drift):
 *   secret key      sk_live_ / rk_live_  → live      sk_test_ / rk_test_  → test
 *   publishable key pk_live_             → live      pk_test_             → test
 *
 * Every record that points at a provider object (customer, saved card, connected account, bank
 * reference) is stamped with the mode it was created in. Lookups only use records from the CURRENT mode,
 * so switching from TEST to LIVE keys automatically asks every buyer to add a card again and every seller
 * to set up direct deposit again — no TEST id is ever used under LIVE keys (and vice versa). Old rows are
 * kept for history; they are simply ignored.
 *
 * Fail-closed rule: when the secret and publishable keys are from different modes the payment endpoints
 * answer 503 instead of charging (see requireConsistentStripeMode).
 */

function secretKeyMode(key) {
  const k = String(key || '').trim();
  if (/^(sk|rk)_live_/.test(k)) return 'live';
  if (/^(sk|rk)_test_/.test(k)) return 'test';
  return null;
}

function publishableKeyMode(key) {
  const k = String(key || '').trim();
  if (/^pk_live_/.test(k)) return 'live';
  if (/^pk_test_/.test(k)) return 'test';
  return null;
}

// The mode every write is stamped with. Anything that is not a live secret key is treated as TEST, so a
// missing/odd key can never cause a record to be treated as LIVE.
function isLiveMode(env = process.env) {
  return secretKeyMode(env.STRIPE_SECRET_KEY) === 'live';
}

// Consistency between the secret and publishable key. A missing publishable key is not a mismatch
// (server-only flows still work; card forms just cannot load), but two DIFFERENT known modes are.
function modeConsistency(env = process.env) {
  const secretMode = secretKeyMode(env.STRIPE_SECRET_KEY);
  const publishableMode = publishableKeyMode(env.STRIPE_PUBLISHABLE_KEY);
  const mismatch = !!(secretMode && publishableMode && secretMode !== publishableMode);
  return {
    ok: !mismatch,
    secretMode,
    publishableMode,
    reason: mismatch ? `secret key is ${secretMode} but publishable key is ${publishableMode}` : null,
  };
}

// Startup check. Logs loudly on a mismatch; never prints key material (only the derived mode).
function logStartupModeCheck(env = process.env, logger = console) {
  const c = modeConsistency(env);
  if (!c.ok) {
    logger.error('[stripe-mode] *** KEY MODE MISMATCH *** ' + c.reason
      + ' — payment endpoints will refuse requests (503) until the keys are corrected.');
  } else if (c.secretMode) {
    logger.log(`[stripe-mode] payments running in ${c.secretMode.toUpperCase()} mode`
      + (c.publishableMode ? '' : ' (publishable key not set)'));
  }
  return c;
}

const PAYMENTS_UNAVAILABLE_MESSAGE = 'Payments are temporarily unavailable. Please try again shortly.';

// Express middleware: fail closed (503) when the keys disagree. Buyer-facing wording is neutral.
function requireConsistentStripeMode(req, res, next) {
  const c = modeConsistency();
  if (!c.ok) {
    console.error('[stripe-mode] refusing payment request — ' + c.reason, { path: req.originalUrl || req.url });
    return res.status(503).json({ success: false, code: 'PAYMENTS_UNAVAILABLE', message: PAYMENTS_UNAVAILABLE_MESSAGE });
  }
  return next();
}

// Should a webhook event be acted on? Only when its livemode matches the key mode. When the key mode is
// unknown (no/odd key) or the event carries no livemode flag, the event is accepted (legacy behaviour).
function eventMatchesMode(event, env = process.env) {
  const mode = secretKeyMode(env.STRIPE_SECRET_KEY);
  if (!mode || !event || typeof event.livemode !== 'boolean') return true;
  return event.livemode === (mode === 'live');
}

// Seller payout preference rows carry TWO provider references with their own mode stamps:
//   stripe_account_id (+ connect_* status)  → stripe_account_livemode
//   stripe_bank_account_ref (+ its display) → stripe_bank_account_livemode
// Return a COPY with the other-mode references hidden, so readers (settlement, onboarding, profile) behave
// exactly as if the seller had not set up direct deposit yet. The stored row is never modified here.
function maskPayoutPrefForMode(pref, live = isLiveMode()) {
  if (!pref) return pref;
  const out = { ...pref };
  const acctMode = pref.stripe_account_livemode === true;           // NULL / false → test
  if (pref.stripe_account_id && acctMode !== live) {
    out.stripe_account_id = null;
    out.connect_status = null;
    out.connect_details_submitted = false;
    out.connect_transfers_active = false;
    out.connect_payouts_enabled = false;
    out.connect_disabled_reason = null;
    out.connect_bank_name = null;
    out.connect_bank_last4 = null;
    out.stripe_mode_mismatch = true;
  }
  const bankMode = pref.stripe_bank_account_livemode === true;
  if (pref.stripe_bank_account_ref && bankMode !== live) {
    out.stripe_bank_account_ref = null;
    out.bank_name = null;
    out.ach_account_type = null;
    out.ach_account_last4 = null;
    out.is_verified = false;
    out.stripe_mode_mismatch = true;
  }
  return out;
}

module.exports = {
  secretKeyMode,
  publishableKeyMode,
  isLiveMode,
  modeConsistency,
  logStartupModeCheck,
  requireConsistentStripeMode,
  eventMatchesMode,
  maskPayoutPrefForMode,
  PAYMENTS_UNAVAILABLE_MESSAGE,
};
