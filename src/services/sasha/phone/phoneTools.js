'use strict';

/**
 * Phone-only Sasha tools. Offered ONLY when ctx.channel === 'phone' (web chat and email are unchanged).
 *
 *   Call flow (always):      start_account_verification, request_callback, find_auction
 *   Verified session only:   send_text, send_payment_link, get_my_seller_onboarding, get_my_business_verification, get_my_agreements,
 *                            get_my_auction_registration, get_my_pickup_slots, get_my_order_detail
 *
 * Every account tool reads through the existing authoritative service for that domain and is scoped to ctx.userId,
 * which the call layer sets ONLY from a live verified phone session (never from caller ID or anything said).
 * Every account read on a call is written to the disclosure audit (cs_phone_audit) with references only.
 */

const db = require('../../../db');
const audit = require('./phoneAudit');
const verification = require('./verification');
const { normalizeUsPhone, last4 } = require('../../../lib/phoneNumber');
const { activeNativeAuctionSql } = require('../../../lib/marketplaceVisibility');
const { PROFESSIONAL_SELLER_TYPES } = require('../../../constants/sellerTypes');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE = 'https://bid.advantage.bid';
const money = (c) => (c == null ? null : '$' + (Number(c) / 100).toFixed(2));
const noArgs = { type: 'object', properties: {} };

const FLOW_TOOLS = [
  { name: 'start_account_verification', description: 'Start verifying the caller so you can help with their own account. Ask for the email address OR the verified mobile number on their Advantage.Bid account (one of them). A 4-digit code is sent to contact details already on the account (a text to its verified mobile, otherwise an email). Never offer to send it anywhere else. Set prefer_email when the caller asks to use email. Repeat ONLY what this tool tells you; it never reveals whether an account exists. The system checks the code itself when the caller reads it.',
    input_schema: { type: 'object', properties: { email: { type: 'string' }, phone_number: { type: 'string' }, prefer_email: { type: 'boolean' } } } },
  { name: 'request_callback', description: 'Ask the Advantage.Bid team to call the caller back (a person, not you). Use when the caller wants a person, when request_human applies, or when you cannot finish on this call. Confirm the number first: "caller_id" for the number they are calling from, or the digits they give.',
    input_schema: { type: 'object', properties: { callback_number: { type: 'string', description: '"caller_id" or a US phone number' },
      reason: { type: 'string', enum: ['customer_request', 'dispute', 'legal', 'privacy', 'security', 'fraud', 'account_change', 'uncertain', 'conflict', 'other'] },
      summary: { type: 'string', description: 'One or two sentences for the team' } }, required: ['callback_number', 'reason', 'summary'] } },
  { name: 'find_auction', description: 'Find public auctions from words the caller says ("the Henderson estate in Dayton"). Returns up to 5 matches with title, city/state, status and dates. Use the returned auction_id with get_auction_or_lot (add lot_number for a lot), but never read an id aloud.',
    input_schema: { type: 'object', properties: { words: { type: 'string' } }, required: ['words'] } },
];
const VERIFIED_TOOLS = [
  { name: 'send_text', description: 'Text the verified caller at the phone number on their account (never any other number). what: pickup_details (only if they paid; same rule as get_my_pickup_details), invoices_page, my_bids_page, seller_dashboard, help_center.',
    input_schema: { type: 'object', properties: { what: { type: 'string', enum: ['pickup_details', 'invoices_page', 'my_bids_page', 'seller_dashboard', 'help_center'] }, auction_id: { type: 'string' } }, required: ['what'] } },
  { name: 'send_payment_link', description: 'Send the verified caller a secure link to pay one unpaid auction invoice (use the invoice number from get_my_invoices). Railway checks the invoice is theirs and payable. The link works once, expires in 30 minutes, and asks them to sign in; then they pay on the website. delivery: "text" (ONLY the verified mobile number already on their account) or "email" (their account email). For a text, the first call sends nothing and returns the exact sentence to say first (that the one-time link goes to the number ending in the last four digits, and that it does not sign them up for text alerts); say it naturally, wait for the caller to agree, then call again with confirmed_with_caller true. Never send to a number the caller gives you. Never read the link aloud; never take card details.',
    input_schema: { type: 'object', properties: { invoice_number: { type: 'string' }, delivery: { type: 'string', enum: ['text', 'email'] }, confirmed_with_caller: { type: 'boolean' } }, required: ['invoice_number'] } },
  { name: 'get_my_seller_onboarding', description: 'The verified seller\'s onboarding stage: what step they are on, what is blocking them, and who acts next (them or Advantage.Bid).', input_schema: noArgs },
  { name: 'get_my_business_verification', description: 'The verified Professional Seller\'s business verification status (not submitted, documents needed, under review, more information needed, approved, rejected).', input_schema: noArgs },
  { name: 'get_my_agreements', description: 'The verified seller\'s agreements: which agreement, status (sent, viewed, signed) and dates. Never the agreement text.', input_schema: noArgs },
  { name: 'get_my_auction_registration', description: 'Whether the verified buyer is registered to bid in one auction and what is missing (terms, card, pickup acknowledgement).',
    input_schema: { type: 'object', properties: { auction_id: { type: 'string' } }, required: ['auction_id'] } },
  { name: 'get_my_pickup_slots', description: 'The verified buyer\'s assigned pickup time slots for lots they PAID for. Nothing before payment.',
    input_schema: { type: 'object', properties: { auction_id: { type: 'string' } } } },
  { name: 'get_my_order_detail', description: 'One storefront order of the verified buyer, by order number: item, totals, payment, fulfillment and tracking.',
    input_schema: { type: 'object', properties: { order_number: { type: 'string' } }, required: ['order_number'] } },
];
const VERIFIED_NAMES = new Set(VERIFIED_TOOLS.map((t) => t.name));

