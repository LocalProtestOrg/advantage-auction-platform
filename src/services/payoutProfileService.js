'use strict';

/**
 * payoutProfileService — Seller Payout Profile data layer (Increment 5). Reuses
 * seller_payout_preferences. NEVER stores a routing/account number: ACH is stored as a
 * Stripe-managed reference + safe display fields only (bank_name/last4/account_type).
 */

const db = require('../db');
const { TAX_STATUS, usBankAccountDisplay } = require('../lib/payoutProfile');
const { isLiveMode, maskPayoutPrefForMode } = require('../lib/stripeMode');

// Other-mode (e.g. TEST after the switch to LIVE) connected-account / bank references are hidden, so the
// seller is asked to set up direct deposit again. The stored row is kept unchanged for history.
async function getProfile(sellerUserId) {
  const r = await db.query('SELECT * FROM seller_payout_preferences WHERE seller_user_id = $1', [sellerUserId]);
  return maskPayoutPrefForMode(r.rows[0] || null);
}

// Upsert a whitelisted set of columns for one seller. Every payout-detail change is audited (field names + masked values
// only) and the seller is emailed (payoutSafeguards); replacing an existing payout destination needs the account's current
// password (options.currentPassword). The tax placeholder is not a payout detail and is not audited here.
async function upsert(sellerUserId, fields, options = {}) {
  const cols = Object.keys(fields);
  const vals = Object.values(fields);
  cols.push('updated_at'); vals.push(new Date());
  const insertCols = ['seller_user_id', ...cols].join(', ');
  const insertVals = ['$1', ...cols.map((_, i) => `$${i + 2}`)].join(', ');
  const setList = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const safeguards = require('./payoutSafeguards');
  const { withTransaction } = require('../utils/withTransaction');
  // Identity first, outside the transaction, so a failed attempt is always counted; the transaction then re-checks that
  // the destination it is replacing is still the one that was confirmed.
  let seen = null;
  if (options.source) {
    seen = (await db.query('SELECT * FROM seller_payout_preferences WHERE seller_user_id = $1', [sellerUserId])).rows[0] || null;
    await safeguards.assertIdentityForDestinationChange(sellerUserId, { before: seen, after: { ...(seen || {}), ...fields },
      currentPassword: options.currentPassword, verificationCode: options.verificationCode });
  }
  const out = await withTransaction(async (client) => {
    const before = (await client.query('SELECT * FROM seller_payout_preferences WHERE seller_user_id = $1 FOR UPDATE', [sellerUserId])).rows[0] || null;
    if (options.source && safeguards.destinationFingerprint(before) !== safeguards.destinationFingerprint(seen)) {
      throw new safeguards.PayoutSafeguardError('CHANGED', 'Your payout details changed while you were editing. Please try again.', 409);
    }
    const r = await client.query(
      `INSERT INTO seller_payout_preferences (${insertCols}) VALUES (${insertVals})
       ON CONFLICT (seller_user_id) DO UPDATE SET ${setList} RETURNING *`,
      [sellerUserId, ...vals]
    );
    const row = r.rows[0];
    const diff = options.source
      ? await safeguards.recordPayoutDetailsChange(client, { sellerUserId, actorId: sellerUserId, source: options.source, before, after: row })
      : null;
    return { row, diff };
  });
  if (out.diff) safeguards.notifySellerPayoutDetailsChanged(sellerUserId, out.diff).catch(() => {});
  return out.row;
}

async function saveCheckProfile(sellerUserId, { payee_name, address_line1, address_line2 = null, city, state, postal_code, current_password = null, verification_code = null }) {
  if (!payee_name || !address_line1 || !city || !state || !postal_code) {
    throw new Error('Check payout requires a payee name and full mailing address');
  }
  return upsert(sellerUserId, {
    payout_method: 'check',
    check_payee_name: payee_name, check_address_line1: address_line1, check_address_line2: address_line2,
    check_city: city, check_state: state, check_postal_code: postal_code,
    setup_completed_at: new Date(),
  }, { source: 'payout_profile_check', currentPassword: current_password, verificationCode: verification_code });
}

// Stores ONLY Stripe-managed reference + safe display (obtained via attachStripeBankAccount).
async function saveAchProfile(sellerUserId, { stripe_bank_account_ref, bank_name = null, ach_account_type = null, ach_account_last4 = null, is_verified = false }, options = {}) {
  if (!stripe_bank_account_ref) throw new Error('ACH payout requires a Stripe-managed bank reference');
  return upsert(sellerUserId, {
    payout_method: 'ach',
    stripe_bank_account_ref, bank_name, ach_account_type, ach_account_last4, is_verified,
    stripe_bank_account_livemode: isLiveMode(),
    setup_completed_at: new Date(),
  }, { source: 'payout_profile_bank', currentPassword: options.currentPassword, verificationCode: options.verificationCode });
}

async function setTaxStatus(sellerUserId, tax_status) {
  if (!Object.values(TAX_STATUS).includes(tax_status)) throw new Error('Invalid tax_status');
  return upsert(sellerUserId, { tax_status });
}

/**
 * ACH via the CURRENT Stripe-recommended flow: SetupIntent + us_bank_account collected
 * through Financial Connections (verified against Stripe docs, 2026-07). Raw routing/
 * account numbers are collected by Stripe.js and never reach our server.
 *
 * createAchSetupIntent: server creates the SetupIntent on the seller's Stripe customer and
 * returns the client_secret; Stripe.js (collectBankAccountForSetup / confirmUsBankAccountSetup)
 * completes it client-side. NO webhook is used — the server retrieves the SetupIntent on
 * demand in confirmAchSetupIntent and stores only the PaymentMethod reference + safe display.
 */
async function createAchSetupIntent(sellerUserId) {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured');
  const cardService = require('./cardService');
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const customerId = await cardService.ensureStripeCustomer(sellerUserId);
  const si = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['us_bank_account'],
    usage: 'off_session',
  });
  return { client_secret: si.client_secret, setup_intent_id: si.id, publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || '' };
}

async function confirmAchSetupIntent(sellerUserId, setupIntentId, options = {}) {
  if (!setupIntentId) throw new Error('A setup_intent_id is required');
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured');
  const cardService = require('./cardService');
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const customerId = await cardService.ensureStripeCustomer(sellerUserId);
  const si = await stripe.setupIntents.retrieve(setupIntentId, { expand: ['payment_method'] });
  // Ownership guard: a seller can only confirm a SetupIntent that belongs to their own customer.
  if (si.customer !== customerId) throw new Error('SetupIntent does not belong to this seller');
  const display = usBankAccountDisplay(si.payment_method, si.status); // pure; stores pm ref + safe display only
  return saveAchProfile(sellerUserId, display, { currentPassword: options.currentPassword, verificationCode: options.verificationCode });
}

module.exports = { getProfile, saveCheckProfile, saveAchProfile, setTaxStatus, createAchSetupIntent, confirmAchSetupIntent };
