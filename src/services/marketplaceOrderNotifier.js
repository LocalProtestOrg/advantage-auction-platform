'use strict';

/**
 * marketplaceOrderNotifier — buyer receipt + seller "item sold" notice for a paid Marketplace order,
 * and a buyer notice on refund. Reuses the platform emailService. Best-effort: callers wrap in try/catch
 * so a mail failure never breaks the payment webhook. No "AI"/vendor terminology in visible copy. The seller's sale notice
 * is delivered by storefrontNotificationService (queued, retried, no buyer contact details). Seller followers are NOT
 * notified on a sale.
 */

const db = require('../db');
const { sendEmail } = require('./emailService');
const company = require('../lib/companyContact');
const { REFUND_TIMING_SENTENCE } = require('../lib/refundCopy');
const { isProfessional } = require('./sellerTypeRules');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const money = (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadContext(orderId) {
  const o = (await db.query(
    `SELECT o.*, mi.title AS item_title, mi.pickup_location_source, mi.pickup_address_line1, mi.pickup_address_line2, mi.pickup_city,
            mi.pickup_state, mi.pickup_postal_code, mi.pickup_country,
            sp.default_pickup_address_line1, sp.default_pickup_address_line2, sp.default_pickup_city, sp.default_pickup_state,
            sp.default_pickup_postal_code, sp.default_pickup_country, sp.default_pickup_confirmed_at,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name,
            sp.seller_type AS seller_type_now, sp.storefront AS seller_storefront, sp.storefront_slug, sp.storefront_published,
            sp.metadata->>'public_phone' AS seller_meta_public_phone, sp.metadata->>'website' AS seller_meta_website,
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
    <tr><td>${Number(o.quantity) > 1 ? `Item (${Number(o.quantity)} &times; ${money(o.unit_price_cents)})` : 'Item'}</td><td align="right">${money(o.item_price_cents)}</td></tr>
    ${shipLine}${taxLine}
    <tr><td style="border-top:1px solid #ddd;padding-top:6px"><b>Total</b></td>
        <td align="right" style="border-top:1px solid #ddd;padding-top:6px"><b>${money(o.total_charge_cents)}</b></td></tr>
  </table>`;
}

// Pickup address for a PAID pickup order (payment is verified, so the full address may be shared with the buyer).
function pickupBlock(o) {
  if (o.fulfillment_method === 'shipping') return '';
  // The pickup address recorded at purchase (migration 197); older orders fall back to the item's current location.
  const snap = o.pickup_snapshot && typeof o.pickup_snapshot === 'object' ? o.pickup_snapshot : null;
  const a = snap && snap.line1 ? snap : require('../lib/saleLocation').forItem(o).address;
  if (!a || !a.line1) return '';
  const line2 = a.line2 ? esc(a.line2) + '<br>' : '';
  return `<p style="margin:0 0 16px"><b>Pickup location:</b><br>${esc(a.line1)}<br>${line2}`
    + `${esc(a.city)}, ${esc(a.state)} ${esc(a.postal_code)}</p>`;
}

// ── Who to contact ─────────────────────────────────────────────────────────────────────────────────────
// A PROFESSIONAL seller is the first contact for questions about the item, using ONLY the business details the seller
// published on their storefront (the same fields the public storefront page shows). With none published, the buyer is
// sent to the item page's Contact Seller form. A seller's account email, personal phone or address is never used, and a
// non-professional seller's details are never shown at all: those conversations go through Advantage.Bid.
// Advantage.Bid stays the contact for payments, refunds, disputes and anything the seller cannot resolve.
const httpUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : null);
function storefrontUrl(o) {
  return isProfessional(o.seller_type_now) && o.storefront_published && o.storefront_slug
    ? `${APP_BASE}/pro/${encodeURIComponent(o.storefront_slug)}` : null;
}
function sellerContact(o) {
  if (!isProfessional(o.seller_type_now)) return null;
  const cfg = o.seller_storefront && typeof o.seller_storefront === 'object' ? o.seller_storefront : {};
  const pub = !!o.storefront_published;   // details count as public only while the storefront page showing them is published
  const email = pub && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(String(cfg.public_email || '')) ? String(cfg.public_email) : null;
  const phone = pub ? String(cfg.public_phone || o.seller_meta_public_phone || '').replace(/[^\d+()\-. x]/gi, '').trim().slice(0, 40) || null : null;
  const website = pub ? httpUrl(cfg.website || o.seller_meta_website) : null;
  return { name: o.seller_name || 'the seller', email, phone, website, storefront: storefrontUrl(o),
    contactLink: `${APP_BASE}/item.html?id=${encodeURIComponent(o.marketplace_item_id)}` };
}
const LINK = 'color:#2563eb';
function sellerNameHtml(o) {
  const url = storefrontUrl(o); const name = esc(o.seller_name || 'Seller');
  return url ? `<a href="${esc(url)}" style="${LINK}">${name}</a>` : name;
}
function helpBlock(o) {
  const c = sellerContact(o);
  const platform = `<a href="mailto:${company.SUPPORT_EMAIL}" style="${LINK}">${company.SUPPORT_EMAIL}</a> or <a href="${company.TEL_HREF}" style="${LINK}">${company.PHONE_DISPLAY}</a>`;
  if (!c) {
    return `<p style="color:#475569;font-size:13px;margin-top:20px">Need help? Contact ${company.NAME}: ${platform}</p>`;
  }
  const parts = [];
  if (c.phone) parts.push(esc(c.phone));
  if (c.email) parts.push(`<a href="mailto:${esc(c.email)}" style="${LINK}">${esc(c.email)}</a>`);
  if (c.website) parts.push(`<a href="${esc(c.website)}" style="${LINK}">${esc(c.website.replace(/^https?:\/\//i, '').replace(/\/$/, ''))}</a>`);
  const how = parts.length ? parts.join(' &middot; ') : `<a href="${esc(c.contactLink)}" style="${LINK}">Contact Seller</a>`;
  const shop = c.storefront ? ` &middot; <a href="${esc(c.storefront)}" style="${LINK}">Visit the shop</a>` : '';
  return `<p style="color:#475569;font-size:13px;margin:20px 0 6px"><b>Questions about your item?</b> Contact ${esc(c.name)}: ${how}${shop}</p>
      <p style="color:#475569;font-size:13px;margin:0">For payments, refunds, disputes or anything the seller cannot resolve, contact ${company.NAME}: ${platform}</p>`;
}
function helpText(o) {
  const c = sellerContact(o);
  const platform = `${company.NAME}: ${company.SUPPORT_EMAIL} or ${company.PHONE_DISPLAY}`;
  if (!c) return `Need help? Contact ${platform}.`;
  const parts = [c.phone, c.email, c.website].filter(Boolean);
  return `Questions about your item? Contact ${c.name}: ${parts.length ? parts.join(', ') : c.contactLink}. For payments, refunds, disputes or anything the seller cannot resolve, contact ${platform}.`;
}

async function sendPaid(orderId) {
  const o = await loadContext(orderId);
  if (!o) return;
  const method = o.fulfillment_method === 'shipping' ? 'Shipping' : 'Local pickup';
  const next = o.fulfillment_method === 'shipping'
    ? 'The seller will prepare and ship your item. The carrier and tracking number appear under View your purchases once it ships.'
    : 'The seller will prepare your item for pickup. Check View your purchases for pickup details and status.';

  // Buyer receipt
  if (o.buyer_email) {
    const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
      <h2 style="margin:0 0 4px">Order confirmed</h2>
      <p style="color:#555;margin:0 0 16px">Order <b>${esc(o.order_number)}</b> &middot; ${sellerNameHtml(o)}</p>
      <p style="font-size:16px;margin:0 0 12px"><b>${esc(o.item_title)}</b>${Number(o.quantity) > 1 ? ` &times; ${Number(o.quantity)}` : ''}</p>
      ${totalsBlock(o)}
      <p style="margin:16px 0 4px"><b>Fulfillment:</b> ${method}</p>
      <p style="color:#555;margin:0 0 16px">${esc(next)}</p>
      ${pickupBlock(o)}
      <p><a href="${APP_BASE}/marketplace-purchases.html" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">View your purchases</a></p>
      ${helpBlock(o)}
    </div>`;
    await sendEmail({ to: o.buyer_email, subject: `Order confirmed: ${o.item_title} (${o.order_number})`, html,
      text: `Order ${o.order_number} confirmed. ${o.item_title}${Number(o.quantity) > 1 ? ' x ' + Number(o.quantity) : ''}. Total ${money(o.total_charge_cents)}. Fulfillment: ${method}. ${next} ${helpText(o)}` });
  }

  // The seller "item sold" notice is no longer sent here: it is queued in the paid transaction and delivered with retries
  // by storefrontNotificationService (migration 204), with no buyer contact details.
}

async function sendRefunded(orderId) {
  const o = await loadContext(orderId);
  if (!o || !o.buyer_email) return;
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
    <h2 style="margin:0 0 4px">Refund processed</h2>
    <p style="color:#555;margin:0 0 16px">Order <b>${esc(o.order_number)}</b> &middot; ${sellerNameHtml(o)}</p>
    <p style="margin:0 0 12px">${esc(o.item_title)}</p>
    <p style="margin:0 0 12px">A refund of <b>${money(o.refunded_amount_cents || o.total_charge_cents)}</b> has been issued to your original payment method. ${REFUND_TIMING_SENTENCE}</p>
    ${helpBlock(o)}
  </div>`;
  await sendEmail({ to: o.buyer_email, subject: `Refund processed: ${o.item_title} (${o.order_number})`, html,
    text: `A refund of ${money(o.refunded_amount_cents || o.total_charge_cents)} has been issued to your original payment method for order ${o.order_number} (${o.item_title}). ${REFUND_TIMING_SENTENCE} ${helpText(o)}` });
}

// The buyer's payment went through after the item was no longer available (e.g. their checkout session had
// expired and another buyer purchased it). The platform refunded the full amount automatically.
async function sendConflictRefunded(orderId) {
  const o = await loadContext(orderId);
  if (!o || !o.buyer_email) return;
  const amount = money(o.refunded_amount_cents || o.total_charge_cents);
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
    <h2 style="margin:0 0 4px">Your payment has been refunded</h2>
    <p style="color:#555;margin:0 0 16px">Order <b>${esc(o.order_number)}</b> &middot; ${sellerNameHtml(o)}</p>
    <p style="margin:0 0 12px">We're sorry. <b>${esc(o.item_title)}</b> was no longer available by the time your payment completed, so the order could not be filled.</p>
    <p style="margin:0 0 12px">A refund of the full <b>${amount}</b> has been issued to your original payment method. ${REFUND_TIMING_SENTENCE}</p>
    <p><a href="${APP_BASE}/" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">Keep browsing</a></p>
    ${helpBlock(o)}
  </div>`;
  await sendEmail({ to: o.buyer_email, subject: `Payment refunded: ${o.item_title} (${o.order_number})`, html,
    text: `${o.item_title} was no longer available when your payment completed, so order ${o.order_number} could not be filled. A refund of the full ${amount} has been issued to your original payment method. ${REFUND_TIMING_SENTENCE} ${helpText(o)}` });
}

// The seller marked a shipping order as shipped (carrier and tracking are required for that step). Sent once, when the
// order moves to shipped. Only the carrier and tracking number the seller entered are shown; nothing is inferred.
async function sendShipped(orderId) {
  const o = await loadContext(orderId);
  if (!o || !o.buyer_email || o.fulfillment_method !== 'shipping' || !o.tracking_carrier || !o.tracking_number) return;
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
    <h2 style="margin:0 0 4px">Your order has shipped</h2>
    <p style="color:#555;margin:0 0 16px">Order <b>${esc(o.order_number)}</b> &middot; ${sellerNameHtml(o)}</p>
    <p style="font-size:16px;margin:0 0 12px"><b>${esc(o.item_title)}</b>${Number(o.quantity) > 1 ? ` &times; ${Number(o.quantity)}` : ''}</p>
    <p style="margin:0 0 4px"><b>Carrier:</b> ${esc(o.tracking_carrier)}</p>
    <p style="margin:0 0 16px"><b>Tracking number:</b> ${esc(o.tracking_number)}</p>
    <p style="color:#555;margin:0 0 16px">Enter the tracking number on the carrier's website to follow your delivery. Tracking can take a day to begin updating.</p>
    <p><a href="${APP_BASE}/marketplace-purchases.html" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">View your purchases</a></p>
    ${helpBlock(o)}
  </div>`;
  await sendEmail({ to: o.buyer_email, subject: `Your order has shipped: ${o.item_title} (${o.order_number})`, html,
    text: `Order ${o.order_number} has shipped. ${o.item_title}. Carrier: ${o.tracking_carrier}. Tracking number: ${o.tracking_number}. ${helpText(o)}` });
}

module.exports = { sendPaid, sendRefunded, sendConflictRefunded, sendShipped, sellerContact };
