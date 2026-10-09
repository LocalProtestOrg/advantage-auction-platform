'use strict';

/**
 * Sasha's tools — what the model may look up or do. Three tiers (owner directive §14):
 *   A. Knowledge (always):          search_help_center, get_platform_rules, get_auction_or_lot (public data only)
 *   B. Live account facts (read-only, ONLY for the signed-in chat user, only about THEMSELVES):
 *        get_my_account, get_my_bids, get_my_invoices, get_my_pickup_details, get_my_orders,
 *        get_my_auctions, get_my_settlements, get_my_seller_terms, get_my_storefront_orders
 *   C. Actions: request_human only. Sasha changes no money, account, order or auction data.
 *
 * Authorization is decided HERE from ctx (server-set), never from anything the customer or the model says: an email
 * sender, a claimed name, or an id in the conversation grants nothing. Public auction data follows the platform
 * visibility rule and the location privacy rule (city/state only; the pickup street address only to that auction's
 * paying buyer via get_my_pickup_details).
 */

const db = require('../../db');
const helpIndex = require('./knowledge/helpIndex');
const platformFacts = require('./knowledge/platformFacts');
const saleLocation = require('../../lib/saleLocation');
const { activeNativeAuctionSql } = require('../../lib/marketplaceVisibility');
const { PROFESSIONAL_SELLER_TYPES } = require('../../constants/sellerTypes');

const SITE = 'https://bid.advantage.bid';
const money = (c) => (c == null ? null : '$' + (Number(c) / 100).toFixed(2));
const bpsPct = (b) => (b == null ? null : (Number(b) / 100).toFixed(Number(b) % 100 ? 2 : 0) + '%');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HANDOFF_REASONS = ['customer_request', 'dispute', 'legal', 'privacy', 'security', 'fraud', 'account_change', 'uncertain', 'conflict', 'other'];

// ── Tool schemas (Anthropic tool-use format) ────────────────────────────────────────────────────────────
const KNOWLEDGE_TOOLS = [
  { name: 'search_help_center', description: 'Search Advantage.Bid\'s public help pages, FAQs, terms and approved support guidance. Use for how-to and policy questions. Returns relevant passages with their page links.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for, in plain words' } }, required: ['query'] } },
  { name: 'get_platform_rules', description: 'Authoritative platform rules read from the live system (these override help-page wording if they differ). Topics: bidding (increments, soft close, max bids, registration), buyer_premium, payment, pickup, selling, seller_fees, payouts, storefront, account.',
    input_schema: { type: 'object', properties: { topic: { type: 'string', enum: [...platformFacts.TOPIC_NAMES, 'all'] } }, required: ['topic'] } },
  { name: 'get_auction_or_lot', description: 'Public facts about one auction or lot: title, city/state, status, dates, pickup window, the exact buyer\'s premium, shipping availability; for a lot also the current bid, next minimum bid and closing time. Accepts an auction id, lot id, or a title search.',
    input_schema: { type: 'object', properties: { auction_id: { type: 'string' }, lot_id: { type: 'string' }, search: { type: 'string', description: 'Auction title words, if no id is known' }, lot_number: { type: 'string', description: 'Lot number within the auction, if known' } } } },
  { name: 'request_human', description: 'Hand this conversation to an Advantage.Bid team member. Use ONLY for genuine exceptions: the customer asks for a person, disputes needing judgment, legal matters, privacy requests, security incidents, suspected fraud, changes to money/accounts you cannot make, or a material fact you cannot verify. Tell the customer a team member will follow up.',
    input_schema: { type: 'object', properties: { reason: { type: 'string', enum: HANDOFF_REASONS }, summary: { type: 'string', description: 'One or two sentences for the team: what the customer needs and why a person is required' } }, required: ['reason', 'summary'] } },
];
const noArgs = { type: 'object', properties: {} };
const ACCOUNT_TOOLS = [
  { name: 'get_my_account', description: 'The signed-in customer\'s own account: name, role, whether a card is on file (brand/last 4), buyer terms accepted, seller type.', input_schema: noArgs },
  { name: 'get_my_bids', description: 'The signed-in buyer\'s recent bids: lots, their bid, whether they are winning, current price, closing time, and lots won.', input_schema: noArgs },
  { name: 'get_my_invoices', description: 'The signed-in buyer\'s auction invoices: number, auction, total, status (paid, payment required, refunded…).', input_schema: noArgs },
  { name: 'get_my_pickup_details', description: 'Pickup address and window for an auction where the signed-in buyer has PAID for what they won. Returns nothing before payment.',
    input_schema: { type: 'object', properties: { auction_id: { type: 'string' } } } },
  { name: 'get_my_orders', description: 'The signed-in buyer\'s storefront (fixed-price) orders.', input_schema: noArgs },
  { name: 'get_my_auctions', description: 'The signed-in seller\'s own auctions: status, dates, lot counts.', input_schema: noArgs },
  { name: 'get_my_settlements', description: 'The signed-in seller\'s settlements/payouts: status, amounts, paid date.', input_schema: noArgs },
  { name: 'get_my_seller_terms', description: 'The signed-in seller\'s OWN fee terms (platform fee, processing fee, buyer premium setting).', input_schema: noArgs },
  { name: 'get_my_storefront_orders', description: 'The signed-in seller\'s storefront orders to fulfil.', input_schema: noArgs },
];

