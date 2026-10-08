'use strict';

/**
 * Phone Sasha payment links: Option A of docs/sasha/phone/payment-link-design-memo.md (approved 2026-10-07).
 *
 *   issue()  verified phone session only → Railway confirms the combined invoice belongs to the caller and is payable
 *            → 256-bit random token (only its SHA-256 is stored) bound to user + invoice, 30-minute expiry, single use,
 *            any earlier live link for that invoice superseded → texted (verified phone) or emailed (account email).
 *   open()   /pay/<token>: the link proves WHICH invoice, never WHO. No session → normal sign-in, then back here. A
 *            session for a different account → refused (not consumed). The right account → consumed (single use) and
 *            sent to /invoices.html?pay=<invoice>, the existing Pay Now flow (charge-combined → payment.html → confirm).
 *
 * Nothing about amounts, Stripe objects, tax, invoices, settlement or payouts changes: the link only routes the buyer to
 * the existing, authenticated payment flow, which recomputes everything server-side as it does today.
 */

const crypto = require('crypto');
const db = require('../db');
const audit = require('./sasha/phone/phoneAudit');
const { last4 } = require('../lib/phoneNumber');

const TTL_MINUTES = 30;
const PER_INVOICE_PER_DAY = 3;
const PER_USER_PER_DAY = 5;
const PAYABLE = ['issued', 'unpaid', 'payment_required', 'failed', 'payment_failed'];
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const SITE = () => require('../lib/publicUrls').publicBaseUrl();

class PayLinkError extends Error { constructor(reason, message) { super(message); this.reason = reason; } }

async function findPayableInvoice(userId, invoiceNumber) {
  const inv = (await db.query(`SELECT b.id, b.invoice_number, b.status, b.total_cents, b.buyer_user_id, a.title, COALESCE(a.is_demo, false) is_demo,
      COALESCE(a.pre_launch_test, false) pre_launch_test
      FROM buyer_auction_invoices b JOIN auctions a ON a.id = b.auction_id
     WHERE b.buyer_user_id = $1 AND upper(b.invoice_number) = upper($2)`, [userId, String(invoiceNumber || '').trim()])).rows[0];
  if (!inv) throw new PayLinkError('not_found', 'No invoice with that number on this account.');
  if (!PAYABLE.includes(String(inv.status || '').toLowerCase())) throw new PayLinkError('not_payable', `That invoice is ${String(inv.status).replace(/_/g, ' ')}, so there is nothing to pay.`);
  if (inv.is_demo || inv.pre_launch_test) throw new PayLinkError('not_payable', 'That invoice cannot be paid online.');
  return inv;
}

const TEXT_CONFIRMATION = (l4) => `I'll text a one-time payment link to your number ending in ${l4}. It doesn't sign you up for text alerts.`;

/**
 * ctx: { call, sessionId, userId }. delivery: 'text' | 'email'. deps: { handset, mailbox } in simulations.
 * Returns { sent, delivery, destination_last4 } — never the token or URL (the model must not see it).
 *
 * A text goes ONLY to the verified mobile number already on the account (never a number given during the call), only
 * after Sasha has told the caller TEXT_CONFIRMATION and the caller agreed (confirmedWithCaller), and never to a number
 * that replied STOP. It is a one-time text the caller asked for: it creates no text-alert consent.
 */
