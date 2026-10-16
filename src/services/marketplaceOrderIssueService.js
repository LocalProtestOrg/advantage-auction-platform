'use strict';

/**
 * marketplaceOrderIssueService — a buyer's problem with a storefront order (not received, not as described, damaged,
 * pickup problem, refund request, other).
 *
 * Attribution rule (owner security standard, 2026-10-16): an issue belongs to the ORDER. The seller and buyer on the issue
 * are always the order's own seller and buyer, read from the order row; nothing the browser sends (a seller id, a seller
 * name, another order id) can point an issue at anyone else. The database enforces the same rule (migration 197: the issue's
 * order, seller and buyer must match an existing order exactly, and never change afterwards).
 *
 *   buyer  — may open an issue only on their own paid or refunded order, and read only their own issues;
 *   seller — reads and answers only issues on their own orders;
 *   admin  — reads all and resolves; every step is kept in the order's permanent history.
 * Opening an issue never moves money and never establishes that the seller is at fault: it creates an issue for review.
 * When the problem concerns whether the buyer received what they paid for (not received, not as described, damaged, refund
 * request), the order's payout is placed ON HOLD while it is reviewed (a flag; nothing is transferred or taken back). Only an
 * administrator releases that hold, when resolving the issue. Staff are alerted (no customer details in the text) and the
 * seller is told neutrally that a buyer reported a problem.
 */

const db = require('../db');
const sellerActor = require('../lib/sellerActor');
const { withTransaction } = require('../utils/withTransaction');

const CATEGORIES = ['not_received', 'not_as_described', 'damaged', 'pickup_problem', 'refund_request', 'other'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_LIMIT_PER_ORDER = 3;
// Issues that question whether the buyer got what they paid for hold the payout while reviewed.
const HOLD_CATEGORIES = ['not_received', 'not_as_described', 'damaged', 'refund_request'];
const HOLD_REASON = 'Buyer issue under review (no finding about the seller)';
const LABEL = { not_received: 'Item not received', not_as_described: 'Not as described', damaged: 'Damaged', pickup_problem: 'Pickup problem',
  refund_request: 'Refund request', other: 'Other' };

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const clip = (v, n) => (v == null ? '' : String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]+/g, ' ').trim().slice(0, n));

function view(r, { forSeller = false } = {}) {
  const out = { id: r.id, order_id: r.order_id, order_number: r.order_number || null, category: r.category, message: r.message,
    status: r.status, seller_response: r.seller_response || null, seller_responded_at: r.seller_responded_at || null,
    resolution_note: r.resolution_note || null, resolved_at: r.resolved_at || null, created_at: r.created_at };
  if (!forSeller) out.seller_name = r.seller_name || null;
  return out;
}

async function event(client, orderId, type, actorUserId, actorRole, data) {
  await client.query(
    `INSERT INTO marketplace_order_events (order_id, seller_id, buyer_user_id, event_type, actor_user_id, actor_role, data)
     SELECT o.id, o.seller_id, o.buyer_user_id, $2, $3, $4, $5::jsonb FROM marketplace_orders o WHERE o.id = $1`,
    [orderId, type, actorUserId, actorRole, JSON.stringify(data || {})]);
}

// Buyer opens an issue on THEIR order. Any seller id / name in the body is ignored by design.
async function openIssue(orderId, buyerUserId, body = {}) {
  if (!UUID_RE.test(String(orderId || ''))) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');
  const category = CATEGORIES.includes(body.category) ? body.category : null;
  if (!category) throw err(422, 'CATEGORY_REQUIRED', 'Choose what the problem is.');
  const message = clip(body.message, 4000);
  if (message.length < 5) throw err(422, 'MESSAGE_REQUIRED', 'Describe the problem in a sentence or two.');
  return withTransaction(async (client) => {
    const o = (await client.query(
      'SELECT id, seller_id, buyer_user_id, payment_status, refund_status, payout_hold, order_number FROM marketplace_orders WHERE id = $1 AND buyer_user_id = $2 FOR UPDATE',
      [orderId, buyerUserId])).rows[0];
    if (!o) throw err(404, 'ORDER_NOT_FOUND', 'Order not found.');           // someone else's order looks exactly like a missing one
    if (!['paid', 'refunded'].includes(o.payment_status)) throw err(409, 'ORDER_NOT_PURCHASED', 'An issue can be opened once the order is paid.');
    const open = (await client.query(
      `SELECT count(*)::int AS n FROM marketplace_order_issues WHERE order_id = $1 AND status IN ('open','seller_responded')`, [o.id])).rows[0];
    if (open.n >= OPEN_LIMIT_PER_ORDER) throw err(429, 'TOO_MANY_OPEN', 'This order already has open issues. Our team will follow up.');
    const row = (await client.query(
      `INSERT INTO marketplace_order_issues (order_id, seller_id, buyer_user_id, category, message)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`, [o.id, o.seller_id, o.buyer_user_id, category, message])).rows[0];
    await event(client, o.id, 'issue_opened', buyerUserId, 'buyer', { issue_id: row.id, category });
    let held = false;
    if (HOLD_CATEGORIES.includes(category) && o.payment_status === 'paid' && o.refund_status !== 'refunded' && !o.payout_hold) {
      await client.query(`UPDATE marketplace_orders SET payout_hold = true, payout_hold_reason = $2, review_required = true, review_note = $2,
                                 updated_at = now() WHERE id = $1`, [o.id, HOLD_REASON]);
      await event(client, o.id, 'payout_hold', null, 'system', { reason: HOLD_REASON, issue_id: row.id });
      held = true;
    }
    return { ...view({ ...row, order_number: o.order_number }), payout_held: held, _notify: { orderId: o.id, sellerId: o.seller_id, orderNumber: o.order_number } };
  }).then(async (out) => {
    const n = out._notify; delete out._notify;
    await notifyIssueOpened(n, category, out.id);
    return out;
  });
}