/**
 * Tools available in this context. Email and anonymous chat get knowledge tools only. A phone call adds the phone
 * flow tools (verification, callback, spoken auction search) and, only inside a verified phone session, the account
 * tools plus the phone-only account tools (phone/phoneTools.js). Web chat and email are unchanged.
 */
function toolsFor(ctx) {
  if (ctx && ctx.channel === 'phone') {
    const phone = require('./phone/phoneTools');
    return [...KNOWLEDGE_TOOLS, ...phone.toolsFor(ctx), ...(ctx.userId ? ACCOUNT_TOOLS : [])];
  }
  return ctx && ctx.userId ? [...KNOWLEDGE_TOOLS, ...ACCOUNT_TOOLS] : KNOWLEDGE_TOOLS;
}

// ── Knowledge ──────────────────────────────────────────────────────────────────────────────────────────
async function searchHelpCenter({ query }) {
  const pages = helpIndex.search(query, 4);
  const q = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 8);
  let guidance = [];
  if (q.length) {
    const { rows } = await db.query(
      `SELECT slug, title, body, status, conflict_note FROM cs_kb_articles WHERE status IN ('approved','conflict')
         AND (${q.map((_, i) => `(lower(title) LIKE $${i + 1} OR lower(body) LIKE $${i + 1})`).join(' OR ')})
       ORDER BY (${q.map((_, i) => `(CASE WHEN lower(title) LIKE $${i + 1} THEN 2 WHEN lower(body) LIKE $${i + 1} THEN 1 ELSE 0 END)`).join(' + ')}) DESC LIMIT 4`,
      q.map((w) => '%' + w.replace(/[%_]/g, '') + '%'));
    guidance = rows.map((r) => r.status === 'conflict'
      ? { guidance: r.title, status: 'UNRESOLVED: follow only this interim guidance; state no figures that are not in it (help pages on this topic may be out of date); offer a team member if the customer needs the exact answer', text: r.body.slice(0, 1800) }
      : { guidance: r.title, text: r.body.slice(0, 1800) });
  }
  return { approved_guidance: guidance, help_pages: pages.map((p) => ({ page: p.url, section: p.heading, text: p.text })) };
}

