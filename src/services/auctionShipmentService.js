'use strict';

/**
 * Auction shipping, Phase 3 scaffolding (spec docs/projects/auction-shipping-spec.md; migration 219). OFF unless
 * AUCTION_SHIPPING_ENABLED=true: the routes answer 404 and the settlement engine never calls payoutHoldForAuction.
 *
 * One shipment per buyer per auction (combined shipping) holding that buyer's won, shipping-eligible lots:
 *   create         seller (own auction) or administrator. Refused above the seller's per-shipment limit (local pickup
 *                  stays possible) unless an administrator gives a reason (audited override).
 *   markShipped    seller (own) or administrator. Only after the buyer has paid. Carrier + tracking always; signature
 *                  confirmation above $500 total item value unless an administrator override. The rule lives in
 *                  auctionShippingPolicy.shipmentViolations and the database refuses the same (migration 219 trigger);
 *                  tracking is kept as recorded once set.
 *   override       administrator only, reason required, audited: 'signature' or 'limit'.
 *   confirmDelivery the buyer (own shipment) or an administrator (note required). Sets payout_release_at = delivery +
 *                  3 US Eastern business days (auctionShippingPolicy.payoutReleaseAt).
 *   payoutHoldForAuction  the settlement pay paths' question: is any shipped lot of this auction still inside its hold?
 *                  Not yet delivered, or delivered but before payout_release_at = held. Fails closed.
 * Every change is audited inside its transaction (auditService). Seller isolation: a seller acts only on shipments of
 * their own auctions; a buyer only on their own shipment.
 */

const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const auditService = require('./auditService');
const policy = require('../lib/auctionShippingPolicy');

class ShipmentError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const clip = (v, n) => (v == null ? '' : String(v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n));
const isAdmin = (actor) => !!(actor && actor.role === 'admin');
function reasonOf(v) {
  const r = clip(v, 500);
  if (r.length < 5) throw new ShipmentError('REASON_REQUIRED', 'A reason of at least 5 characters is required.', 422);
  return r;
}

function view(s, lots) {
  if (!s) return null;
  return {
    id: s.id, auction_id: s.auction_id, seller_profile_id: s.seller_profile_id, buyer_user_id: s.buyer_user_id, status: s.status,
    total_item_value_cents: Number(s.total_item_value_cents), per_shipment_limit_cents: Number(s.per_shipment_limit_cents),
    signature_required: policy.signatureRequired(s.total_item_value_cents), signature_confirmation: !!s.signature_confirmation,
    signature_override: s.signature_override_at ? { at: s.signature_override_at, by: s.signature_override_by, reason: s.signature_override_reason } : null,
    limit_override: s.limit_override_at ? { at: s.limit_override_at, by: s.limit_override_by, reason: s.limit_override_reason } : null,
    carrier: s.carrier || null, tracking_number: s.tracking_number || null, shipped_at: s.shipped_at || null,
    delivered_at: s.delivered_at || null, delivery_confirmation_source: s.delivery_confirmation_source || null,
    payout_release_at: s.payout_release_at || null, created_at: s.created_at,
    ...(lots ? { lots: lots.map((l) => ({ lot_id: l.lot_id, item_value_cents: Number(l.item_value_cents) })) } : {}),
  };
}
// The buyer sees their shipment without the administrator's override notes.
function buyerView(s, lots) {
  const v = view(s, lots);
  if (v) { delete v.signature_override; delete v.limit_override; }
  return v;
}

async function lotsOf(runner, shipmentId) {
  return (await runner.query('SELECT lot_id, item_value_cents FROM auction_shipment_lots WHERE shipment_id = $1 ORDER BY created_at, lot_id', [shipmentId])).rows;
}

// The auction and its seller; the actor must be that seller (or an administrator).
async function auctionForActor(runner, actor, auctionId) {
  if (!isUuid(auctionId)) throw new ShipmentError('AUCTION_NOT_FOUND', 'Auction not found.', 404);
  const a = (await runner.query(
    `SELECT a.id, a.seller_id, sp.user_id AS seller_user_id, sp.shipping_per_shipment_limit_cents
       FROM auctions a JOIN seller_profiles sp ON sp.id = a.seller_id WHERE a.id = $1`, [auctionId])).rows[0];
  if (!a || (!isAdmin(actor) && a.seller_user_id !== actor.id)) throw new ShipmentError('AUCTION_NOT_FOUND', 'Auction not found.', 404);
  return a;
}