async function issue({ call, sessionId, userId }, { invoiceNumber, delivery = 'email', confirmedWithCaller = false }, deps = {}) {
  const rec = (event, detail = {}) => audit.record(call, event, { tool: 'send_payment_link', category: 'payment_link', accountUserId: userId, sessionId, detail });
  await rec('payment_link_requested', { what: delivery });
  if (!userId || !sessionId) { await rec('payment_link_refused', { reason: 'caller not verified' }); return { sent: false, reason: 'not_verified' }; }
  let inv;
  try { inv = await findPayableInvoice(userId, invoiceNumber); }
  catch (e) { await rec('payment_link_refused', { reason: e.reason || 'error' }); return { sent: false, reason: e.reason || 'error', note: e.message }; }
  const n = async (sql, p) => Number((await db.query(sql, p)).rows[0].n);
  if (await n(`SELECT count(*)::int n FROM payment_links WHERE combined_invoice_id = $1 AND created_at > now() - interval '1 day'`, [inv.id]) >= PER_INVOICE_PER_DAY
    || await n(`SELECT count(*)::int n FROM payment_links WHERE user_id = $1 AND created_at > now() - interval '1 day'`, [userId]) >= PER_USER_PER_DAY) {
    await rec('payment_link_refused', { reason: 'rate limit', invoices: [inv.invoice_number] });
    return { sent: false, reason: 'rate_limited', note: 'Several payment links were already sent today. The customer can pay any time from Invoices on the website.' };
  }
  const u = (await db.query(`SELECT email, phone, phone_verified_at, phone_verified_e164 FROM users WHERE id = $1`, [userId])).rows[0];
  const phoneOk = require('./accountPhoneService').isVerified(u);
  const channel = delivery === 'text' && phoneOk ? 'sms' : 'email';
  if (channel === 'email' && !u.email) { await rec('payment_link_refused', { reason: 'no email on account' }); return { sent: false, reason: 'no_destination' }; }
  if (channel === 'sms') {
    const l4 = last4(u.phone_verified_e164);
    if (await require('./smsSuppressionService').isSuppressed(u.phone_verified_e164)) {
      await rec('payment_link_refused', { reason: 'number opted out of texts', invoices: [inv.invoice_number], destination_last4: l4 });
      return { sent: false, reason: 'number_opted_out', note: 'That number has opted out of Advantage.Bid texts (it replied STOP), so the link cannot be texted. Offer to email it to the address on the account instead.' };
    }
    if (confirmedWithCaller !== true) {
      return { sent: false, reason: 'needs_confirmation', needs_confirmation: true, destination_last4: l4, say: TEXT_CONFIRMATION(l4),
        note: 'Nothing was sent yet. Say this to the caller in your own natural voice, wait for a yes, then call send_payment_link again with confirmed_with_caller true.' };
    }
  }
  await db.query(`UPDATE payment_links SET status = 'superseded' WHERE combined_invoice_id = $1 AND status = 'issued'`, [inv.id]);
  const token = crypto.randomBytes(32).toString('base64url');
  const url = `${SITE()}/pay/${token}`;
  const destLast4 = channel === 'sms' ? last4(u.phone_verified_e164) : null;
  await db.query(`INSERT INTO payment_links (token_hash, user_id, combined_invoice_id, invoice_number, amount_cents_at_issue, call_id, phone_session_id, delivery,
      destination_last4, is_simulated, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + interval '${TTL_MINUTES} minutes')`,
  [sha(token), userId, inv.id, inv.invoice_number, inv.total_cents, call.id, sessionId, channel, destLast4, !!call.is_simulated]);
  const amount = '$' + (Number(inv.total_cents || 0) / 100).toFixed(2);
  const smsBody = `Advantage.Bid: pay invoice ${inv.invoice_number} for ${String(inv.title || 'your auction').slice(0, 40)} (${amount}): ${url} Link expires in ${TTL_MINUTES} minutes; sign in to pay.`;
  const mail = { to: u.email, subject: `Pay invoice ${inv.invoice_number}`,
    text: `Here is the secure link to pay invoice ${inv.invoice_number} for ${inv.title || 'your auction'} (${amount}):\n\n${url}\n\nFor your security the link works once, expires in ${TTL_MINUTES} minutes, and asks you to sign in to your Advantage.Bid account. Advantage.Bid will never ask for your card details by phone.` };
  let sent = false;
  if (call.is_simulated) {
    if (channel === 'sms' && Array.isArray(deps.handset)) deps.handset.push({ kind: 'text', to_last4: destLast4, body: smsBody, at: new Date().toISOString() });
    if (channel === 'email' && Array.isArray(deps.mailbox)) deps.mailbox.push({ kind: 'payment_link', to: u.email, subject: mail.subject, body: mail.text, at: new Date().toISOString() });
    sent = true;
  } else if (channel === 'sms') {
    sent = (await require('./sasha/phone/phoneSms').send(call, { to: u.phone_verified_e164, body: smsBody }, deps)).sent;
  } else {
    try { const r = await (deps.emailService || require('./emailService')).sendEmail(mail); sent = !(r && r.skipped); } catch (_e) { sent = false; }
  }
  await rec(sent ? 'payment_link_sent' : 'payment_link_refused', { what: channel, invoices: [inv.invoice_number], destination_last4: destLast4, reason: sent ? null : 'delivery unavailable' });
  if (!sent) await db.query(`UPDATE payment_links SET status = 'expired' WHERE token_hash = $1`, [sha(token)]);
  return sent ? { sent: true, delivery: channel, destination_last4: destLast4, invoice: inv.invoice_number, expires_in_minutes: TTL_MINUTES }
    : { sent: false, reason: 'delivery_unavailable' };
}

/** Landing on /pay/<token>. Returns { action, location, status } for the route to act on. */
async function open(token, sessionUserId) {
  const expired = { action: 'expired', status: 410 };
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return expired;
  const link = (await db.query(`SELECT * FROM payment_links WHERE token_hash = $1`, [sha(token)])).rows[0];
  if (!link) return expired;
  const call = link.call_id ? (await db.query(`SELECT id, conversation_id, is_simulated, simulated_by FROM cs_calls WHERE id = $1`, [link.call_id])).rows[0] : null;
  const rec = (event, detail = {}) => (call ? audit.record(call, event, { tool: 'pay_link', category: 'payment_link', accountUserId: link.user_id, detail }) : null);
  if (link.status !== 'issued' || new Date(link.expires_at) <= new Date()) {
    if (link.status === 'issued') await db.query(`UPDATE payment_links SET status = 'expired' WHERE id = $1`, [link.id]);
    await rec('payment_link_rejected', { reason: link.status === 'issued' ? 'expired' : link.status, invoices: [link.invoice_number] });
    return expired;
  }
  if (!link.opened_at) { await db.query(`UPDATE payment_links SET opened_at = now() WHERE id = $1`, [link.id]); await rec('payment_link_opened', { invoices: [link.invoice_number] }); }
  if (!sessionUserId) return { action: 'login', status: 302, location: '/login.html?next=' + encodeURIComponent('/pay/' + token) };
  if (String(sessionUserId) !== String(link.user_id)) {
    await rec('payment_link_rejected', { reason: 'signed in as a different account', invoices: [link.invoice_number] });
    return { action: 'wrong_account', status: 403 };
  }
  const claimed = await db.query(`UPDATE payment_links SET status = 'consumed', used_at = now() WHERE id = $1 AND status = 'issued' RETURNING id`, [link.id]);
  if (!claimed.rowCount) return expired;
  await rec('payment_link_consumed', { invoices: [link.invoice_number] });
  return { action: 'redirect', status: 302, location: '/invoices.html?pay=' + encodeURIComponent(link.combined_invoice_id) };
}

module.exports = { issue, open, findPayableInvoice, PayLinkError, TTL_MINUTES, PAYABLE, TEXT_CONFIRMATION, _sha: sha };