// Best-effort notices after the issue is saved: staff (SMS, no customer details) and the seller (neutral email).
async function notifyIssueOpened({ orderId, sellerId, orderNumber }, category, issueId) {
  try {
    const oa = require('./ownerAlertService');
    await oa.notifyAdminActionRequired({ actionType: oa.ALERT_TYPES.STOREFRONT_ORDER_ISSUE, entityType: 'marketplace_order_issue', entityId: issueId,
      headline: 'Storefront order issue opened', context: `${orderNumber}: ${LABEL[category] || category}`, adminPath: '/admin/storefront-moderation.html',
      adminId: issueId, adminParam: 'issue', actionLabel: 'Review' });
  } catch (e) { console.error('[order-issue] staff alert failed:', e.message); }
  try {
    const s = (await db.query(`SELECT u.email FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`, [sellerId])).rows[0];
    if (!s || !s.email) return;
    const base = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
    await require('./emailService').sendEmail({
      to: s.email,
      subject: `A buyer reported a problem with order ${orderNumber}`,
      text: [
        `A buyer reported a problem with storefront order ${orderNumber} (${LABEL[category] || category}).`,
        '',
        'This is not a finding about your business. Please review it and respond in your Marketplace Orders page:',
        `${base}/seller-orders.html`,
        '',
        'Advantage.Bid will review the issue with you and the buyer.',
      ].join('\n'),
    });
  } catch (e) { console.error('[order-issue] seller notice failed:', e.message); }
}

async function listForBuyer(buyerUserId) {
  const { rows } = await db.query(
    `SELECT i.*, o.order_number, COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name
       FROM marketplace_order_issues i JOIN marketplace_orders o ON o.id = i.order_id JOIN seller_profiles sp ON sp.id = i.seller_id
      WHERE i.buyer_user_id = $1 ORDER BY i.created_at DESC LIMIT 200`, [buyerUserId]);
  return rows.map((r) => view(r));
}

// The acting company: the seller checkpoint's context (owner or staff; company from the session) or the owner's user id.
async function sellerIdFor(actor, runner = db) {
  const s = await sellerActor.sellerRow(actor, runner, 'id');
  if (!s) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  return s.id;
}

async function listForSeller(sellerUserId) {
  const sellerId = await sellerIdFor(sellerUserId);
  // The buyer's own words can contain their phone number or address: only people who fulfil orders see them.
  const seeMessage = sellerActor.can(sellerUserId, 'company.orders.fulfil');
  const { rows } = await db.query(
    `SELECT i.*, o.order_number FROM marketplace_order_issues i JOIN marketplace_orders o ON o.id = i.order_id
      WHERE i.seller_id = $1 ORDER BY i.created_at DESC LIMIT 200`, [sellerId]);
  return rows.map((r) => { const v = view(r, { forSeller: true }); if (!seeMessage) v.message = null; return v; });
}