// Locks the shipment and checks the actor: 'seller' = the auction's seller or an administrator; 'buyer' = the buyer or an
// administrator; 'admin' = administrators only. Anyone else gets "not found" (no existence leak).
async function shipmentForActor(client, actor, shipmentId, who) {
  if (!isUuid(shipmentId)) throw new ShipmentError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
  const s = (await client.query(
    `SELECT s.*, sp.user_id AS seller_user_id FROM auction_shipments s JOIN seller_profiles sp ON sp.id = s.seller_profile_id
      WHERE s.id = $1 FOR UPDATE OF s`, [shipmentId])).rows[0];
  const ok = s && (isAdmin(actor) || (who === 'seller' && s.seller_user_id === actor.id) || (who === 'buyer' && s.buyer_user_id === actor.id)
    || (who === 'any' && (s.seller_user_id === actor.id || s.buyer_user_id === actor.id)));
  if (!ok) throw new ShipmentError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
  return s;
}

/** Create the buyer's shipment for an auction (idempotent: an existing one is returned unchanged). */
async function createShipment(actor, { auction_id: auctionId, buyer_user_id: buyerUserId, limit_override_reason: limitReason } = {}) {
  if (!isUuid(buyerUserId)) throw new ShipmentError('BUYER_REQUIRED', 'buyer_user_id is required.', 422);
  return withTransaction(async (client) => {
    const a = await auctionForActor(client, actor, auctionId);
    const existing = (await client.query('SELECT * FROM auction_shipments WHERE auction_id = $1 AND buyer_user_id = $2', [a.id, buyerUserId])).rows[0];
    if (existing) return { ...view(existing, await lotsOf(client, existing.id)), created: false };
    const lots = (await client.query(
      `SELECT id, winning_amount_cents FROM lots
        WHERE auction_id = $1 AND winning_buyer_user_id = $2 AND shipping_eligible = true AND COALESCE(is_withdrawn, false) = false
          AND winning_amount_cents IS NOT NULL
        ORDER BY lot_number NULLS LAST, id FOR UPDATE`, [a.id, buyerUserId])).rows;
    if (!lots.length) throw new ShipmentError('NO_SHIPPABLE_LOTS', 'This buyer won no lots that can ship in this auction. Local pickup applies.', 409);
    const value = lots.reduce((n, l) => n + Number(l.winning_amount_cents), 0);
    const limit = policy.perShipmentLimitCents(a.shipping_per_shipment_limit_cents);
    let override = null;
    if (value > limit) {
      if (!isAdmin(actor)) throw new ShipmentError('OVER_PER_SHIPMENT_LIMIT', 'This order is above your per-shipment limit of $' + (limit / 100).toFixed(2) + '. It is local pickup only unless Advantage.Bid approves it.', 409);
      override = reasonOf(limitReason);
    }
    const s = (await client.query(
      `INSERT INTO auction_shipments (auction_id, seller_profile_id, buyer_user_id, total_item_value_cents, per_shipment_limit_cents,
              limit_override_by, limit_override_reason, limit_override_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END, $8) RETURNING *`,
      [a.id, a.seller_id, buyerUserId, value, limit, override ? actor.id : null, override, actor.id])).rows[0];
    for (const l of lots) {
      await client.query('INSERT INTO auction_shipment_lots (shipment_id, lot_id, item_value_cents) VALUES ($1, $2, $3)', [s.id, l.id, Number(l.winning_amount_cents)]);
    }
    await auditService.logEvent(client, { eventType: 'auction_shipment.created', entityType: 'auction_shipment', entityId: s.id, auctionId: a.id,
      actorId: actor.id, metadata: { buyer_user_id: buyerUserId, lot_count: lots.length, total_item_value_cents: value, per_shipment_limit_cents: limit,
        signature_required: policy.signatureRequired(value), limit_override_reason: override } });
    return { ...view(s, await lotsOf(client, s.id)), created: true };
  });
}

