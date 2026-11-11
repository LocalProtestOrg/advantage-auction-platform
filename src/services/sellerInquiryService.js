'use strict';

/**
 * sellerInquiryService: a visitor's message to a Professional Seller, from the seller's storefront contact form or from
 * an item page's Contact Seller (owner 2026-11-10). One path for both:
 *   - stored in the seller's own inquiry inbox (seller_inquiries; My Storefront > Inquiries), with the item when it is
 *     about one (migration 230);
 *   - the same spam limits as before: at most 5 messages per visitor per hour, 3 to the same seller per day;
 *   - the seller is told by email that a message is waiting (best effort; the inbox is the record). The email carries the
 *     item and the visitor's message, never the visitor's phone or email address (those stay in the signed-in inbox),
 *     and never anything about the storefront that is not public.
 * The seller and item always come from the server (the URL's storefront or item), never from the request body.
 */

const crypto = require('crypto');
const db = require('../db');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const APP_BASE = () => (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');

function err(status, message) { const e = new Error(message); e.status = status; return e; }
function ipHash(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  return crypto.createHash('sha256').update('sf:' + ip).digest('hex').slice(0, 32);
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Record an inquiry. `seller` is the seller profile row (id, storefront_slug, is_demo, user_id); `item` is
 * { id, title } or null. `clean` is the storefront text cleaner. Throws { status, message } for a refused message.
 */
async function record(req, { seller, item = null, clean, runner = db }) {
  const b = req.body || {};
  // A hidden field people never see; automated form fillers do. Accepted quietly and dropped.
  if (b.company_website) return { dropped: true };
  const name = clean(b.name, 120); const email = clean(b.email, 160); const phone = clean(b.phone, 40);
  const message = clean(b.message, 2000);
  if (!name || (!email && !phone)) throw err(400, 'Name and a phone or email are required.');
  if (email && !EMAIL_RE.test(email)) throw err(400, 'Please enter a valid email.');
  if (item && !message) throw err(400, 'Please write your question about this item.');
  const iph = ipHash(req);
  const recent = (await runner.query("SELECT count(*)::int n FROM seller_inquiries WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'", [iph])).rows[0].n;
  if (recent >= 5) throw err(429, 'Too many requests. Please try again later.');
  const perSeller = (await runner.query("SELECT count(*)::int n FROM seller_inquiries WHERE ip_hash = $1 AND seller_id = $2 AND created_at > now() - interval '1 day'", [iph, seller.id])).rows[0].n;
  if (perSeller >= 3) throw err(429, 'You have already contacted this company recently.');
  const row = (await runner.query(
    `INSERT INTO seller_inquiries (seller_id, name, email, phone, city, service, preferred_contact, message, source_slug, ip_hash, is_demo, marketplace_item_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [seller.id, name, email, phone, clean(b.city, 120), clean(b.service, 120), clean(b.preferred_contact, 40), message,
      seller.storefront_slug || null, iph, !!seller.is_demo, item ? item.id : null])).rows[0];
  return { id: row.id, name, message };
}

/** Email the seller's account address that a message is waiting. Best effort: never throws. */
async function notifySeller({ seller, item, name, message }, deps = {}) {
  try {
    if (seller.is_demo) return { skipped: 'demo' };
    const runner = deps.runner || db;
    const owner = (await runner.query('SELECT email FROM users WHERE id = $1 AND is_active IS NOT FALSE', [seller.user_id])).rows[0];
    if (!owner || !EMAIL_RE.test(String(owner.email || ''))) return { skipped: 'no_address' };
    const link = APP_BASE() + '/seller-storefront.html?tab=leads';
    const about = item ? `about your item "${String(item.title || '').slice(0, 120)}"` : 'from your storefront';
    const subject = item ? `New question about your item: ${String(item.title || '').slice(0, 80)}` : 'New message from your storefront';
    const text = [`You have a new message ${about} on Advantage.Bid.`, '', `From: ${name}`, '', String(message || '(no message)'), '',
      `Read it and the buyer's contact details in your Inquiries: ${link}`, '', 'Advantage.Bid'].join('\n');
    const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:16px">
<h2 style="font-size:17px;margin:0 0 12px">You have a new message ${esc(about)}</h2>
<p style="margin:0 0 6px;font-size:14px"><b>From:</b> ${esc(name)}</p>
<p style="margin:0 0 14px;font-size:14px;white-space:pre-line">${esc(message || '(no message)')}</p>
<p style="margin:16px 0"><a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px">Open your Inquiries</a></p>
<p style="margin:0;font-size:12px;color:#64748b">The buyer's contact details are in your Inquiries on Advantage.Bid.</p>
</body></html>`;
    const mail = deps.emailService || require('./emailService');
    const r = await mail.sendEmail({ to: owner.email, subject, text, html });
    return r && r.skipped ? { skipped: 'mail_not_configured' } : { sent: true };
  } catch (e) {
    console.error('[seller-inquiry] seller notice failed:', e.message);
    return { failed: true };
  }
}

module.exports = { record, notifySeller, ipHash };
