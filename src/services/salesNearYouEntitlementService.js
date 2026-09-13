'use strict';

/**
 * salesNearYouEntitlementService — answers one question, deterministically:
 *
 *     "Is THIS auction or event entitled to use the Sales Near You email channel?"
 *
 * The Owner policy in one line: EVERYONE MAY SUBSCRIBE. NOT EVERY EVENT MAY SEND.
 *
 * Subscriber eligibility, geographic eligibility, event entitlement, send authority, content policy and
 * deliverability are six separate concepts and are deliberately NOT collapsed. This file owns exactly
 * one of them — entitlement — and knows nothing about recipients, radius or suppression.
 *
 * The rules it enforces:
 *
 *   NATIVE Advantage.Bid auction  → entitled BY RULE. Conducting the auction on Advantage.Bid's own
 *                                   software is the platform benefit. Automatic eligibility is NOT
 *                                   unconditional sending: every other gate still applies.
 *   Imported auction              → NOT entitled without an explicit grant.
 *   Auction Partner Event         → NOT entitled without an explicit grant.
 *   Personally managed estate sale→ NOT entitled without a qualifying marketing entitlement or an
 *                                   Owner/Admin override.
 *   Imported estate sale          → NOT entitled without an explicit grant.
 *   Fixed-price Marketplace item  → never a Sales Near You subject at all.
 *
 * "Event type alone does not grant email promotion rights." A grant comes from a purchased package
 * obligation, a purchased additional promotion, an approved partner agreement, or an audited Owner/Admin
 * override — never from the mere existence of a published row.
 *
 * A seller never gains access to the subscriber audience through any of this. An entitlement authorises
 * the PLATFORM to send on the event's behalf; it is not a key to the list. And an entitlement never
 * overrides a RECIPIENT's decision: suppression, unsubscribe, complaint and bounce state are evaluated
 * elsewhere and always win.
 */

const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const auditService = require('./auditService');
const configService = require('./configService');

function err(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e;
}
const q = (client) => (client || db);

/** Why an entitlement exists. */
const SOURCES = Object.freeze(['package_obligation', 'additional_promotion', 'admin_override', 'partner_agreement']);

/** The basis on which a send may proceed. 'native_auction' needs no row; everything else needs one. */
const BASIS = Object.freeze({
  NATIVE_AUCTION: 'native_auction',
  ENTITLEMENT: 'entitlement',
  NONE: 'none',
});

/** Machine reasons for a refusal — explainable, never a bare false. */
const REASON = Object.freeze({
  NOT_ENTITLED: 'not_entitled',
  IMPORTED_NOT_ENTITLED: 'imported_event_requires_entitlement',
  PARTNER_EVENT_NOT_ENTITLED: 'partner_event_requires_entitlement',
  ESTATE_SALE_NOT_ENTITLED: 'estate_sale_requires_marketing_entitlement',
  MARKETPLACE_EXCLUDED: 'marketplace_item_excluded',
  REVOKED: 'entitlement_revoked',
  EXPIRED: 'entitlement_expired',
  EXHAUSTED: 'entitlement_exhausted',
  CHANNEL_DISABLED: 'sales_near_you_channel_disabled',
});

/** The deliverable key a future marketing package must grant to unlock this channel. */
async function obligationKey() {
  const v = await configService.get(null, 'marketing.email.sales_near_you_obligation_key');
  return typeof v === 'string' && v ? v : 'sales_near_you_email';
}

/** The channel master switch. Independent of A7 and of any entitlement. */
async function channelEnabled() {
  return (await configService.get(null, 'marketing.email.sales_near_you_enabled')) === true;
}

/**
 * Look up a live entitlement for a subject. "Live" means active, not revoked, not past its expiry, and
 * not exhausted against a stated send allowance.
 */
async function findLiveEntitlement(subject, client) {
  const col = subject.kind === 'auction' ? 'auction_id' : 'event_id';
  const { rows } = await q(client).query(
    `SELECT * FROM sales_near_you_entitlements
      WHERE ${col} = $1 AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`, [subject.id]);
  const e = rows[0];
  if (!e) return null;
  if (e.revoked_at) return { row: e, live: false, reason: REASON.REVOKED };
  if (e.expires_at && new Date(e.expires_at).getTime() <= Date.now()) return { row: e, live: false, reason: REASON.EXPIRED };
  if (e.max_sends != null && (e.sends_used || 0) >= e.max_sends) return { row: e, live: false, reason: REASON.EXHAUSTED };
  return { row: e, live: true, reason: null };
}

/**
 * resolve(subject) → the entitlement decision, and nothing else.
 *
 * @param {object} subject { kind: 'auction'|'partner_event'|'estate_sale'|'marketplace_item',
 *                           id, source? ('imported' for an imported event), isNative? }
 * @returns {{ entitled, basis, reason, entitlement }}
 *
 * `kind: 'auction'` here means a NATIVE Advantage.Bid auction — an `auctions` row. An imported or
 * externally hosted auction arrives as kind 'partner_event', which is exactly why the word "auction"
 * must never be read generically.
 */
