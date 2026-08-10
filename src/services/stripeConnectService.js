'use strict';

/**
 * stripeConnectService — Version 1.0 Stripe Connect (manual-control Direct Deposit).
 *
 * Creates ONE Express Connected Account per seller who chooses Direct Deposit, requests ONLY
 * the `transfers` capability (the platform stays merchant of record — sellers only RECEIVE
 * transfers), and uses Stripe-HOSTED onboarding (Account Links). Advantage.Bid stores only
 * safe identifiers/status (acct id, capability/payout flags, bank name + last4) — NEVER a
 * routing number, full account number, or raw credentials (Stripe retains those).
 *
 * Money movement (transfers.create) lives in settlementEngine and only runs at explicit Admin
 * approval. This service is onboarding + status only. Everything is gated by
 * STRIPE_CONNECT_ENABLED at the route/UI layer.
 */

const db = require('../db');

const STRIPE_API_VERSION = '2026-03-25.dahlia'; // matches paymentService pin
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured');
  return require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

// ── PURE: map a Stripe Account to the SAFE fields we persist. No DB, no secrets. ──────────
function mapAccountToStatus(account) {
  const a = account || {};
  const caps = a.capabilities || {};
  const transfersActive = caps.transfers === 'active';
  const payoutsEnabled = !!a.payouts_enabled;
  const detailsSubmitted = !!a.details_submitted;
  const disabledReason = (a.requirements && a.requirements.disabled_reason) || null;
  let bankName = null;
  let bankLast4 = null;
  const ext = a.external_accounts && a.external_accounts.data && a.external_accounts.data[0];
  if (ext && ext.object === 'bank_account') { bankName = ext.bank_name || null; bankLast4 = ext.last4 || null; }
  let status;
  if (transfersActive && payoutsEnabled) status = 'ready';
  else if (disabledReason) status = 'restricted';
  else status = 'onboarding';
  return {
    stripe_account_id: a.id || null,
    connect_status: status,
    connect_details_submitted: detailsSubmitted,
    connect_transfers_active: transfersActive,
    connect_payouts_enabled: payoutsEnabled,
    connect_disabled_reason: disabledReason,
    connect_bank_name: bankName,
    connect_bank_last4: bankLast4,
  };
}

// PURE: is this account ready to RECEIVE a transfer/payout?
function isConnectReady(mapped) {
  return !!(mapped && mapped.connect_transfers_active && mapped.connect_payouts_enabled);
}

async function getPref(sellerUserId) {
  return (await db.query('SELECT * FROM seller_payout_preferences WHERE seller_user_id = $1', [sellerUserId])).rows[0] || null;
}

// Persist safe status onto the seller's payout preference (creates the row if missing).
async function persistStatusForSeller(sellerUserId, m) {
  await db.query(
    `INSERT INTO seller_payout_preferences
       (seller_user_id, payout_method, stripe_account_id, connect_status, connect_details_submitted,
        connect_transfers_active, connect_payouts_enabled, connect_disabled_reason, connect_bank_name,
        connect_bank_last4, connect_updated_at, updated_at)
     VALUES ($1,'ach',$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
     ON CONFLICT (seller_user_id) DO UPDATE SET
       stripe_account_id = EXCLUDED.stripe_account_id,
       connect_status = EXCLUDED.connect_status,
       connect_details_submitted = EXCLUDED.connect_details_submitted,
       connect_transfers_active = EXCLUDED.connect_transfers_active,
       connect_payouts_enabled = EXCLUDED.connect_payouts_enabled,
       connect_disabled_reason = EXCLUDED.connect_disabled_reason,
       connect_bank_name = EXCLUDED.connect_bank_name,
       connect_bank_last4 = EXCLUDED.connect_bank_last4,
       connect_updated_at = now(), updated_at = now()`,
    [sellerUserId, m.stripe_account_id, m.connect_status, m.connect_details_submitted,
     m.connect_transfers_active, m.connect_payouts_enabled, m.connect_disabled_reason,
     m.connect_bank_name, m.connect_bank_last4]
  );
}