// Has the buyer paid for this auction? Combined invoice paid, or every lot of the shipment has a paid payment. Fails closed.
async function buyerPaid(client, s) {
  try {
    const inv = (await client.query(`SELECT status FROM buyer_auction_invoices WHERE auction_id = $1 AND buyer_user_id = $2`, [s.auction_id, s.buyer_user_id])).rows[0];
    if (inv && inv.status === 'paid') return true;
  } catch (e) { if (!(e && e.code === '42P01')) return false; }
  try {
    const r = (await client.query(
      `SELECT count(*)::int n, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM payments p WHERE p.lot_id = sl.lot_id AND p.buyer_user_id = $2 AND p.status = 'paid'))::int paid
         FROM auction_shipment_lots sl WHERE sl.shipment_id = $1`, [s.id, s.buyer_user_id])).rows[0];
    return r.n > 0 && r.paid === r.n;
  } catch (_e) { return false; }
}

/** Mark the shipment shipped (carrier + tracking; signature above $500 unless overridden; limit unless overridden). */
async function markShipped(actor, shipmentId, { carrier, tracking_number: trackingNumber, signature_confirmation: signature } = {}) {
  return withTransaction(async (client) => {
    const s = await shipmentForActor(client, actor, shipmentId, 'seller');
    if (s.status !== 'pending') throw new ShipmentError('NOT_PENDING', 'This shipment is already ' + s.status + '.', 409);
    if (!(await buyerPaid(client, s))) throw new ShipmentError('NOT_PAID', 'Ship only after Advantage.Bid shows the buyer\'s invoice as paid.', 409);
    const c = clip(carrier, 60); const t = clip(trackingNumber, 80);
    const violations = policy.shipmentViolations({ itemValueCents: s.total_item_value_cents, limitCents: s.per_shipment_limit_cents, trackingNumber: t,
      signatureConfirmation: signature === true, adminSignatureOverride: !!s.signature_override_at, adminLimitOverride: !!s.limit_override_at });
    if (!c) violations.unshift('carrier_required');
    if (violations.length) {
      const msg = { carrier_required: 'Enter the carrier.', tracking_required: 'Enter the tracking number.',
        signature_required: 'This shipment is above $500 in total item value, so it needs signature confirmation on delivery.',
        over_per_shipment_limit: 'This shipment is above the per-shipment limit.' };
      throw new ShipmentError('SHIPMENT_RULES', violations.map((v) => msg[v] || v).join(' '), 422, { violations });
    }
    const upd = (await client.query(
      `UPDATE auction_shipments SET status = 'shipped', carrier = $2, tracking_number = $3, signature_confirmation = $4, shipped_at = now(), shipped_by = $5
        WHERE id = $1 AND status = 'pending' RETURNING *`, [s.id, c, t, signature === true, actor.id])).rows[0];
    await auditService.logEvent(client, { eventType: 'auction_shipment.shipped', entityType: 'auction_shipment', entityId: s.id, auctionId: s.auction_id,
      actorId: actor.id, metadata: { carrier: c, tracking_number: t, signature_confirmation: signature === true, by_admin: isAdmin(actor) } });
    return view(upd, await lotsOf(client, s.id));
  });
}

/** Administrator override: 'signature' (ship above $500 without signature confirmation) or 'limit'. Reason required. */
async function adminOverride(actor, shipmentId, { kind, reason } = {}) {
  if (!isAdmin(actor)) throw new ShipmentError('ADMIN_REQUIRED', 'Administrator only.', 403);
  if (!['signature', 'limit'].includes(kind)) throw new ShipmentError('BAD_KIND', "kind must be 'signature' or 'limit'.", 422);
  const why = reasonOf(reason);
  return withTransaction(async (client) => {
    const s = await shipmentForActor(client, actor, shipmentId, 'admin');
    if (s.status !== 'pending') throw new ShipmentError('NOT_PENDING', 'Overrides apply before the shipment ships.', 409);
    const col = kind === 'signature' ? 'signature' : 'limit';
    if (s[col + '_override_at']) return { ...view(s, await lotsOf(client, s.id)), changed: false };
    const upd = (await client.query(
      `UPDATE auction_shipments SET ${col}_override_by = $2, ${col}_override_reason = $3, ${col}_override_at = now()
        WHERE id = $1 AND ${col}_override_at IS NULL RETURNING *`, [s.id, actor.id, why])).rows[0];
    await auditService.logEvent(client, { eventType: 'auction_shipping_admin_override', entityType: 'auction_shipment', entityId: s.id,
      auctionId: s.auction_id, actorId: actor.id, metadata: { kind, reason: why, total_item_value_cents: Number(s.total_item_value_cents) } });
    return { ...view(upd, await lotsOf(client, s.id)), changed: true };
  });
}

