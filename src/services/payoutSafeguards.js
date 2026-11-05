'use strict';

/**
 * payoutSafeguards: the shared seller-payout fraud safeguards (owner-approved 2026-11-05; assessment
 * docs/projects/seller-fraud-protections-assessment.md sections 3, 6 and 8). One home for:
 *
 *   • Suspended sellers are never paid. Both pay paths (auction Mark Paid / Direct Deposit in settlementEngine, storefront
 *     payPayout) refuse when the seller's account is inactive (users.is_active = false), unless an administrator gives an
 *     explicit, audited reason for this one payment. The account check fails closed: if it cannot run, the seller is
 *     treated as suspended.
 *   • Payout-detail changes are audited (field NAMES plus masked, non-sensitive before/after values only: never a full
 *     bank or account number, never a payee name or street address) and the seller is emailed.
 *   • A payout within RECENT_PAYOUT_CHANGE_REVIEW_DAYS (7) after the seller CHANGED an existing payout destination is held
 *     for administrator review: the pay paths refuse it unless the administrator gives an explicit, audited review reason.
 *     First-time setup is audited and notified but does not trigger the review (there was no destination to divert).
 *     The check reads the audit trail; if it cannot run, the payout is treated as recently changed (fail closed).
 *   • Replacing an existing payout destination needs the account's current password (the same rule the account phone
 *     change uses, src/services/accountPhoneService.js). Accounts without a password skip it; the review hold still applies.
 *
 * Data minimization: nothing new is collected. Bank details stay with the payment processor.
 */

const db = require('../db');
const auditService = require('./auditService');

const RECENT_PAYOUT_CHANGE_REVIEW_DAYS = 7;
const OVERRIDE_REASON_MIN = 10;

const EVENTS = Object.freeze({
  PAYOUT_DETAILS_CHANGED: 'seller.payout_details_changed',
  CONNECT_STATUS_CHANGED: 'seller.connect_status_changed',
  SUSPENDED_OVERRIDE: 'settlement.suspended_seller_override',
  PAYOUT_CHANGE_REVIEW_OVERRIDE: 'settlement.payout_change_review_override',
  SHIPPING_HOLD_OVERRIDE: 'settlement.shipping_delivery_hold_override',
  HOLD_PLACED: 'settlement.on_hold',
  HOLD_RELEASED: 'settlement.hold_released',
});

// Override keys accepted on the pay requests ({ override_reasons: { <key>: '<reason>' } }).
const OVERRIDES = Object.freeze({
  SUSPENDED_SELLER: 'suspended_seller',
  RECENT_PAYOUT_CHANGE: 'recent_payout_change',
  SHIPPING_DELIVERY_HOLD: 'shipping_delivery_hold',
});

class PayoutSafeguardError extends Error {
  constructor(code, message, status = 409, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); }
}

// A read inside the caller's transaction runs under a SAVEPOINT, so a failed read never aborts that transaction.
async function guardedQuery(runner, inTx, sql, params) {
  if (!inTx) return runner.query(sql, params);
  await runner.query('SAVEPOINT payout_safeguard_read');
  try { const r = await runner.query(sql, params); await runner.query('RELEASE SAVEPOINT payout_safeguard_read'); return r; }
  catch (e) { await runner.query('ROLLBACK TO SAVEPOINT payout_safeguard_read').catch(() => {}); throw e; }
}

const clip = (v, n = 500) => (v == null ? '' : String(v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n));

/** Normalize the administrator's override reasons from a request body. Unknown keys are ignored. */
function overrideReasons(body) {
  const src = (body && typeof body.override_reasons === 'object' && body.override_reasons) || {};
  const out = {};
  for (const k of Object.values(OVERRIDES)) { const r = clip(src[k]); if (r) out[k] = r; }
  return out;
}
function validOverride(reasons, key) {
  const r = reasons && reasons[key];
  return typeof r === 'string' && r.trim().length >= OVERRIDE_REASON_MIN ? r.trim() : null;
}