// Existing account tools (tools.js ACCOUNT_TOOLS) and the new ones: what each discloses, for the audit.
const CATEGORY = {
  get_my_account: 'account', get_my_bids: 'bids', get_my_invoices: 'invoices', get_my_pickup_details: 'pickup_address', get_my_orders: 'orders',
  get_my_auctions: 'seller_auctions', get_my_settlements: 'settlements', get_my_seller_terms: 'seller_terms', get_my_storefront_orders: 'storefront_orders',
  get_my_seller_onboarding: 'seller_status', get_my_business_verification: 'seller_verification', get_my_agreements: 'agreements',
  get_my_auction_registration: 'registration', get_my_pickup_slots: 'pickup_slot', get_my_order_detail: 'orders', send_text: 'text_message', send_payment_link: 'payment_link',
};

function toolsFor(ctx) { return ctx && ctx.userId ? [...FLOW_TOOLS, ...VERIFIED_TOOLS] : FLOW_TOOLS; }

// ── flow tools ────────────────────────────────────────────────────────────────────────────────────────
async function startAccountVerification(args, ctx) {
  if (ctx.userId) return { note: 'The caller is already verified for this call.' };
  const r = await verification.start(ctx.phone.call, { email: args.email || null, phone: args.email ? null : (args.phone_number || null), prefer: args.prefer_email ? 'email' : null },
    ctx.phone.deps || {});
  if (ctx.phone.onVerification) ctx.phone.onVerification(r);
  return { result: r.reply };
}

async function requestCallback(args, ctx) {
  const call = ctx.phone.call;
  let number = null;
  if (String(args.callback_number || '').toLowerCase() === 'caller_id') number = ctx.phone.callerE164 || null;
  else { const n = normalizeUsPhone(args.callback_number); number = n.e164; }
  if (!number) return { error: 'That callback number is not a valid US number. Ask the caller to say it again, digit by digit.' };
  const escalation = require('./escalation');
  const r = await escalation.requestCallback(call, { number, reason: args.reason, summary: args.summary, userId: ctx.userId || null }, ctx.phone.deps || {});
  if (ctx.phone.onHandoff) ctx.phone.onHandoff(r);
  return { ok: true, note: 'Callback requested. Tell the caller a member of the Advantage.Bid team will call them back at the number ending in '
    + last4(number) + '. Do not promise a time or an outcome.' };
}