// Create OR reuse the seller's Connected Account (idempotent — never a second account).
async function ensureConnectAccount(sellerUserId) {
  const pref = await getPref(sellerUserId);
  if (pref && pref.stripe_account_id) return pref.stripe_account_id;
  const stripe = getStripe();
  const acct = await stripe.accounts.create({
    type: 'express',
    country: 'US',
    capabilities: { transfers: { requested: true } }, // ONLY transfers — no card_payments
    business_profile: { product_description: 'Advantage.Bid auction seller payouts' },
    metadata: { seller_user_id: String(sellerUserId), platform: 'advantage.bid' },
  });
  await db.query(
    `INSERT INTO seller_payout_preferences (seller_user_id, payout_method, stripe_account_id, connect_status, connect_updated_at, updated_at)
     VALUES ($1,'ach',$2,'onboarding',now(),now())
     ON CONFLICT (seller_user_id) DO UPDATE SET
       payout_method='ach', stripe_account_id=EXCLUDED.stripe_account_id,
       connect_status='onboarding', connect_updated_at=now(), updated_at=now()`,
    [sellerUserId, acct.id]
  );
  return acct.id;
}

// Stripe-hosted onboarding link (account_onboarding). Resume uses the same call.
async function createOnboardingLink(sellerUserId, { returnUrl, refreshUrl }) {
  if (!returnUrl || !refreshUrl) throw new Error('returnUrl and refreshUrl are required');
  const accountId = await ensureConnectAccount(sellerUserId);
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    return_url: returnUrl,
    refresh_url: refreshUrl,
  });
  return { url: link.url, expires_at: link.expires_at, stripe_account_id: accountId };
}

// Retrieve the live account, persist mapped safe status, and return it.
async function refreshAccountStatus(sellerUserId) {
  const pref = await getPref(sellerUserId);
  if (!pref || !pref.stripe_account_id) return null;
  const stripe = getStripe();
  const acct = await stripe.accounts.retrieve(pref.stripe_account_id);
  const mapped = mapAccountToStatus(acct);
  await persistStatusForSeller(sellerUserId, mapped);
  return mapped;
}

// Webhook account.updated — persist mapped status keyed by the connected account id.
async function applyAccountUpdated(account) {
  const mapped = mapAccountToStatus(account);
  if (!mapped.stripe_account_id) return { updated: 0 };
  const r = await db.query(
    `UPDATE seller_payout_preferences SET
       connect_status=$2, connect_details_submitted=$3, connect_transfers_active=$4,
       connect_payouts_enabled=$5, connect_disabled_reason=$6, connect_bank_name=$7,
       connect_bank_last4=$8, connect_updated_at=now(), updated_at=now()
     WHERE stripe_account_id=$1`,
    [mapped.stripe_account_id, mapped.connect_status, mapped.connect_details_submitted,
     mapped.connect_transfers_active, mapped.connect_payouts_enabled, mapped.connect_disabled_reason,
     mapped.connect_bank_name, mapped.connect_bank_last4]
  );
  return { updated: r.rowCount, status: mapped.connect_status };
}

// Webhook payout.paid / payout.failed — connected-account health (event.account). Aggregate,
// not per-settlement; updates the seller's payout health + reason. Never marks a settlement paid.
async function applyPayoutEvent(accountId, { failed = false, failureMessage = null } = {}) {
  if (!accountId) return { updated: 0 };
  const r = await db.query(
    `UPDATE seller_payout_preferences SET
       connect_payouts_enabled = CASE WHEN $2 THEN connect_payouts_enabled ELSE connect_payouts_enabled END,
       connect_disabled_reason = CASE WHEN $2 THEN COALESCE($3, connect_disabled_reason) ELSE connect_disabled_reason END,
       connect_updated_at = now(), updated_at = now()
     WHERE stripe_account_id = $1`,
    [accountId, failed, failureMessage]
  );
  return { updated: r.rowCount };
}

module.exports = {
  STRIPE_API_VERSION, getStripe,
  mapAccountToStatus, isConnectReady,
  ensureConnectAccount, createOnboardingLink, refreshAccountStatus,
  applyAccountUpdated, applyPayoutEvent,
  persistStatusForSeller, getPref,
};