// ── Public auction / lot facts (canonical visibility; city/state only) ──────────────────────────────────
async function getAuctionOrLot(args, ctx) {
  const billing = require('../billingTermsService');
  let auctionId = UUID.test(args.auction_id || '') ? args.auction_id : null;
  let lot = null;
  if (UUID.test(args.lot_id || '')) {
    lot = (await db.query(`SELECT id, auction_id, lot_number, lot_number_display, title, state, current_bid_cents, starting_bid_cents, bid_count,
      closes_at, shippable, bid_increment_cents FROM lots WHERE id = $1 AND is_withdrawn IS NOT TRUE`, [args.lot_id])).rows[0];
    if (lot) auctionId = lot.auction_id;
  }
  const visibleOrOwn = `(${activeNativeAuctionSql('a').replace("a.state IN ('published','active')", "a.state IN ('published','active','closed')")}
     OR sp.user_id = $2)`;
  let a;
  if (auctionId) {
    a = (await db.query(`SELECT a.* , sp.seller_type FROM auctions a LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
      WHERE a.id = $1 AND ${visibleOrOwn}`, [auctionId, ctx.userId || null])).rows[0];
  } else if (args.search) {
    const matches = (await db.query(`SELECT a.id, a.title, a.city, a.address_state, a.state, a.end_time FROM auctions a LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
      WHERE a.title ILIKE $1 AND ${visibleOrOwn} ORDER BY a.end_time DESC NULLS LAST LIMIT 5`, ['%' + String(args.search).slice(0, 80).replace(/[%_]/g, '') + '%', ctx.userId || null])).rows;
    if (matches.length !== 1) return { matches: matches.map((m) => ({ auction_id: m.id, title: m.title, location: [m.city, m.address_state].filter(Boolean).join(', '), status: m.state, ends: m.end_time })), note: matches.length ? 'Several auctions match; ask which one.' : 'No public auction matches that name.' };
    a = (await db.query(`SELECT a.*, sp.seller_type FROM auctions a LEFT JOIN seller_profiles sp ON sp.id = a.seller_id WHERE a.id = $1`, [matches[0].id])).rows[0];
  }
  if (!a) return { found: false, note: 'No public auction or lot found for that reference.' };
  if (!lot && args.lot_number) {
    lot = (await db.query(`SELECT id, lot_number, lot_number_display, title, state, current_bid_cents, starting_bid_cents, bid_count, closes_at, shippable, bid_increment_cents
      FROM lots WHERE auction_id = $1 AND (lot_number::text = $2 OR lot_number_display = $2) AND is_withdrawn IS NOT TRUE LIMIT 1`, [a.id, String(args.lot_number).trim()])).rows[0];
  }
  let terms = null; try { terms = await billing.resolveEffectiveTerms(a.id); } catch (_e) { terms = null; }
  const out = {
    auction: { auction_id: a.id, title: a.title, location: [a.city, a.address_state].filter(Boolean).join(', '), status: a.state,
      bidding_starts_or_started: a.start_time, closes_starting: a.end_time, pickup_window: a.pickup_window_start ? { from: a.pickup_window_start, to: a.pickup_window_end } : null,
      buyers_premium: terms ? bpsPct(terms.buyer_premium_bps) : 'shown on the auction page', shipping_available: !!a.shipping_available,
      page: `${SITE}/auction-view.html?auctionId=${a.id}` },
  };
  if (lot) {
    const bids = require('../bidService');
    let next = null;
    try {   // the same resolution bidding uses (lot → auction → ladder), so the number matches the lot page
      const override = await bids.resolveIncrementOverride(db, { ...lot, auction_id: a.id });
      next = bids.nextMinBidCents(lot.starting_bid_cents || 100, lot.current_bid_cents || 0, override);
    } catch (_e) { next = null; }
    out.lot = { lot_id: lot.id, lot_number: lot.lot_number_display || lot.lot_number, title: lot.title, status: lot.state, bids: lot.bid_count,
      current_bid: money(lot.current_bid_cents), starting_bid: money(lot.starting_bid_cents), next_minimum_bid: money(next), closes_at: lot.closes_at,
      shippable: !!lot.shippable, page: `${SITE}/lot.html?lotId=${lot.id}` };
  }
  return out;
}

// ── Signed-in customer: their own data only ─────────────────────────────────────────────────────────────
async function getMyAccount(_a, ctx) {
  const u = (await db.query(`SELECT id, full_name, email, role, is_active FROM users WHERE id = $1`, [ctx.userId])).rows[0];
  if (!u) return { error: 'account not found' };
  const sp = (await db.query(`SELECT seller_type, display_name, storefront_published FROM seller_profiles WHERE user_id = $1`, [ctx.userId])).rows[0];
  const card = (await db.query(`SELECT livemode FROM card_verifications WHERE user_id = $1 AND status = 'verified' AND livemode = true ORDER BY attempted_at DESC NULLS LAST LIMIT 1`, [ctx.userId])).rows[0];
  let terms = null; try { terms = await require('../termsService').hasAcceptedCurrentTerms(ctx.userId); } catch (_e) { terms = null; }
  return { name: u.full_name || null, email: u.email, role: u.role, active: u.is_active !== false, card_on_file: !!card, buyer_terms_accepted: terms,
    seller: sp ? { type: sp.seller_type, professional: PROFESSIONAL_SELLER_TYPES.includes(sp.seller_type), display_name: sp.display_name, storefront_published: !!sp.storefront_published } : null };
}