async function resolve(subject, client) {
  subject = subject || {};
  const deny = (reason) => ({ entitled: false, basis: BASIS.NONE, reason, entitlement: null });

  // Fixed-price Marketplace inventory is not a "sale near you" and never enters this channel.
  if (subject.kind === 'marketplace_item') return deny(REASON.MARKETPLACE_EXCLUDED);

  // NATIVE Advantage.Bid auction: entitled by rule. Every other gate still applies downstream.
  if (subject.kind === 'auction' && subject.isNative !== false) {
    return { entitled: true, basis: BASIS.NATIVE_AUCTION, reason: null, entitlement: null };
  }

  const found = await findLiveEntitlement(
    { kind: subject.kind === 'auction' ? 'auction' : 'event', id: subject.id }, client);

  if (found && found.live) {
    return { entitled: true, basis: BASIS.ENTITLEMENT, reason: null, entitlement: found.row };
  }
  if (found && !found.live) {
    return { entitled: false, basis: BASIS.NONE, reason: found.reason, entitlement: found.row };
  }

  // No entitlement. The refusal names the specific policy so an operator can see what would fix it.
  if (subject.kind === 'estate_sale') {
    return deny(subject.source === 'imported' ? REASON.IMPORTED_NOT_ENTITLED : REASON.ESTATE_SALE_NOT_ENTITLED);
  }
  if (subject.kind === 'partner_event') {
    return deny(subject.source === 'imported' ? REASON.IMPORTED_NOT_ENTITLED : REASON.PARTNER_EVENT_NOT_ENTITLED);
  }
  return deny(REASON.NOT_ENTITLED);
}

// ── Granting ────────────────────────────────────────────────────────────────────────────────────

/**
 * Grant an entitlement. This is the seam a FUTURE purchased marketing package plugs into: the purchase
 * creates a `marketing_obligations` row with the canonical deliverable key, and calls this with
 * source 'package_obligation'. No pricing, send count, package name or bundle economics is decided
 * here — `maxSends` is simply passed through, and null means the product has not decided yet.
 */
async function grant(input) {
  input = input || {};
  if (SOURCES.indexOf(input.source) === -1) throw err(400, 'INVALID_SOURCE', 'A recognized entitlement source is required.');
  const isAuction = input.subjectKind === 'auction';
  if (!input.subjectId) throw err(400, 'SUBJECT_REQUIRED', 'A subject auction or event is required.');
  // An Owner/Admin promotional grant must be attributable and explained.
  if (input.source === 'admin_override' && (!input.actorId || !String(input.reason || '').trim())) {
    throw err(400, 'REASON_REQUIRED', 'An administrator override must record who granted it and why.');
  }

  return withTransaction(async (client) => {
    const existing = await findLiveEntitlement(
      { kind: isAuction ? 'auction' : 'event', id: input.subjectId }, client);
    if (existing && existing.live) return existing.row;   // idempotent: one live entitlement per subject

    const { rows } = await client.query(
      `INSERT INTO sales_near_you_entitlements
         (subject_kind, auction_id, event_id, source, obligation_id, purchase_kind, purchase_id,
          max_sends, granted_by, granted_reason, expires_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [isAuction ? 'auction' : 'event',
       isAuction ? input.subjectId : null,
       isAuction ? null : input.subjectId,
       input.source, input.obligationId || null, input.purchaseKind || null, input.purchaseId || null,
       input.maxSends != null ? input.maxSends : null,
       input.actorId || null, input.reason || null, input.expiresAt || null, input.notes || null]);
    const row = rows[0];
    await auditService.logEvent(client, {
      eventType: 'sales_near_you.entitlement_granted', entityType: 'sales_near_you_entitlement', entityId: row.id,
      actorId: input.actorId || null,
      metadata: { source: input.source, subject_kind: row.subject_kind,
        auction_id: row.auction_id, event_id: row.event_id, max_sends: row.max_sends },
    });
    return row;
  });
}

/** Withdraw an entitlement. Terminal, audited, and takes effect at the next send-time re-check. */
async function revoke(entitlementId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  return withTransaction(async (client) => {
    const row = (await client.query(
      'SELECT * FROM sales_near_you_entitlements WHERE id = $1 FOR UPDATE', [entitlementId])).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Entitlement not found.');
    if (row.status === 'revoked') return row;
    const { rows } = await client.query(
      `UPDATE sales_near_you_entitlements
          SET status = 'revoked', revoked_at = now(), revoked_reason = $2, updated_at = now()
        WHERE id = $1 RETURNING *`, [entitlementId, input.reason || null]);
    await auditService.logEvent(client, {
      eventType: 'sales_near_you.entitlement_revoked', entityType: 'sales_near_you_entitlement',
      entityId: entitlementId, actorId: input.actorId,
      metadata: { reason: input.reason || null, source: row.source },
    });
    return rows[0];
  });
}

/**
 * Record that a send consumed one unit of the entitlement, and exhaust it when the stated allowance is
 * reached. Atomic, so two concurrent sends cannot both consume the last unit.
 */
async function consume(entitlementId, client) {
  const { rows } = await q(client).query(
    `UPDATE sales_near_you_entitlements
        SET sends_used = sends_used + 1,
            status = CASE WHEN max_sends IS NOT NULL AND sends_used + 1 >= max_sends THEN 'exhausted' ELSE status END,
            updated_at = now()
      WHERE id = $1 AND status = 'active'
        AND (max_sends IS NULL OR sends_used < max_sends)
      RETURNING *`, [entitlementId]);
  return rows[0] || null;
}

module.exports = {
  SOURCES, BASIS, REASON,
  resolve, grant, revoke, consume, findLiveEntitlement, obligationKey, channelEnabled,
};