async function findAuction(args) {
  const words = String(args.words || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'auction', 'sale', 'estate', 'online', 'with', 'from'].includes(w)).slice(0, 6);
  if (!words.length) return { matches: [], note: 'Ask for a word from the auction title or the city.' };
  const visible = activeNativeAuctionSql('a').replace("a.state IN ('published','active')", "a.state IN ('published','active','closed')");
  const conds = words.map((_, i) => `(a.title ILIKE $${i + 1} OR a.city ILIKE $${i + 1})`);
  const { rows } = await db.query(`SELECT a.id, a.title, a.city, a.address_state, a.state, a.start_time, a.end_time FROM auctions a
    WHERE ${visible} AND ${conds.join(' AND ')} ORDER BY a.end_time DESC NULLS LAST LIMIT 5`, words.map((w) => '%' + w.replace(/[%_]/g, '') + '%'));
  return { matches: rows.map((r) => ({ auction_id: r.id, title: r.title, location: [r.city, r.address_state].filter(Boolean).join(', '), status: r.state,
    starts: r.start_time, ends: r.end_time })), note: rows.length > 1 ? 'Several match: read the titles and ask which one.' : (rows.length ? 'One match.' : 'No public auction matches; ask for another word or the city.') };
}

// ── verified-session tools (each wraps the authoritative service) ────────────────────────────────────────
async function sellerProfile(userId) {
  return (await db.query(`SELECT id, seller_type FROM seller_profiles WHERE user_id = $1`, [userId])).rows[0] || null;
}

const STAGE_WORDS = { onboarding_incomplete: 'finishing account setup', ready_no_auction: 'ready to create a first auction', draft_started: 'working on a draft auction',
  submitted_waiting: 'auction submitted and waiting on Advantage.Bid review', activated: 'has published an auction' };
const BLOCKER_WORDS = { agreement_unsigned: 'the seller agreement still needs to be signed', verification_review_pending: 'business verification documents are with Advantage.Bid for review',
  verification_more_info_requested: 'Advantage.Bid asked for more business verification information', verification_documents_needed: 'business verification documents still need to be uploaded',
  auction_returned_for_changes: 'an auction came back from review with changes requested', draft_incomplete: 'the draft auction is not finished yet', no_auction_created: 'no auction has been started yet',
  auction_awaiting_review: 'the submitted auction is waiting for Advantage.Bid review' };
async function getMySellerOnboarding(_a, ctx) {
  const sp = await sellerProfile(ctx.userId);
  if (!sp) return { note: 'This account has no seller profile.' };
  const activation = require('../../sellerActivationService');
  const [f] = await activation.loadFacts(db, { sellerProfileIds: [sp.id] });
  if (!f) return { note: 'No seller information found.' };
  const st = activation.computeStage(f);
  return { stage: STAGE_WORDS[st.stage] || st.stage, blocker: st.blocker ? (BLOCKER_WORDS[st.blocker] || st.blocker) : null,
    next_step_owner: st.next_owner === 'seller' ? 'the seller' : st.next_owner === 'advantage' ? 'Advantage.Bid' : null, seller_dashboard: `${SITE}/seller-dashboard.html` };
}

async function getMyBusinessVerification(_a, ctx) {
  const sp = await sellerProfile(ctx.userId);
  if (!sp) return { note: 'This account has no seller profile.' };
  if (!PROFESSIONAL_SELLER_TYPES.includes(sp.seller_type)) return { note: 'Business verification applies to Professional Sellers; this is an individual seller account.' };
  const v = await require('../../verificationService').businessVerificationStatus(ctx.userId);
  // Only the status and Advantage.Bid's own message to the seller; never business details or tax ids.
  return { status: String(v.status).replace(/_/g, ' '), message_from_advantage: v.admin_message || null };
}

async function getMyAgreements(_a, ctx) {
  const sp = await sellerProfile(ctx.userId);
  if (!sp) return { note: 'This account has no seller profile.' };
  const agreements = require('../../agreementService');
  const access = await agreements.dashboardAccess(sp.id);
  const list = await agreements.listForSeller(ctx.userId);
  return { seller_tools_unlocked: !!access.access, agreements: list.slice(0, 10).map((a) => ({ agreement: a.template_name, version: a.version_int, status: a.status,
    sent: a.sent_at || a.created_at, signed: a.signed_at || null })), page: `${SITE}/my-agreements.html` };
}

async function getMyAuctionRegistration(args, ctx) {
  if (!UUID.test(args.auction_id || '')) return { error: 'Find the auction first (find_auction), then use its auction_id.' };
  const r = await require('../../auctionRegistrationService').getRegistrationStatus(ctx.userId, args.auction_id);
  return { registered: r.registered, pickup_terms_acknowledged: !!r.pickup_acknowledged, current_terms_accepted: !!r.terms_accepted_current, card_on_file: !!r.card_on_file };
}