async function getMyBids(_a, ctx) {
  const { rows } = await db.query(
    `SELECT l.id lot_id, l.title, l.lot_number_display, l.lot_number, l.state, l.current_bid_cents, l.closes_at, l.current_winner_user_id,
            l.winning_buyer_user_id, a.title auction_title, a.id auction_id, max(b.amount_cents) my_top_bid, max(b.created_at) last_bid_at
       FROM bids b JOIN lots l ON l.id = b.lot_id JOIN auctions a ON a.id = l.auction_id
      WHERE b.bidder_user_id = $1 GROUP BY l.id, a.id ORDER BY max(b.created_at) DESC LIMIT 25`, [ctx.userId]);
  return { bids: rows.map((r) => ({ lot: `${r.title} (lot ${r.lot_number_display || r.lot_number})`, auction: r.auction_title, lot_status: r.state,
    my_top_bid: money(r.my_top_bid), current_price: money(r.current_bid_cents), closes_at: r.closes_at,
    standing: r.state === 'closed' ? (r.winning_buyer_user_id === ctx.userId ? 'won' : 'not won') : (r.current_winner_user_id === ctx.userId ? 'winning' : 'outbid'),
    page: `${SITE}/lot.html?lotId=${r.lot_id}` })), my_bids_page: `${SITE}/my-bids.html` };
}

async function getMyInvoices(_a, ctx) {
  const { rows } = await db.query(
    `SELECT b.invoice_number, b.status, b.hammer_cents, b.buyer_premium_cents, b.sales_tax_cents, b.shipping_cents, b.total_cents, b.paid_at, b.created_at,
            a.title auction_title, a.id auction_id
       FROM buyer_auction_invoices b JOIN auctions a ON a.id = b.auction_id WHERE b.buyer_user_id = $1 ORDER BY b.created_at DESC LIMIT 20`, [ctx.userId]);
  const label = { paid: 'paid', payment_required: 'payment required (you can pay it on the invoices page)', issued: 'issued (card charge pending)', void: 'void', refunded: 'refunded', partially_refunded: 'partially refunded' };
  return { invoices: rows.map((r) => ({ invoice: r.invoice_number, auction: r.auction_title, auction_id: r.auction_id, status: label[r.status] || r.status,
    winning_bids: money(r.hammer_cents), buyers_premium: money(r.buyer_premium_cents), sales_tax: money(r.sales_tax_cents), shipping: money(r.shipping_cents),
    total: money(r.total_cents), paid_at: r.paid_at })), invoices_page: `${SITE}/invoices.html` };
}

async function getMyPickupDetails(args, ctx) {
  const params = [ctx.userId];
  let where = `b.buyer_user_id = $1 AND b.status = 'paid'`;
  if (UUID.test(args.auction_id || '')) { params.push(args.auction_id); where += ' AND b.auction_id = $2'; }
  const { rows } = await db.query(
    `SELECT a.id, a.title, a.street_address, a.city, a.address_state, a.zip, a.pickup_window_start, a.pickup_window_end, a.timezone
       FROM buyer_auction_invoices b JOIN auctions a ON a.id = b.auction_id WHERE ${where} ORDER BY b.paid_at DESC LIMIT 5`, params);
  if (!rows.length) return { pickups: [], note: 'No paid auction purchases found. The full pickup address is shared only after payment for what was won; before that only the city and state are shown.' };
  return { pickups: rows.map((r) => { const loc = saleLocation.fromAuction(r);
    return { auction: r.title, pickup_address: loc && loc.line1 ? `${loc.line1}, ${loc.city}, ${loc.state} ${loc.postal_code}` : 'not yet provided by the seller; a team member can help',
      pickup_window: r.pickup_window_start ? { from: r.pickup_window_start, to: r.pickup_window_end, timezone: r.timezone } : null }; }) };
}

async function getMyOrders(_a, ctx) {
  const orders = await require('../marketplaceOrderService').listForBuyer(ctx.userId);
  return { orders: orders.slice(0, 20).map((o) => ({ order: o.order_number, item: o.item_title, total: money(o.total_charge_cents), payment: o.payment_status,
    fulfillment: o.fulfillment_status, method: o.fulfillment_method, tracking: o.tracking_number ? `${o.tracking_carrier || ''} ${o.tracking_number}`.trim() : null, placed: o.created_at })) };
}

async function requireSeller(ctx) {
  const sp = (await db.query(`SELECT id, seller_type, platform_fee_bps, metadata FROM seller_profiles WHERE user_id = $1`, [ctx.userId])).rows[0];
  return sp || null;
}

