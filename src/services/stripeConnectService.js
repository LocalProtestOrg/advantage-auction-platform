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

// ── PURE: map a Stripe Accounts-v2 Account to the SAFE fields we persist. No DB, no secrets. ──
// A v2 recipient exposes configuration.recipient.capabilities.stripe_balance.{stripe_transfers,payouts}
// (status 'active' when usable) plus requirements.summary for onboarding state.
function mapAccountToStatus(account) {
  const a = account || {};
  const rec = (a.configuration && a.configuration.recipient) || {};
  const bal = (rec.capabilities && rec.capabilities.stripe_balance) || {};
  const transfers = bal.stripe_transfers || {};
  const payouts = bal.payouts || {};
  const transfersActive = transfers.status === 'active';
  const payoutsActive = payouts.status === 'active';
  const reqStatus = a.requirements && a.requirements.summary && a.requirements.summary.minimum_deadline
    && a.requirements.summary.minimum_deadline.status;
  const detailsSubmitted = reqStatus !== 'past_due' && reqStatus !== 'currently_due';
  const sd = (transfers.status_details && transfers.status_details[0])
    || (payouts.status_details && payouts.status_details[0]) || null;
  const disabledReason = (!transfersActive && sd) ? (sd.code || null) : null;
  let status;
  if (transfersActive && payoutsActive) status = 'ready';
  else if (disabledReason && detailsSubmitted) status = 'restricted';
  else status = 'onboarding';
  return {
    stripe_account_id: a.id || null,
    connect_status: status,
    connect_details_submitted: !!detailsSubmitted,
    connect_transfers_active: transfersActive,
    connect_payouts_enabled: payoutsActive,
    connect_disabled_reason: disabledReason,
    // v2 external-bank display is not fetched in v1.0; the seller UI falls back to "on file with Stripe".
    connect_bank_name: null,
    connect_bank_last4: null,
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

const RETRIEVE_INCLUDE = ['configuration.recipient', 'requirements'];

// Create OR reuse the seller's Accounts-v2 Connected Account (idempotent — never a second account).
async function ensureConnectAccount(sellerUserId) {
  const pref = await getPref(sellerUserId);
  if (pref && pref.stripe_account_id) return pref.stripe_account_id;
  const urow = (await db.query('SELECT email FROM users WHERE id = $1', [sellerUserId])).rows[0];
  const email = (urow && urow.email) || undefined;
  const stripe = getStripe();
  // v2 recipient with the transfers capability (payouts capability is auto-added). Platform stays
  // fees/losses collector (merchant of record). Requests ONLY transfers — no card_payments.
  const acct = await stripe.v2.core.accounts.create({
    contact_email: email,
    dashboard: 'express',
    identity: { country: 'us' },
    defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
    include: ['configuration.recipient'],
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
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

// Stripe-hosted onboarding link (v2 account_onboarding, recipient configuration). Resume = same call.
async function createOnboardingLink(sellerUserId, { returnUrl, refreshUrl }) {
  if (!returnUrl || !refreshUrl) throw new Error('returnUrl and refreshUrl are required');
  const accountId = await ensureConnectAccount(sellerUserId);
  const stripe = getStripe();
  const link = await stripe.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: { configurations: ['recipient'], return_url: returnUrl, refresh_url: refreshUrl },
    },
  });
  return { url: link.url, expires_at: link.expires_at, stripe_account_id: accountId };
}

// Retrieve the live v2 account, map safe status, persist by account id. Shared by the seller
// refresh and the webhook so both read authoritative Stripe status (never a trusted payload shape).
async function syncAccountById(accountId) {
  if (!accountId) return null;
  const stripe = getStripe();
  const acct = await stripe.v2.core.accounts.retrieve(accountId, { include: RETRIEVE_INCLUDE });
  const mapped = mapAccountToStatus(acct);
  await db.query(
    `UPDATE seller_payout_preferences SET
       connect_status=$2, connect_details_submitted=$3, connect_transfers_active=$4,
       connect_payouts_enabled=$5, connect_disabled_reason=$6, connect_updated_at=now(), updated_at=now()
     WHERE stripe_account_id=$1`,
    [mapped.stripe_account_id, mapped.connect_status, mapped.connect_details_submitted,
     mapped.connect_transfers_active, mapped.connect_payouts_enabled, mapped.connect_disabled_reason]
  );
  return mapped;
}

// Retrieve the live account for one seller, persist mapped safe status, and return it.
async function refreshAccountStatus(sellerUserId) {
  const pref = await getPref(sellerUserId);
  if (!pref || !pref.stripe_account_id) return null;
  return syncAccountById(pref.stripe_account_id);   // retrieves live v2 status + persists by account id
}

// Webhook account.updated — re-sync authoritative v2 status by the connected account id in the event.
async function applyAccountUpdated(account) {
  const id = account && (account.id || (account.related_object && account.related_object.id));
  if (!id) return { updated: 0 };
  try {
    const mapped = await syncAccountById(id);
    return { updated: mapped ? 1 : 0, status: mapped && mapped.connect_status };
  } catch (e) {
    return { updated: 0, error: e.message };  // webhook must never crash
  }
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
  ensureConnectAccount, createOnboardingLink, refreshAccountStatus, syncAccountById,
  applyAccountUpdated, applyPayoutEvent,
  persistStatusForSeller, getPref,
};