async function getMyPickupSlots(args, ctx) {
  const params = [ctx.userId];
  let where = `b.buyer_user_id = $1 AND b.status = 'paid'`;
  if (UUID.test(args.auction_id || '')) { params.push(args.auction_id); where += ' AND b.auction_id = $2'; }
  const lots = (await db.query(`SELECT l.id, l.title, l.lot_number_display, l.lot_number, a.title auction_title, a.timezone
      FROM buyer_auction_invoices b JOIN auctions a ON a.id = b.auction_id JOIN lots l ON l.auction_id = a.id AND l.winning_buyer_user_id = b.buyer_user_id
     WHERE ${where} ORDER BY b.paid_at DESC LIMIT 25`, params)).rows;
  const schedule = require('../../pickupScheduleService');
  const slots = [];
  for (const l of lots) {
    let s = null; try { s = await schedule.getPickupAssignment(l.id, ctx.userId); } catch (_e) { s = null; }   // the service enforces paid-only
    if (s) slots.push({ lot: `${l.title} (lot ${l.lot_number_display || l.lot_number})`, auction: l.auction_title, from: s.slot_start, to: s.slot_end, timezone: l.timezone });
  }
  return slots.length ? { slots } : { slots: [], note: 'No assigned pickup slots for paid lots. The auction\'s pickup window applies (get_my_pickup_details).' };
}

async function getMyOrderDetail(args, ctx) {
  const orders = require('../../marketplaceOrderService');
  const num = String(args.order_number || '').trim().toUpperCase().replace(/\s+/g, '');
  const mine = (await orders.listForBuyer(ctx.userId)).find((o) => String(o.order_number || '').toUpperCase() === num);
  if (!mine) return { note: 'No order with that number on this account. Ask the caller to read it again.' };
  const o = await orders.getForBuyer(mine.id, ctx.userId);
  if (!o) return { note: 'No order with that number on this account.' };
  // Buyer-facing fields only (no seller fee or proceeds).
  return { order: o.order_number, item: mine.item_title, item_price: money(o.item_price_cents), shipping: money(o.shipping_cents), tax: money(o.tax_cents),
    total: money(o.total_charge_cents), payment: o.payment_status, refund: o.refund_status || null, fulfillment: o.fulfillment_status, method: o.fulfillment_method,
    tracking: o.tracking_number ? `${o.tracking_carrier || ''} ${o.tracking_number}`.trim() : null, placed: o.created_at, paid: o.paid_at };
}

async function sendText(args, ctx) {
  const call = ctx.phone.call;
  const u = (await db.query(`SELECT phone, phone_verified_at, phone_verified_e164 FROM users WHERE id = $1`, [ctx.userId])).rows[0];
  if (!require('../../accountPhoneService').isVerified(u)) return { sent: false, note: 'There is no verified mobile number on this account to text. Offer email instead where available.' };
  const dest = normalizeUsPhone(u.phone_verified_e164);
  let body;
  if (args.what === 'pickup_details') {
    const r = await require('../tools')._internal.getMyPickupDetails({ auction_id: args.auction_id }, ctx);   // the same paid-only gate
    if (!r.pickups || !r.pickups.length) {
      await audit.record(call, 'text_refused', { tool: 'send_text', category: 'pickup_address', accountUserId: ctx.userId, sessionId: ctx.phone.sessionId, detail: { what: 'pickup_details', reason: 'not authorized (no paid purchase)' } });
      return { sent: false, note: 'Pickup details are shared only after payment, so nothing was texted.' };
    }
    const p = r.pickups[0];
    body = `Advantage.Bid pickup for ${p.auction}: ${p.pickup_address}.` + (p.pickup_window ? ` Window: ${new Date(p.pickup_window.from).toLocaleString('en-US', { timeZone: p.pickup_window.timezone || 'America/New_York' })} to ${new Date(p.pickup_window.to).toLocaleString('en-US', { timeZone: p.pickup_window.timezone || 'America/New_York' })}.` : '');
  } else {
    const page = { invoices_page: '/invoices.html', my_bids_page: '/my-bids.html', seller_dashboard: '/seller-dashboard.html', help_center: '/faq.html' }[args.what];
    if (!page) return { error: 'unknown text type' };
    body = `Advantage.Bid: here is the link we discussed: ${SITE}${page}`;
  }
  const sms = require('./phoneSms');
  const sent = await sms.send(call, { to: dest.e164, body }, ctx.phone.deps || {});
  await audit.record(call, sent.sent ? 'text_sent' : 'text_refused', { tool: 'send_text', category: args.what === 'pickup_details' ? 'pickup_address' : 'link',
    accountUserId: ctx.userId, sessionId: ctx.phone.sessionId, detail: { what: args.what, destination_last4: last4(dest.e164), reason: sent.sent ? null : sent.reason } });
  return sent.sent ? { sent: true, note: 'Texted to the number on file ending in ' + last4(dest.e164) + '.' } : { sent: false, note: 'Texting is not available right now; offer to read it or have the team follow up.' };
}