// ── Seller account state ──────────────────────────────────────────────────────────────────────────────────────
/** true = active, false = suspended OR unknown (fail closed). */
async function sellerAccountActive(userId, runner = db, inTx = false) {
  if (!userId) return false;
  try {
    const r = await guardedQuery(runner, inTx, 'SELECT is_active FROM users WHERE id = $1', [userId]);
    const row = r && r.rows && r.rows[0];
    if (!row) return false;
    return row.is_active !== false;
  } catch (e) {
    console.error('[payout-safeguards] account status check failed:', e.message);
    return false;
  }
}

/**
 * The most recent CHANGE of an existing payout destination within the review window, or null.
 * Returns { at } when one exists, { at: null, unknown: true } when the check could not run (fail closed), null otherwise.
 */
async function recentPayoutDestinationChange(userId, runner = db, inTx = false, days = RECENT_PAYOUT_CHANGE_REVIEW_DAYS) {
  if (!userId) return { at: null, unknown: true };
  try {
    const r = await guardedQuery(runner, inTx, 
      `SELECT max(created_at) AS at FROM audit_log
        WHERE event_type = $1 AND entity_type = 'user' AND entity_id = $2
          AND metadata->>'destination_changed' = 'true'
          AND created_at > (now() - make_interval(days => $3::int))::timestamp`,
      [EVENTS.PAYOUT_DETAILS_CHANGED, userId, days]);
    const at = r && r.rows && r.rows[0] && r.rows[0].at;
    return at ? { at } : null;
  } catch (e) {
    if (e && e.code === '42P01') return null;   // no audit table in a minimal test schema: nothing was recorded
    console.error('[payout-safeguards] recent payout change check failed:', e.message);
    return { at: null, unknown: true };
  }
}

/**
 * Shared pay-path decision (pure). facts: { sellerActive, recentChange, shippingHold }; reasons: from overrideReasons().
 * Throws PayoutSafeguardError naming the override that would allow it, or returns the list of overrides used.
 */
function assertPayoutSafeguards(facts = {}, reasons = {}) {
  const used = [];
  if (facts.sellerActive === false) {
    const r = validOverride(reasons, OVERRIDES.SUSPENDED_SELLER);
    if (!r) throw new PayoutSafeguardError('SELLER_SUSPENDED', 'Seller account is suspended. Review before paying. An administrator may pay anyway only with a written reason (at least ' + OVERRIDE_REASON_MIN + ' characters).', 409, { override: OVERRIDES.SUSPENDED_SELLER });
    used.push({ key: OVERRIDES.SUSPENDED_SELLER, reason: r });
  }
  if (facts.recentChange) {
    const r = validOverride(reasons, OVERRIDES.RECENT_PAYOUT_CHANGE);
    const when = facts.recentChange.at ? ' on ' + new Date(facts.recentChange.at).toISOString().slice(0, 10) : '';
    if (!r) throw new PayoutSafeguardError('RECENT_PAYOUT_CHANGE', facts.recentChange.unknown
      ? 'Recent payout detail changes could not be checked. Review the seller\'s payout details, then confirm with a written reason.'
      : 'The seller changed their payout details' + when + ' (within ' + RECENT_PAYOUT_CHANGE_REVIEW_DAYS + ' days). Confirm the change with the seller, then pay with a written review reason.', 409,
    { override: OVERRIDES.RECENT_PAYOUT_CHANGE, changed_at: facts.recentChange.at || null });
    used.push({ key: OVERRIDES.RECENT_PAYOUT_CHANGE, reason: r });
  }
  if (facts.shippingHold && facts.shippingHold.blocked) {
    const r = validOverride(reasons, OVERRIDES.SHIPPING_DELIVERY_HOLD);
    if (!r) throw new PayoutSafeguardError('SHIPPING_DELIVERY_HOLD', facts.shippingHold.message || 'Shipped lots are held until delivery is confirmed plus 3 business days.', 409,
      { override: OVERRIDES.SHIPPING_DELIVERY_HOLD, release_at: facts.shippingHold.release_at || null });
    used.push({ key: OVERRIDES.SHIPPING_DELIVERY_HOLD, reason: r });
  }
  return used;
}

