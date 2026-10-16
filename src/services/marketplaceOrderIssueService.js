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
 * Opening an issue never moves money and never changes the order.
 */

const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');

const CATEGORIES = ['not_received', 'not_as_described', 'damaged', 'pickup_problem', 'refund_request', 'other'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_LIMIT_PER_ORDER = 3;

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
      'SELECT id, seller_id, buyer_user_id, payment_status, order_number FROM marketplace_orders WHERE id = $1 AND buyer_user_id = $2 FOR UPDATE',
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
    return view({ ...row, order_number: o.order_number });
  });
}

async function listForBuyer(buyerUserId) {
  const { rows } = await db.query(
    `SELECT i.*, o.order_number, COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name
       FROM marketplace_order_issues i JOIN marketplace_orders o ON o.id = i.order_id JOIN seller_profiles sp ON sp.id = i.seller_id
      WHERE i.buyer_user_id = $1 ORDER BY i.created_at DESC LIMIT 200`, [buyerUserId]);
  return rows.map((r) => view(r));
}

async function sellerIdFor(userId, runner = db) {
  const s = (await runner.query('SELECT id FROM seller_profiles WHERE user_id = $1', [userId])).rows[0];
  if (!s) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  return s.id;
}

async function listForSeller(sellerUserId) {
  const sellerId = await sellerIdFor(sellerUserId);
  const { rows } = await db.query(
    `SELECT i.*, o.order_number FROM marketplace_order_issues i JOIN marketplace_orders o ON o.id = i.order_id
      WHERE i.seller_id = $1 ORDER BY i.created_at DESC LIMIT 200`, [sellerId]);
  return rows.map((r) => view(r, { forSeller: true }));
}

// Seller answers an issue on THEIR order (one response; the buyer's words are never editable).
async function respond(issueId, sellerUserId, body = {}) {
  if (!UUID_RE.test(String(issueId || ''))) throw err(404, 'ISSUE_NOT_FOUND', 'Issue not found.');
  const response = clip(body.response, 4000);
  if (response.length < 2) throw err(422, 'RESPONSE_REQUIRED', 'Write a response.');
  return withTransaction(async (client) => {
    const sellerId = await sellerIdFor(sellerUserId, client);
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
    return view(row);
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

module.exports = { CATEGORIES, openIssue, listForBuyer, listForSeller, respond, resolve, listForAdmin };
