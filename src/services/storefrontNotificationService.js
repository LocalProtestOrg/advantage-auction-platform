'use strict';

/**
 * Reliable storefront seller notifications (Milestone N; migration 204; roadmap §8.1).
 *
 *   enqueueSalePaid(client, order)  — called INSIDE the transaction that marks an order paid: one outbox row per
 *                                     (order, event, recipient). Never for a started, pending or failed checkout.
 *   tick()                          — delivers due rows: lease → render → send → record; back-off retries; after the
 *                                     last attempt the row is 'failed' and the owner is alerted. A stale lease is reclaimed.
 *                                     Delivery is at-least-once (see tick).
 *   start()                         — runs tick() on an interval (in-process).
 *
 * Content (owner rules 2026-10-16): the sold item (title, description excerpt, real https thumbnail when available), the
 * seller's inventory number, sale price, order number, fulfilment method, the 11% platform fee on the item price and the
 * estimated proceeds, and a link to the authenticated seller order page. NEVER the buyer's name, email, phone or address,
 * and never payment data. Rendered from the order's own fixed purchase snapshot, so it describes exactly what was sold.
 * Recipient: the company owner's account email (staff recipients and preferences are a later milestone).
 */
const db = require('../db');
const company = require('../lib/companyContact');

const MAX_ATTEMPTS = 6;
const BATCH = 20;
const LEASE_SEC = 300;
const INTERVAL_MS = 30000;
const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + (Math.max(0, Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const backoffMinutes = (attempts) => Math.min(240, 2 ** attempts);   // 2, 4, 8, 16, 32 … minutes (capped at 4 hours)

// Inside the paid transaction. The recipient is the order's OWN seller company owner (from the order row, never a caller).
async function enqueueSalePaid(client, orderId) {
  await client.query(
    `INSERT INTO storefront_notifications (seller_id, order_id, event, recipient_user_id, recipient_email)
     SELECT o.seller_id, o.id, 'sale_paid', u.id, lower(u.email)
       FROM marketplace_orders o JOIN seller_profiles sp ON sp.id = o.seller_id JOIN users u ON u.id = sp.user_id
      WHERE o.id = $1 AND o.payment_status = 'paid' AND u.email IS NOT NULL
     ON CONFLICT (order_id, event, recipient_email) DO NOTHING`, [orderId]);
}

function renderSalePaid(o) {
  const snap = o.item_snapshot && typeof o.item_snapshot === 'object' ? o.item_snapshot : {};
  const title = snap.title || o.item_title || 'Item';
  const desc = snap.description ? String(snap.description).replace(/\s+/g, ' ').trim().slice(0, 280) : '';
  const thumb = snap.thumbnail_url && /^https:\/\//i.test(snap.thumbnail_url) ? snap.thumbnail_url : null;
  const inv = snap.inventory_number || null;
  const method = o.fulfillment_method === 'shipping' ? 'Shipping' : 'Local pickup';
  const action = o.fulfillment_method === 'shipping'
    ? 'Next step: pack and ship the item, then record the carrier and tracking number in Marketplace Orders.'
    : 'Next step: prepare the item and mark it "Ready for Pickup" in Marketplace Orders, where the pickup details are.';
  const pct = (Number(o.platform_fee_bps) || 0) / 100;
  const link = `${APP_BASE}/seller-orders.html`;
  const subject = `Item sold — ${title}${inv ? ' (#' + inv + ')' : ''} · order ${o.order_number}`;
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
      <h2 style="margin:0 0 4px">You sold an item</h2>
      <p style="color:#555;margin:0 0 16px">Order <b>${esc(o.order_number)}</b> · payment confirmed</p>
      ${thumb ? `<p style="margin:0 0 12px"><img src="${esc(thumb)}" alt="${esc(title)}" width="120" style="border-radius:8px;max-width:120px"></p>` : ''}
      <p style="font-size:16px;margin:0 0 6px"><b>${esc(title)}</b></p>
      ${inv ? `<p style="margin:0 0 6px">Your inventory number: <b>${esc(inv)}</b></p>` : ''}
      ${desc ? `<p style="color:#555;margin:0 0 12px">${esc(desc)}</p>` : ''}
      <table style="border-collapse:collapse;margin:8px 0">
        <tr><td style="padding:2px 12px 2px 0">Sale price</td><td align="right"><b>${money(o.item_price_cents)}</b></td></tr>
        <tr><td style="padding:2px 12px 2px 0">Advantage.Bid fee (${esc(pct)}% of the item price, includes card processing)</td><td align="right">−${money(o.platform_fee_cents)}</td></tr>
        ${o.shipping_cents > 0 ? `<tr><td style="padding:2px 12px 2px 0">Shipping collected</td><td align="right">${money(o.shipping_cents)}</td></tr>` : ''}
        <tr><td style="padding:2px 12px 2px 0">Estimated proceeds</td><td align="right"><b>${money(o.seller_proceeds_cents)}</b></td></tr>
      </table>
      <p style="margin:8px 0"><b>Fulfillment:</b> ${method}</p>
      <p style="margin:8px 0">${esc(action)}</p>
      <p style="color:#555;font-size:13px;margin:8px 0">Final amounts appear in your settlement statement. Sign in to see this order.</p>
      <p><a href="${link}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">Manage this order</a></p>
      <p style="color:#475569;font-size:13px;margin-top:20px">Need help? <a href="mailto:info@advantage.bid" style="color:#2563eb">info@advantage.bid</a> · <a href="${company.TEL_HREF}" style="color:#2563eb">${company.PHONE_DISPLAY}</a></p>
    </div>`;
  const text = [`You sold ${title}${inv ? ' (inventory #' + inv + ')' : ''} — order ${o.order_number}, payment confirmed.`,
    `Sale price ${money(o.item_price_cents)}; Advantage.Bid fee ${money(o.platform_fee_cents)} (${pct}% of the item price); estimated proceeds ${money(o.seller_proceeds_cents)}.`,
    `Fulfillment: ${method}. ${action}`, `Manage: ${link}`].join('\n');
  return { subject, html, text };
}

async function deliverOne(row, deps) {
  const o = (await db.query(
    `SELECT o.id, o.seller_id, o.order_number, o.item_snapshot, o.item_price_cents, o.shipping_cents, o.platform_fee_bps, o.platform_fee_cents,
            o.seller_proceeds_cents, o.fulfillment_method, o.payment_status
       FROM marketplace_orders o WHERE o.id = $1 AND o.seller_id = $2`, [row.order_id, row.seller_id])).rows[0];
  // Only a still-paid order is announced (a sale refunded before delivery is not "You sold an item").
  if (!o || o.payment_status !== 'paid') {
    await db.query(`UPDATE storefront_notifications SET status = 'skipped', last_error = $2, locked_at = NULL WHERE id = $1`,
      [row.id, o ? 'order ' + o.payment_status : 'order not found']);
    return 'skipped';
  }
  const msg = renderSalePaid(o);
  const mail = deps.emailService || require('./emailService');
  let r;
  try {
    r = await mail.sendEmail({ to: row.recipient_email, subject: msg.subject, html: msg.html, text: msg.text });
  } catch (e) {
    const attempts = row.attempts;   // counted when the row was leased
    const final = attempts >= MAX_ATTEMPTS;
    await db.query(`UPDATE storefront_notifications SET status = $2, attempts = $3, last_error = $4, locked_at = NULL,
      next_attempt_at = now() + ($5 || ' minutes')::interval WHERE id = $1`,
      [row.id, final ? 'failed' : 'pending', attempts, String(e.message || e).slice(0, 500), String(backoffMinutes(attempts))]);
    if (final) {
      try {
        const alerts = deps.ownerAlertService || require('./ownerAlertService');
        await alerts.notifyAdminActionRequired({ actionType: alerts.ALERT_TYPES.STOREFRONT_NOTIFICATION_FAILED || 'storefront_notification_failed',
          entityType: 'storefront_notification', entityId: row.id, headline: `Seller sale notice for order ${o.order_number} could not be delivered`,
          context: `${MAX_ATTEMPTS} attempts failed. Contact the seller about this sale.`, adminPath: '/admin/marketplace-orders.html' });
      } catch (_e) { /* the alert is best-effort; the row stays 'failed' for review */ }
    }
    return final ? 'failed' : 'retry';
  }
  // Recorded outside the send's try: a database hiccup here never turns a delivered notice back into 'pending'.
  await db.query(`UPDATE storefront_notifications SET status = 'sent', sent_at = now(), locked_at = NULL, provider_message_id = $2, last_error = NULL
    WHERE id = $1`, [row.id, (r && (r.messageId || r.MessageId)) || null]);
  return 'sent';
}

// One delivery pass. Leases due rows with SKIP LOCKED, so two processes never pick the same row at the same time.
// Delivery is AT-LEAST-ONCE: if a process dies after the email is handed over but before it is recorded, the lease is
// reclaimed after LEASE_SEC and the notice may be sent once more (rare duplicate, never a lost notice). Each lease counts
// as an attempt, so a notice that keeps crashing the sender still reaches 'failed' and alerts the owner.
async function tick(deps = {}) {
  await db.query(`UPDATE storefront_notifications SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END, locked_at = NULL,
      last_error = COALESCE(last_error, 'delivery interrupted')
    WHERE status = 'processing' AND locked_at < now() - interval '${LEASE_SEC} seconds'`);
  const rows = (await db.query(
    `UPDATE storefront_notifications SET status = 'processing', locked_at = now(), attempts = attempts + 1
      WHERE id IN (SELECT id FROM storefront_notifications WHERE status = 'pending' AND next_attempt_at <= now()
                    ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING *`)).rows;
  const out = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  for (const row of rows) out[await deliverOne(row, deps)]++;
  return out;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => console.error('[storefront-notify] tick failed:', e.message)); }, INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = { enqueueSalePaid, renderSalePaid, tick, start, MAX_ATTEMPTS, backoffMinutes };
