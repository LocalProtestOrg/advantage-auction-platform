'use strict';

/**
 * storefrontCommissionAdjustmentService — corrections of a storefront sale's commission classification (Seller Agreement
 * §6.9, version 4; migration 217).
 *
 * The seller may ask for a review of whether a sale was a Website Sale (5%) or a Marketplace Sale (9%) within 60 days
 * after the payout that included it. When Advantage.Bid verifies an error, an administrator records a correction:
 *   - the order keeps the channel and fee it was created with (fixed by migration 215); the correction is its own
 *     permanent record (who, when, why, the seller's request date, the original and corrected channel, rate and fee);
 *   - the difference (signed: + owed to the seller, - owed by the seller) is applied to the seller's NEXT storefront payout
 *     and shown on that payout statement (storefrontSettlementService.prepareWeek);
 *   - a later correction of the same order starts from the previous correction, so the chain is always complete;
 *   - a request made more than 60 days after the payout needs an explicit administrator override, kept on the record.
 * Fees are computed exactly as at checkout: the rate of storefrontChannelService.FEE_BPS on the item price only (shipping
 * and sales tax excluded), with the order service's own cents-safe rounding.
 */

const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const auditService = require('./auditService');
const { FEE_BPS } = require('./storefrontChannelService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_WINDOW_DAYS = 60;
const CHANNEL_LABEL = { seller_website: 'Website Sale (5%)', marketplace: 'Marketplace Sale (9%)' };
function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const feeOf = (baseCents, bps) => require('./marketplaceOrderService').computeBreakdown({ itemPriceCents: baseCents, feeBps: bps }).platform_fee_cents;

function dayOf(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T12:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

function view(a) {
  return { id: a.id, order_id: a.marketplace_order_id, order_number: a.order_number || null, kind: a.kind,
    from_channel: a.from_channel, to_channel: a.to_channel, from_label: CHANNEL_LABEL[a.from_channel], to_label: CHANNEL_LABEL[a.to_channel],
    fee_base_cents: a.fee_base_cents, from_fee_bps: a.from_fee_bps, to_fee_bps: a.to_fee_bps, from_fee_cents: a.from_fee_cents,
    to_fee_cents: a.to_fee_cents, amount_cents: a.amount_cents, reason: a.reason, seller_requested_on: a.seller_requested_on,
    outside_review_window: a.outside_review_window, created_at: a.created_at, applied_payout_id: a.applied_payout_id || null, applied_at: a.applied_at || null };
}

// The order's classification as it stands now (the last correction, else the order as created) and the review window.
async function standing(orderId, runner) {
  const o = (await runner.query(
    `SELECT o.id, o.order_number, o.seller_id, o.payment_status, o.refund_status, o.sales_channel, o.item_price_cents,
            o.platform_fee_bps, o.platform_fee_cents,
            (SELECT max(p.paid_at) FROM storefront_payout_lines l JOIN storefront_payouts p ON p.id = l.storefront_payout_id
              WHERE l.marketplace_order_id = o.id AND l.active AND p.settlement_status = 'paid') AS paid_out_at
       FROM marketplace_orders o WHERE o.id = $1`, [orderId])).rows[0];
  if (!o) return null;
  const last = (await runner.query(
    `SELECT to_channel, to_fee_bps, to_fee_cents FROM storefront_commission_adjustments WHERE marketplace_order_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [orderId])).rows[0];
  return { order: o, channel: last ? last.to_channel : o.sales_channel, feeBps: last ? last.to_fee_bps : Number(o.platform_fee_bps),
    feeCents: last ? last.to_fee_cents : Number(o.platform_fee_cents) };
}

/** What a correction to `toChannel` would change, without recording anything (the admin's confirmation step). */
async function preview(orderId, toChannel, runner = db) {
  if (!UUID_RE.test(String(orderId || ''))) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (!FEE_BPS[toChannel]) throw err(422, 'CHANNEL_INVALID', 'Choose Website Sale or Marketplace Sale.');
  const s = await standing(orderId, runner);
  if (!s) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (s.order.payment_status !== 'paid' || s.order.refund_status !== 'none') throw err(409, 'NOT_CORRECTABLE', 'Only a paid, unrefunded storefront sale can have its commission corrected.');
  if (!FEE_BPS[s.channel]) throw err(409, 'NO_CHANNEL', 'This order has no recorded sales channel to correct.');
  if (s.channel === toChannel) throw err(409, 'SAME_CHANNEL', 'This sale is already classified as ' + CHANNEL_LABEL[toChannel] + '.');
  const base = Number(s.order.item_price_cents);
  const toFee = feeOf(base, FEE_BPS[toChannel]);
  return { order: s.order, from_channel: s.channel, to_channel: toChannel, fee_base_cents: base, from_fee_bps: s.feeBps, to_fee_bps: FEE_BPS[toChannel],
    from_fee_cents: s.feeCents, to_fee_cents: toFee, amount_cents: s.feeCents - toFee, paid_out_at: s.order.paid_out_at || null };
}

function windowCheck(paidOutAt, requestedOn) {
  if (!paidOutAt) return { outside: false, days: null };   // not paid out yet: within the window
  const days = Math.floor((new Date(requestedOn + 'T23:59:59Z') - new Date(paidOutAt)) / 86400000);
  return { outside: days > REVIEW_WINDOW_DAYS, days };
}

/**
 * Record a verified correction (administrator only). opts: { toChannel, reason, sellerRequestedOn (YYYY-MM-DD),
 * outsideWindowOverride (true to accept a request made after the 60-day window; kept on the record) }.
 */
async function createAdjustment(orderId, adminId, opts = {}) {
  if (!adminId) throw err(403, 'ADMIN_REQUIRED', 'Only an administrator can correct a commission.');
  const reason = String(opts.reason || '').trim().slice(0, 500);
  if (reason.length < 5) throw err(422, 'REASON_REQUIRED', 'Give the reason for the correction (it is shown to the seller).');
  const requestedOn = dayOf(opts.sellerRequestedOn);
  if (!requestedOn) throw err(422, 'REQUEST_DATE_REQUIRED', 'Enter the date the seller asked for the review.');
  if (requestedOn > new Date().toISOString().slice(0, 10)) throw err(422, 'REQUEST_DATE_INVALID', 'The request date cannot be in the future.');
  const row = await withTransaction(async (client) => {
    await client.query('SELECT id FROM marketplace_orders WHERE id = $1 FOR UPDATE', [UUID_RE.test(String(orderId || '')) ? orderId : null]);
    const p = await preview(orderId, String(opts.toChannel || ''), client);
    const w = windowCheck(p.paid_out_at, requestedOn);
    if (w.outside && opts.outsideWindowOverride !== true) {
      throw err(409, 'OUTSIDE_REVIEW_WINDOW', `The seller asked ${w.days} days after the payout that included this sale (the agreement allows ${REVIEW_WINDOW_DAYS}). Confirm the override to record it anyway.`);
    }
    if (p.amount_cents === 0) throw err(409, 'NO_DIFFERENCE', 'The corrected commission is the same amount; nothing to record.');
    const a = (await client.query(
      `INSERT INTO storefront_commission_adjustments (marketplace_order_id, seller_profile_id, from_channel, to_channel, fee_base_cents,
         from_fee_bps, to_fee_bps, from_fee_cents, to_fee_cents, amount_cents, reason, seller_requested_on, outside_review_window, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [p.order.id, p.order.seller_id, p.from_channel, p.to_channel, p.fee_base_cents, p.from_fee_bps, p.to_fee_bps, p.from_fee_cents,
        p.to_fee_cents, p.amount_cents, reason, requestedOn, !!w.outside, adminId])).rows[0];
    await auditService.logEvent(client, { eventType: 'storefront_commission.corrected', entityType: 'marketplace_order', entityId: p.order.id, actorId: adminId,
      metadata: { adjustment_id: a.id, from_channel: a.from_channel, to_channel: a.to_channel, amount_cents: a.amount_cents, seller_requested_on: requestedOn,
        outside_review_window: !!w.outside, reason } });
    await require('./marketplaceOrderService').recordEvent(client, p.order.id, 'commission_corrected', { actorUserId: adminId, actorRole: 'admin',
      data: { from_channel: a.from_channel, to_channel: a.to_channel, amount_cents: a.amount_cents, reason } });
    return { ...a, order_number: p.order.order_number };
  });
  return view(row);
}

async function listForOrder(orderId, runner = db) {
  if (!UUID_RE.test(String(orderId || ''))) return [];
  return (await runner.query(
    `SELECT a.*, o.order_number FROM storefront_commission_adjustments a JOIN marketplace_orders o ON o.id = a.marketplace_order_id
      WHERE a.marketplace_order_id = $1 ORDER BY a.created_at, a.id`, [orderId])).rows.map(view);
}

async function listForPayout(payoutId, runner = db) {
  return (await runner.query(
    `SELECT a.*, o.order_number FROM storefront_commission_adjustments a JOIN marketplace_orders o ON o.id = a.marketplace_order_id
      WHERE a.applied_payout_id = $1 ORDER BY a.created_at, a.id`, [payoutId])).rows.map(view);
}

module.exports = { preview, createAdjustment, listForOrder, listForPayout, REVIEW_WINDOW_DAYS, CHANNEL_LABEL, windowCheck };