async function getMyAuctions(_a, ctx) {
  if (!(await requireSeller(ctx))) return { note: 'This account has no seller profile.' };
  const { rows } = await db.query(
    `SELECT a.id, a.title, a.state, a.start_time, a.end_time, a.city, a.address_state, (SELECT count(*)::int FROM lots l WHERE l.auction_id = a.id AND l.is_withdrawn IS NOT TRUE) lots
       FROM auctions a JOIN seller_profiles sp ON sp.id = a.seller_id WHERE sp.user_id = $1 AND a.is_archived IS NOT TRUE ORDER BY a.created_at DESC LIMIT 20`, [ctx.userId]);
  return { auctions: rows.map((r) => ({ auction_id: r.id, title: r.title, status: r.state, lots: r.lots, starts: r.start_time, ends: r.end_time,
    location: [r.city, r.address_state].filter(Boolean).join(', ') })), seller_dashboard: `${SITE}/seller-dashboard.html` };
}

async function getMySettlements(_a, ctx) {
  // The seller-safe serializers (sellerSettlementView) — no admin notes, banking data or internal workflow states.
  const r = await require('../sellerSettlementService').listSettlements(ctx.userId);
  return { summary: r && r.summary, settlements: ((r && r.settlements) || []).slice(0, 20), page: `${SITE}/seller-settlements.html` };
}

async function getMySellerTerms(_a, ctx) {
  const sp = await requireSeller(ctx);
  if (!sp) return { note: 'This account has no seller profile.' };
  const pro = PROFESSIONAL_SELLER_TYPES.includes(sp.seller_type);
  const billing = require('../billingTermsService');
  let agreement = null;
  try {
    agreement = (await db.query(`SELECT platform_fee_bps, processing_fee_bps, effective_date FROM professional_pricing_agreements pa
      JOIN seller_profiles s ON s.id = pa.seller_profile_id WHERE s.user_id = $1 AND pa.status = 'accepted' ORDER BY pa.effective_date DESC NULLS LAST LIMIT 1`, [ctx.userId])).rows[0] || null;
  } catch (_e) { agreement = null; }
  if (!pro) return { seller_type: sp.seller_type, platform_fee: '0%', processing_fee: bpsPct(billing.DEFAULT_PROCESSING_FEE_BPS) + ' of the hammer price', buyers_premium: bpsPct(billing.DEFAULT_BUYER_PREMIUM_BPS) + ' (fixed for individual sellers)' };
  const fee = agreement ? agreement.platform_fee_bps : (sp.platform_fee_bps != null ? sp.platform_fee_bps : null);
  // Auction Partner Program (introductory 0% platform fee applied): processing is the actual card-processing charges.
  let partner = null;
  try {
    partner = (await db.query(`SELECT fp.intro_platform_fee_bps FROM founding_partners fp JOIN seller_profiles s ON s.id = fp.seller_profile_id
      WHERE s.user_id = $1 AND fp.status = 'active' AND fp.fee_applied_at IS NOT NULL AND fp.fee_restored_at IS NULL LIMIT 1`, [ctx.userId])).rows[0] || null;
  } catch (_e) { partner = null; }
  if (partner && Number(partner.intro_platform_fee_bps) === 0) {
    return { seller_type: sp.seller_type, program: 'Auction Partner Program',
      platform_fee: '0% Advantage.Bid auction platform/software fee on auctions published under the program (each auction keeps the terms it was published with)',
      processing_fee: 'the actual card-processing charges on your buyers\' payments for that auction, deducted from your proceeds at cost with no markup',
      buyers_premium: 'you set it per auction (0–25%) and keep it', taxes: 'sales tax is collected and remitted separately and is not part of your proceeds',
      payouts: 'Advantage.Bid processes eligible seller payouts every Thursday',
      storefront_fee: `${require('../marketplaceOrderService').STOREFRONT_FEE_BPS / 100}% of the item price on Storefront fixed-price sales (includes card processing; shipping and tax excluded), separate from your auction fees` };
  }
  return { seller_type: sp.seller_type, platform_fee: fee != null ? bpsPct(fee) + ' of the hammer price (your current rate; each auction keeps the rate it was published with)' : 'set in your Professional Seller agreement; a team member can confirm it',
    processing_fee: bpsPct(agreement ? agreement.processing_fee_bps : billing.DEFAULT_PROCESSING_FEE_BPS) + ' of the hammer price',
    buyers_premium: 'you set it per auction (0–25%) and keep it', agreement_page: `${SITE}/pricing-agreement.html`,
    storefront_fee: `${require('../marketplaceOrderService').STOREFRONT_FEE_BPS / 100}% of the item price on Storefront fixed-price sales (includes card processing; shipping and tax excluded), separate from your auction fees` };
}