/** The buyer (own shipment) or an administrator (note required) confirms delivery. Idempotent. */
async function confirmDelivery(actor, shipmentId, { delivered_at: deliveredAt, note } = {}) {
  const admin = isAdmin(actor);
  const why = admin ? reasonOf(note) : null;
  let when = new Date();
  if (admin && deliveredAt) {
    when = new Date(deliveredAt);
    if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 60000) throw new ShipmentError('BAD_DATE', 'Enter the delivery date (not in the future).', 422);
  }
  return withTransaction(async (client) => {
    const s = await shipmentForActor(client, actor, shipmentId, 'buyer');
    const out = (row) => (admin ? view : buyerView)(row);
    if (s.status === 'delivered') return { ...out(s), changed: false };
    if (s.status !== 'shipped') throw new ShipmentError('NOT_SHIPPED', 'This shipment has not shipped yet.', 409);
    if (when < new Date(s.shipped_at)) throw new ShipmentError('BAD_DATE', 'The delivery date is before the shipment shipped.', 422);
    const releaseAt = policy.payoutReleaseAt(when);
    const upd = (await client.query(
      `UPDATE auction_shipments SET status = 'delivered', delivered_at = $2, delivery_confirmed_by = $3, delivery_confirmation_source = $4,
              delivery_note = $5, payout_release_at = $6 WHERE id = $1 AND status = 'shipped' RETURNING *`,
      [s.id, when, actor.id, admin ? 'admin' : 'buyer', why, releaseAt])).rows[0];
    await auditService.logEvent(client, { eventType: 'auction_shipment.delivered', entityType: 'auction_shipment', entityId: s.id, auctionId: s.auction_id,
      actorId: actor.id, metadata: { delivered_at: when.toISOString(), payout_release_at: releaseAt.toISOString(), source: admin ? 'admin' : 'buyer', note: why } });
    return { ...out(upd), changed: true };
  });
}

async function getShipment(actor, shipmentId) {
  return withTransaction(async (client) => {
    const s = await shipmentForActor(client, actor, shipmentId, 'any');
    const lots = await lotsOf(client, s.id);
    return isAdmin(actor) || s.seller_user_id === actor.id ? view(s, lots) : buyerView(s, lots);
  });
}

/**
 * Settlement question: are this auction's shipped lots still held? { blocked, release_at, message, pending, held }.
 * A shipment not yet delivered holds the payout; a delivered one holds it until payout_release_at. Cancelled ones do not.
 * Fails closed: if the records cannot be read, the payout is held.
 */
async function payoutHoldForAuction(auctionId, now = new Date(), runner = db, inTx = false) {
  try {
    const rows = (await require('./payoutSafeguards').guardedQuery(runner, inTx,
      `SELECT id, status, payout_release_at FROM auction_shipments WHERE auction_id = $1 AND status <> 'cancelled'`, [auctionId])).rows;
    const pending = rows.filter((r) => r.status === 'pending' || r.status === 'shipped');
    const held = rows.filter((r) => r.status === 'delivered' && (!r.payout_release_at || new Date(r.payout_release_at) > now));
    if (!pending.length && !held.length) return { blocked: false, release_at: null, pending: 0, held: 0 };
    const latest = held.reduce((m, r) => (r.payout_release_at && (!m || new Date(r.payout_release_at) > m) ? new Date(r.payout_release_at) : m), null);
    const message = pending.length
      ? pending.length + ' shipment(s) for this auction are not yet confirmed delivered. Shipped lots are paid after confirmed delivery plus 3 business days.'
      : 'Shipped lots are held until ' + latest.toISOString() + ' (confirmed delivery plus 3 business days).';
    return { blocked: true, release_at: pending.length ? null : latest.toISOString(), message, pending: pending.length, held: held.length };
  } catch (e) {
    console.error('[auction-shipments] payout hold check failed:', e.message);
    return { blocked: true, release_at: null, message: 'Shipment records could not be checked, so shipped-lot payouts stay held.', pending: 0, held: 0 };
  }
}

module.exports = { ShipmentError, createShipment, markShipped, adminOverride, confirmDelivery, getShipment, payoutHoldForAuction };