const OVERRIDE_EVENT = { [OVERRIDES.SUSPENDED_SELLER]: EVENTS.SUSPENDED_OVERRIDE,
  [OVERRIDES.RECENT_PAYOUT_CHANGE]: EVENTS.PAYOUT_CHANGE_REVIEW_OVERRIDE, [OVERRIDES.SHIPPING_DELIVERY_HOLD]: EVENTS.SHIPPING_HOLD_OVERRIDE };
/** Audit each override used, inside the pay transaction (atomic with the payment record). */
async function auditOverrides(client, used, { entityType, entityId, auctionId = null, actorId, extra = {} }) {
  for (const u of used || []) {
    await auditService.logEvent(client, { eventType: OVERRIDE_EVENT[u.key], entityType, entityId, auctionId, actorId,
      metadata: { override: u.key, reason: u.reason, ...extra } });
  }
}

// ── Payout-detail change: diff, audit, notification ──────────────────────────────────────────────────────────
const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase().replace(/\s+/g, ' '));
const CHECK_KEYS = ['check_payee_name', 'check_address_line1', 'check_address_line2', 'check_city', 'check_state', 'check_postal_code'];
const ACH_KEYS = ['stripe_account_id', 'stripe_bank_account_ref', 'ach_account_last4', 'ach_routing_last4', 'ach_account_name', 'bank_name', 'ach_account_type'];
const CONNECT_KEYS = ['connect_status', 'connect_details_submitted', 'connect_transfers_active', 'connect_payouts_enabled', 'connect_disabled_reason'];
const TRACKED = ['payout_method', ...CHECK_KEYS, ...ACH_KEYS, ...CONNECT_KEYS];

function hasDestination(p) {
  if (!p || !p.payout_method) return false;
  if (p.payout_method === 'check') return !!(p.check_payee_name && p.check_address_line1);
  if (p.payout_method === 'ach') return !!(p.stripe_account_id || p.stripe_bank_account_ref || p.ach_account_last4);
  return false;
}
// Where the money goes (not its status): method + the destination identity.
function destinationFingerprint(p) {
  if (!p || !p.payout_method) return '';
  const keys = p.payout_method === 'check' ? CHECK_KEYS : ['stripe_account_id', 'stripe_bank_account_ref', 'ach_account_last4', 'ach_routing_last4'];
  return p.payout_method + '|' + keys.map((k) => norm(p[k])).join('|');
}
const maskId = (v) => (v ? '...' + String(v).slice(-4) : null);
// The ONLY values an audit row or email may carry: no payee name, street, postal code or full identifier.
function maskedView(p) {
  if (!p) return { payout_method: null };
  return {
    payout_method: p.payout_method || null,
    check_state: p.payout_method === 'check' ? (p.check_state || null) : null,
    ach_last4: p.ach_account_last4 || p.connect_bank_last4 || null,
    bank_name: p.bank_name || p.connect_bank_name || null,
    connected_account: maskId(p.stripe_account_id),
    connect_status: p.connect_status || null,
  };
}

/** Pure diff of two seller_payout_preferences rows. */
function diffPayoutDetails(before, after) {
  const changed = TRACKED.filter((k) => norm(before && before[k]) !== norm(after && after[k]));
  const destinationChanged = hasDestination(before) && destinationFingerprint(before) !== destinationFingerprint(after);
  return { changed_fields: changed, destination_changed: destinationChanged, first_setup: !hasDestination(before) && hasDestination(after),
    before: maskedView(before), after: maskedView(after) };
}

/**
 * Record a payout-detail change for a seller (no-op when nothing changed). runner = a transaction client when the change
 * is transactional; otherwise the pool. Status-only Connect changes use CONNECT_STATUS_CHANGED and never trigger the
 * review hold; anything touching the destination uses PAYOUT_DETAILS_CHANGED.
 */
