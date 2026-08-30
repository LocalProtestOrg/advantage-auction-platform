'use strict';

/**
 * marketplaceOrderNotifier — buyer receipt + seller "item sold" notice for a paid Marketplace order,
 * and a buyer notice on refund. Reuses the platform emailService. Best-effort: callers wrap in try/catch
 * so a mail failure never breaks the payment webhook. No "AI"/vendor terminology in visible copy; only the
 * minimum buyer PII the seller needs to fulfill is shared; seller followers are NOT notified on a sale.
 */

const db = require('../db');
const { sendEmail } = require('./emailService');
const company = require('../lib/companyContact');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const money = (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadContext(orderId) {
  const o = (await db.query(
    `SELECT o.*, mi.title AS item_title,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name,
            su.email AS seller_email, bu.email AS buyer_email, bu.full_name AS buyer_name
       FROM marketplace_orders o
       JOIN marketplace_items mi ON mi.id = o.marketplace_item_id
       JOIN seller_profiles sp ON sp.id = o.seller_id
       JOIN users su ON su.id = sp.user_id
       JOIN users bu ON bu.id = o.buyer_user_id
      WHERE o.id = $1`, [orderId])).rows[0];
  return o || null;
}

function totalsBlock(o) {
  const taxLine = o.tax_cents > 0 ? `<tr><td>Sales tax</td><td align="right">${money(o.tax_cents)}</td></tr>` : '';
  const shipLine = o.shipping_cents > 0 ? `<tr><td>Shipping</td><td align="right">${money(o.shipping_cents)}</td></tr>` : '';
  return `<table style="width:100%;max-width:420px;border-collapse:collapse">
    <tr><td>Item</td><td align="right">${money(o.item_price_cents)}</td></tr>
    ${shipLine}${taxLine}
    <tr><td style="border-top:1px solid #ddd;padding-top:6px"><b>Total</b></td>
        <td align="right" style="border-top:1px solid #ddd;padding-top:6px"><b>${money(o.total_charge_cents)}</b></td></tr>
  </table>`;
}

async function sendPaid(orderId) {
  const o = await loadContext(orderId);
  if (!o) return;
  const method = o.fulfillment_method === 'shipping' ? 'Shipping' : 'Local pickup';
  const next = o.fulfillment_method === 'shipping'
    ? 'The seller will prepare and ship your item. You will receive shipment details when it ships.'
    : 'The seller will prepare your item and mark it ready for pickup. Watch for pickup details.';

  // Buyer receipt
  if (o.buyer_email) {
    const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
      <h2 style="margin:0 0 4px">Order confirmed</h2>
      <p style="color:#555;margin:0 0 16px">Order <b>${esc(o.order_number)}</b> · ${esc(o.seller_name || 'Seller')}</p>
      <p style="font-size:16px;margin:0 0 12px"><b>${esc(o.item_title)}</b></p>
      ${totalsBlock(o)}
      <p style="margin:16px 0 4px"><b>Fulfillment:</b> ${method}</p>
      <p style="color:#555;margin:0 0 16px">${esc(next)}</p>
      <p><a href="${APP_BASE}/app.html#purchases" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">View your purchases</a></p>
      <p style="color:#475569;font-size:13px;margin-top:20px">Need help? <a href="mailto:info@advantage.bid" style="color:#2563eb">info@advantage.bid</a> · <a href="${company.TEL_HREF}" style="color:#2563eb">${company.PHONE_DISPLAY}</a></p>
    </div>`;
    await sendEmail({ to: o.buyer_email, subject: `Order confirmed — ${o.item_title} (${o.order_number})`, html,
      text: `Order ${o.order_number} confirmed. ${o.item_title}. Total ${money(o.total_charge_cents)}. Fulfillment: ${method}. ${next}` });
  }

  // Seller "item sold" notice — includes the buyer contact needed to fulfill + a link to Marketplace Orders.
  if (o.seller_email) {
    const ship = o.ship_to ? `<p style="margin:8px 0"><b>Ship to:</b><br>${esc(JSON.stringify(o.ship_to)).replace(/[{}"']/g, ' ')}</p>` : '';
    const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
      <h2 style="margin:0 0 4px">You sold an item</h2>
      <p style="color:#555;margin:0 0 16px">Order <b>${esc(o.order_number)}</b></p>
      <p style="font-size:16px;margin:0 0 12px"><b>${esc(o.item_title)}</b> — ${money(o.item_price_cents)}</p>
      <p style="margin:8px 0"><b>Fulfillment:</b> ${method}</p>
      <p style="margin:8px 0"><b>Buyer:</b> ${esc(o.buyer_name || 'Buyer')}${o.buyer_email ? ' · ' + esc(o.buyer_email) : ''}</p>
      ${ship}
      <p style="color:#555;margin:12px 0">Your proceeds after the flat 11% selling fee (includes credit card processing): <b>${money(o.seller_proceeds_cents)}</b> (settled by Advantage.Bid after fulfillment).</p>
      <p><a href="${APP_BASE}/seller-orders.html" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">Manage this order</a></p>
      <p style="color:#475569;font-size:13px;margin-top:20px">Need help? <a href="mailto:info@advantage.bid" style="color:#2563eb">info@advantage.bid</a> · <a href="${company.TEL_HREF}" style="color:#2563eb">${company.PHONE_DISPLAY}</a></p>
    </div>`;
    await sendEmail({ to: o.seller_email, subject: `Item sold — ${o.item_title} (${o.order_number})`, html,
      text: `You sold ${o.item_title} (order ${o.order_number}). Fulfillment: ${method}. Buyer: ${o.buyer_name || ''} ${o.buyer_email || ''}. Manage: ${APP_BASE}/seller-orders.html` });
  }
}

async function sendRefunded(orderId) {
  const o = await loadContext(orderId);
  if (!o || !o.buyer_email) return;
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
    <h2 style="margin:0 0 4px">Refund processed</h2>
    <p style="color:#555;margin:0 0 16px">Order <b>${esc(o.order_number)}</b> · ${esc(o.seller_name || 'Seller')}</p>
    <p style="margin:0 0 12px">${esc(o.item_title)}</p>
    <p style="margin:0 0 12px">A refund of <b>${money(o.refunded_amount_cents || o.total_charge_cents)}</b> has been issued to your original payment method.</p>
    <p style="color:#475569;font-size:13px;margin-top:20px">Need help? <a href="mailto:info@advantage.bid" style="color:#2563eb">info@advantage.bid</a> · <a href="${company.TEL_HREF}" style="color:#2563eb">${company.PHONE_DISPLAY}</a></p>
  </div>`;
  await sendEmail({ to: o.buyer_email, subject: `Refund processed — ${o.item_title} (${o.order_number})`, html,
    text: `Refund of ${money(o.refunded_amount_cents || o.total_charge_cents)} processed for order ${o.order_number} (${o.item_title}).` });
}

module.exports = { sendPaid, sendRefunded };