// Seller answers an issue on THEIR order (one response; the buyer's words are never editable).
async function respond(issueId, sellerActorRef, body = {}) {
  const sellerUserId = sellerActor.actorUserId(sellerActorRef);
  if (!UUID_RE.test(String(issueId || ''))) throw err(404, 'ISSUE_NOT_FOUND', 'Issue not found.');
  const response = clip(body.response, 4000);
  if (response.length < 2) throw err(422, 'RESPONSE_REQUIRED', 'Write a response.');
  return withTransaction(async (client) => {
    const sellerId = await sellerIdFor(sellerActorRef, client);
    const i = (await client.query('SELECT * FROM marketplace_order_issues WHERE id = $1 AND seller_id = $2 FOR UPDATE', [issueId, sellerId])).rows[0];
    if (!i) throw err(404, 'ISSUE_NOT_FOUND', 'Issue not found.');
    if (i.status !== 'open') throw err(409, 'ALREADY_ANSWERED', 'This issue has already been answered.');
    const row = (await client.query(
      `UPDATE marketplace_order_issues SET seller_response = $2, seller_responded_at = now(), seller_responded_by = $3,
              status = 'seller_responded', updated_at = now() WHERE id = $1 RETURNING *`, [i.id, response, sellerUserId])).rows[0];
    await event(client, i.order_id, 'issue_seller_responded', sellerUserId, 'seller', { issue_id: i.id });
    return view(row, { forSeller: true });
  });
}

// Admin resolves (or closes) an issue. Reason required; recorded in the order history.
// release_hold: true also lifts the payout hold this issue placed (only when no chargeback is open on the order).
async function resolve(issueId, adminUserId, body = {}) {
  if (!adminUserId) throw err(403, 'ADMIN_REQUIRED', 'Only an administrator can resolve an issue.');
  if (!UUID_RE.test(String(issueId || ''))) throw err(404, 'ISSUE_NOT_FOUND', 'Issue not found.');
  const note = clip(body.resolution_note, 2000);
  if (note.length < 5) throw err(422, 'NOTE_REQUIRED', 'Record how this issue was resolved.');
  const status = body.status === 'closed' ? 'closed' : 'resolved';
  return withTransaction(async (client) => {
    const i = (await client.query('SELECT * FROM marketplace_order_issues WHERE id = $1 FOR UPDATE', [issueId])).rows[0];
    if (!i) throw err(404, 'ISSUE_NOT_FOUND', 'Issue not found.');
    if (['resolved', 'closed'].includes(i.status)) throw err(409, 'ALREADY_RESOLVED', 'This issue is already resolved.');
    const row = (await client.query(
      `UPDATE marketplace_order_issues SET status = $2, resolution_note = $3, resolved_by = $4, resolved_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`, [i.id, status, note, adminUserId])).rows[0];
    await event(client, i.order_id, 'issue_resolved', adminUserId, 'admin', { issue_id: i.id, status });
    let holdReleased = false;
    if (body.release_hold === true) {
      const o = (await client.query('SELECT id, payout_hold, payout_hold_reason FROM marketplace_orders WHERE id = $1 FOR UPDATE', [i.order_id])).rows[0];
      const openIssues = (await client.query(`SELECT count(*)::int AS n FROM marketplace_order_issues WHERE order_id = $1 AND status IN ('open','seller_responded') AND id <> $2`,
        [i.order_id, i.id])).rows[0];
      const openDispute = (await client.query(`SELECT count(*)::int AS n FROM payment_disputes WHERE marketplace_order_id = $1 AND closed_at IS NULL`, [i.order_id])).rows[0];
      if (o && o.payout_hold && o.payout_hold_reason === HOLD_REASON) {
        if (openIssues.n > 0 || openDispute.n > 0) throw err(409, 'HOLD_STILL_NEEDED', 'Another open issue or a chargeback still holds this order.');
        await client.query('UPDATE marketplace_orders SET payout_hold = false, payout_hold_reason = NULL, updated_at = now() WHERE id = $1', [o.id]);
        await event(client, o.id, 'payout_hold_released', adminUserId, 'admin', { reason: note, issue_id: i.id });
        holdReleased = true;
      }
    }
    return { ...view(row), payout_hold_released: holdReleased };
  });
}

async function listForAdmin({ status } = {}) {
  const params = [];
  let where = '';
  if (['open', 'seller_responded', 'resolved', 'closed'].includes(status)) { params.push(status); where = 'WHERE i.status = $1'; }
  const { rows } = await db.query(
    `SELECT i.*, o.order_number, COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name
       FROM marketplace_order_issues i JOIN marketplace_orders o ON o.id = i.order_id JOIN seller_profiles sp ON sp.id = i.seller_id
       ${where} ORDER BY i.created_at DESC LIMIT 500`, params);
  return rows.map((r) => ({ ...view(r), seller_id: r.seller_id, buyer_user_id: r.buyer_user_id }));
}

module.exports = { CATEGORIES, HOLD_CATEGORIES, HOLD_REASON, openIssue, listForBuyer, listForSeller, respond, resolve, listForAdmin };