async function recordPayoutDetailsChange(runner, { sellerUserId, actorId = null, source, before, after }) {
  const d = diffPayoutDetails(before, after);
  if (!d.changed_fields.length) return null;
  const statusOnly = d.changed_fields.every((k) => CONNECT_KEYS.includes(k));
  await auditService.logEvent(runner || db, {
    eventType: statusOnly ? EVENTS.CONNECT_STATUS_CHANGED : EVENTS.PAYOUT_DETAILS_CHANGED,
    entityType: 'user', entityId: sellerUserId, actorId: actorId || null,
    metadata: { source, changed_fields: d.changed_fields, destination_changed: d.destination_changed, first_setup: d.first_setup,
      before: d.before, after: d.after },
  });
  return { ...d, status_only: statusOnly };
}

const METHOD_TEXT = { ach: 'Direct Deposit', check: 'mailed check' };
/** Best-effort email to the seller's account address (never blocks the change). Returns true when a send was attempted. */
async function notifySellerPayoutDetailsChanged(sellerUserId, diff, deps = {}) {
  if (!diff || diff.status_only || !diff.changed_fields || !diff.changed_fields.length) return false;
  try {
    const u = (await db.query('SELECT email FROM users WHERE id = $1', [sellerUserId])).rows[0];
    if (!u || !u.email) return false;
    const company = require('../lib/companyContact');
    const method = METHOD_TEXT[diff.after && diff.after.payout_method] || 'not set';
    const text = 'The payout details on your Advantage.Bid seller account were '
      + (diff.first_setup ? 'set up' : 'changed') + ' on ' + new Date().toUTCString() + '.\n\n'
      + 'Payout method: ' + method + '.\n'
      + (diff.destination_changed ? 'For your protection, a payout made within ' + RECENT_PAYOUT_CHANGE_REVIEW_DAYS
        + ' days of this change is reviewed by our team before it is sent.\n' : '')
      + '\nIf you did not make this change, contact us right away at ' + company.SUPPORT_EMAIL + ' or ' + company.PHONE_DISPLAY
      + ', and change your password.\n\n' + company.emailContactLines();
    const mail = deps.emailService || require('./emailService');
    await mail.sendEmail({ to: u.email, subject: 'Your Advantage.Bid payout details were ' + (diff.first_setup ? 'set up' : 'changed'), text });
    return true;
  } catch (e) {
    console.error('[payout-safeguards] payout change notice failed:', e.message);
    return false;
  }
}

/**
 * Current-password confirmation for REPLACING an existing payout destination (first-time setup needs none).
 * Throws PayoutSafeguardError PASSWORD_REQUIRED / PASSWORD_INCORRECT (403). Accounts without a password skip the check.
 */
async function assertPasswordForDestinationChange(userId, { before, after, currentPassword } = {}) {
  if (!hasDestination(before)) return { required: false };
  if (destinationFingerprint(before) === destinationFingerprint(after)) return { required: false };
  const u = (await db.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0];
  if (!u || !u.password_hash) return { required: false };
  if (!currentPassword) throw new PayoutSafeguardError('PASSWORD_REQUIRED', 'Enter your account password to change where your payouts are sent.', 403);
  if (!(await require('bcrypt').compare(String(currentPassword), u.password_hash))) throw new PayoutSafeguardError('PASSWORD_INCORRECT', 'That password is not correct.', 403);
  return { required: true };
}

module.exports = {
  RECENT_PAYOUT_CHANGE_REVIEW_DAYS, OVERRIDE_REASON_MIN, EVENTS, OVERRIDES, PayoutSafeguardError,
  overrideReasons, validOverride, sellerAccountActive, recentPayoutDestinationChange, assertPayoutSafeguards, auditOverrides,
  guardedQuery, hasDestination, destinationFingerprint, maskedView, diffPayoutDetails, recordPayoutDetailsChange,
  notifySellerPayoutDetailsChanged, assertPasswordForDestinationChange,
};