async function sendPaymentLink(args, ctx) {
  // Only these three arguments are read: a destination number is never accepted from the call.
  const r = await require('../../payLinkService').issue({ call: ctx.phone.call, sessionId: ctx.phone.sessionId, userId: ctx.userId },
    { invoiceNumber: args.invoice_number, delivery: args.delivery === 'text' ? 'text' : 'email', confirmedWithCaller: args.confirmed_with_caller === true }, ctx.phone.deps || {});
  if (r.needs_confirmation) return { sent: false, needs_confirmation: true, say: r.say, note: r.note };
  if (r.sent) return { sent: true, note: `A secure payment link for invoice ${r.invoice} was sent by ${r.delivery === 'sms' ? 'text to the mobile number ending in ' + r.destination_last4 : 'email to the address on the account'}. It works once, expires in 30 minutes, and asks them to sign in. Do not read any link aloud.` };
  return { sent: false, note: r.note || 'The payment link could not be sent. The customer can pay any time from Invoices on the website, or a team member can follow up.' };
}

const EXEC = {
  start_account_verification: startAccountVerification, request_callback: requestCallback, find_auction: findAuction, send_text: sendText, send_payment_link: sendPaymentLink,
  get_my_seller_onboarding: getMySellerOnboarding, get_my_business_verification: getMyBusinessVerification, get_my_agreements: getMyAgreements,
  get_my_auction_registration: getMyAuctionRegistration, get_my_pickup_slots: getMyPickupSlots, get_my_order_detail: getMyOrderDetail,
};

/** Summarise a tool result for the audit (references only) and decide disclosed vs nothing-to-disclose. */
function auditShape(name, out) {
  if (!out || out.error) return { event: 'tool_nothing_to_disclose', detail: { outcome: 'error' } };
  const empty = (k) => Array.isArray(out[k]) && out[k].length === 0;
  if (name === 'get_my_pickup_details') return empty('pickups') ? { event: 'tool_nothing_to_disclose', detail: { outcome: 'not authorized or nothing paid' } } : { event: 'tool_disclosed', detail: { count: out.pickups.length } };
  if (name === 'get_my_invoices') return empty('invoices') ? { event: 'tool_nothing_to_disclose', detail: {} } : { event: 'tool_disclosed', detail: { invoices: out.invoices.map((i) => i.invoice), count: out.invoices.length } };
  if (name === 'get_my_pickup_slots') return empty('slots') ? { event: 'tool_nothing_to_disclose', detail: {} } : { event: 'tool_disclosed', detail: { slot_count: out.slots.length } };
  if (out.note && Object.keys(out).length <= 2 && !out.stage && !out.status) return { event: 'tool_nothing_to_disclose', detail: { outcome: 'no data' } };
  const count = ['bids', 'orders', 'auctions', 'settlements', 'agreements'].map((k) => (Array.isArray(out[k]) ? out[k].length : null)).find((n) => n != null);
  return { event: 'tool_disclosed', detail: { count: count == null ? null : count, stage: out.stage || null, status: out.status || out.payment || null } };
}

/** Run a phone-only tool. */
async function run(name, input, ctx) {
  const fn = EXEC[name];
  if (!fn) return null;   // not a phone tool
  if (VERIFIED_NAMES.has(name) && !ctx.userId) {
    await audit.record(ctx.phone.call, 'tool_refused', { tool: name, category: CATEGORY[name] || null, detail: { reason: 'caller not verified' } });
    return { error: 'The caller is not verified. Use start_account_verification first.' };
  }
  try { return await fn(input || {}, ctx); } catch (e) { console.error('[sasha-phone] tool', name, e.message); return { error: 'lookup failed' }; }
}

module.exports = { toolsFor, run, auditShape, FLOW_TOOLS, VERIFIED_TOOLS, CATEGORY, VERIFIED_NAMES, _internal: { findAuction, getMySellerOnboarding } };
