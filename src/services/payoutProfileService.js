'use strict';

/**
 * payoutProfileService — Seller Payout Profile data layer (Increment 5). Reuses
 * seller_payout_preferences. NEVER stores a routing/account number: ACH is stored as a
 * Stripe-managed reference + safe display fields only (bank_name/last4/account_type).
 */

const db = require('../db');
const { TAX_STATUS } = require('../lib/payoutProfile');

async function getProfile(sellerUserId) {
  const r = await db.query('SELECT * FROM seller_payout_preferences WHERE seller_user_id = $1', [sellerUserId]);
  return r.rows[0] || null;
}

// Upsert a whitelisted set of columns for one seller.
async function upsert(sellerUserId, fields) {
  const cols = Object.keys(fields);
  const vals = Object.values(fields);
  cols.push('updated_at'); vals.push(new Date());
  const insertCols = ['seller_user_id', ...cols].join(', ');
  const insertVals = ['$1', ...cols.map((_, i) => `$${i + 2}`)].join(', ');
  const setList = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const r = await db.query(
    `INSERT INTO seller_payout_preferences (${insertCols}) VALUES (${insertVals})
     ON CONFLICT (seller_user_id) DO UPDATE SET ${setList} RETURNING *`,
    [sellerUserId, ...vals]
  );
  return r.rows[0];
}

async function saveCheckProfile(sellerUserId, { payee_name, address_line1, address_line2 = null, city, state, postal_code }) {
  if (!payee_name || !address_line1 || !city || !state || !postal_code) {
    throw new Error('Check payout requires a payee name and full mailing address');
  }
  return upsert(sellerUserId, {
    payout_method: 'check',
    check_payee_name: payee_name, check_address_line1: address_line1, check_address_line2: address_line2,
    check_city: city, check_state: state, check_postal_code: postal_code,
    setup_completed_at: new Date(),
  });
}

// Stores ONLY Stripe-managed reference + safe display (obtained via attachStripeBankAccount).
async function saveAchProfile(sellerUserId, { stripe_bank_account_ref, bank_name = null, ach_account_type = null, ach_account_last4 = null, is_verified = false }) {
  if (!stripe_bank_account_ref) throw new Error('ACH payout requires a Stripe-managed bank reference');
  return upsert(sellerUserId, {
    payout_method: 'ach',
    stripe_bank_account_ref, bank_name, ach_account_type, ach_account_last4, is_verified,
    setup_completed_at: new Date(),
  });
}

async function setTaxStatus(sellerUserId, tax_status) {
  if (!Object.values(TAX_STATUS).includes(tax_status)) throw new Error('Invalid tax_status');
  return upsert(sellerUserId, { tax_status });
}

/**
 * Attach a Stripe bank-account TOKEN (created client-side by Stripe.js — raw routing/
 * account numbers never touch our server) to the seller's Stripe customer, and return
 * the safe display + Stripe reference. Used by the seller UI (Increment 5B).
 */
async function attachStripeBankAccount(sellerUserId, bankAccountToken) {
  if (!bankAccountToken) throw new Error('A Stripe bank account token is required');
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured');
  const cardService = require('./cardService');
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const customerId = await cardService.ensureStripeCustomer(sellerUserId);
  const src = await stripe.customers.createSource(customerId, { source: bankAccountToken });
  return {
    stripe_bank_account_ref: src.id,
    bank_name: src.bank_name || null,
    ach_account_type: src.account_type || null,
    ach_account_last4: src.last4 || null,
    is_verified: src.status === 'verified',
  };
}

module.exports = { getProfile, saveCheckProfile, saveAchProfile, setTaxStatus, attachStripeBankAccount };