async function getMyStorefrontOrders(_a, ctx) {
  if (!(await requireSeller(ctx))) return { note: 'This account has no seller profile.' };
  const orders = await require('../marketplaceOrderService').listForSeller(ctx.userId);
  return { orders: orders.slice(0, 20).map((o) => ({ order: o.order_number, item: o.item_title, buyer: o.buyer_name || 'buyer', payment: o.payment_status,
    fulfillment: o.fulfillment_status, method: o.fulfillment_method, placed: o.created_at })), page: `${SITE}/seller-orders.html` };
}

const EXEC = {
  search_help_center: searchHelpCenter, get_platform_rules: async ({ topic }) => platformFacts.getCurrentFacts(topic), get_auction_or_lot: getAuctionOrLot,
  get_my_account: getMyAccount, get_my_bids: getMyBids, get_my_invoices: getMyInvoices, get_my_pickup_details: getMyPickupDetails,
  get_my_orders: getMyOrders, get_my_auctions: getMyAuctions, get_my_settlements: getMySettlements, get_my_seller_terms: getMySellerTerms,
  get_my_storefront_orders: getMyStorefrontOrders,
};
const ACCOUNT_TOOL_NAMES = new Set(ACCOUNT_TOOLS.map((t) => t.name));

/** Run one tool. Account tools refuse without an authenticated user (defence in depth — they are not even offered). */
async function run(name, input, ctx) {
  if (name === 'request_human') return { handoff: true };   // handled by the engine
  if (ctx && ctx.channel === 'phone') return runPhone(name, input, ctx);
  const fn = EXEC[name];
  if (!fn) return { error: 'unknown tool' };
  if (ACCOUNT_TOOL_NAMES.has(name) && !(ctx && ctx.userId)) return { error: 'Not available: the customer is not signed in. Ask them to sign in to Advantage.Bid and use the chat, or use their account pages.' };
  try { return await fn(input || {}, ctx || {}); } catch (e) { return { error: 'lookup failed' }; }
}

/**
 * Phone: phone-only tools run in phone/phoneTools.js; existing account tools run unchanged here, then every account
 * read is written to the disclosure audit (which call, which verified session, which account, what category).
 */
async function runPhone(name, input, ctx) {
  const phone = require('./phone/phoneTools');
  const own = await phone.run(name, input, ctx);
  if (own !== null) {
    if (phone.VERIFIED_NAMES.has(name) && ctx.userId && name !== 'send_text' && name !== 'send_payment_link') await auditPhoneRead(name, own, ctx);
    return own;
  }
  const fn = EXEC[name];
  if (!fn) return { error: 'unknown tool' };
  if (ACCOUNT_TOOL_NAMES.has(name)) {
    if (!ctx.userId) {
      await require('./phone/phoneAudit').record(ctx.phone.call, 'tool_refused', { tool: name, category: phone.CATEGORY[name] || null, detail: { reason: 'caller not verified' } });
      return { error: 'Not available: the caller is not verified. Use start_account_verification first.' };
    }
    let out; try { out = await fn(input || {}, ctx); } catch (e) { out = { error: 'lookup failed' }; }
    await auditPhoneRead(name, out, ctx);
    return out;
  }
  try { return await fn(input || {}, ctx); } catch (e) { return { error: 'lookup failed' }; }
}
async function auditPhoneRead(name, out, ctx) {
  const phone = require('./phone/phoneTools');
  const shape = phone.auditShape(name, out);
  await require('./phone/phoneAudit').record(ctx.phone.call, shape.event, { tool: name, category: phone.CATEGORY[name] || null,
    accountUserId: ctx.userId, sessionId: ctx.phone.sessionId || null, detail: shape.detail });
}

module.exports = { toolsFor, run, KNOWLEDGE_TOOLS, ACCOUNT_TOOLS, HANDOFF_REASONS, _internal: { getAuctionOrLot, getMyPickupDetails, searchHelpCenter } };
