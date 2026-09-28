#!/usr/bin/env node
/* accept-live-readiness.js — Stripe TEST-mode END-TO-END payment acceptance for Advantage.Bid.
 *
 *   railway run node scripts/accept-live-readiness.js [--storefront | --auction | --all]
 *                                                     [--include-dispute] [--tax=auto|on|off]
 *
 * Drives the REAL service entry points (no re-implemented business logic) against the connected database,
 * using ONLY demo rows (is_demo = true) and Stripe TEST keys. Every scenario prints PASS / FAIL / SKIP with its
 * key figures (cents); a summary table is printed at the end and the exit code is non-zero if any scenario FAILs.
 *
 * Flags
 *   --storefront        Professional Storefront "Buy Now" scenarios S1–S9 only.
 *   --auction           Auction combined-invoice scenarios A–G only.
 *   --all (default)     Both.
 *   --include-dispute   Also run auction scenario E (dispute). OFF by default because the TEST webhook endpoint
 *                       points at the production app: the dispute created by pm_card_createDispute is delivered
 *                       to production too, and the production server's dispute handler sends a REAL owner SMS
 *                       ("Payment dispute opened") if it processes the event before this script does. This
 *                       script cannot stub the production server, so E is opt-in.
 *   --tax=auto          (default) Keep the server's STRIPE_TAX_ENABLED setting if a TEST-mode tax calculation
 *                       works; otherwise force tax OFF for THIS process only and say so.
 *   --tax=on|off        Force tax on/off for THIS process only.
 *
 * Optional environment
 *   ACCEPT_ADMIN_USER_ID    Admin user id recorded as the actor for the auction refund (scenario D). If unset, an
 *                           is_demo admin is used; if none exists, D is SKIPPED (processRefund is admin-only).
 *   ACCEPT_BUYER_USER_ID    Force a specific is_demo buyer.
 *   ACCEPT_WEBHOOK_WAIT_MS  How long cleanup waits for production to finish processing the TEST webhooks for
 *                           the objects this run created before deleting rows (default 45000).
 *
 * HARD SAFETY RULES (enforced in code, fail closed):
 *   - Refuses to run unless STRIPE_SECRET_KEY is sk_test_… AND STRIPE_PUBLISHABLE_KEY is pk_test_….
 *   - Only is_demo users / seller profiles / marketplace items / auctions are used; a non-demo target is refused.
 *     The demo auction must NOT be closed (a closed auction with combined invoices is picked up by the seller
 *     closeout worker on the production server).
 *   - Outbound email, SMS, owner alerts and ad-platform conversion events are stubbed in require.cache BEFORE any
 *     application module is loaded. Captured email SUBJECTS (never bodies) are printed at the end.
 *   - Only Stripe TEST PaymentMethods are used (pm_card_visa, pm_card_visa_debit, pm_card_mastercard_prepaid,
 *     pm_card_chargeDeclined, pm_card_authenticationRequired, pm_card_createDispute; pm_card_chargeCustomerFail
 *     only as a fallback when the TEST network refuses to SAVE pm_card_chargeDeclined as a card on file).
 *   - Never calls settlement Mark Paid / Pay Seller, never creates transfers or payouts.
 *   - Every row this script creates is recorded by id and deleted in a finally block; demo rows it changes are
 *     snapshotted and restored; open PaymentIntents / SetupIntents are canceled. Audit rows remain by design.
 */
'use strict';

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 0. SAFETY GATE — before anything else is loaded.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const SK = String(process.env.STRIPE_SECRET_KEY || '');
const PK = String(process.env.STRIPE_PUBLISHABLE_KEY || '');
if (!SK.startsWith('sk_test_') || !PK.startsWith('pk_test_')) {
  console.error('REFUSE: Stripe is not in TEST mode (need STRIPE_SECRET_KEY=sk_test_… AND STRIPE_PUBLISHABLE_KEY=pk_test_…).');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('REFUSE: DATABASE_URL is not set (run through `railway run`).');
  process.exit(2);
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const RUN_STOREFRONT = has('--storefront') || has('--all') || (!has('--storefront') && !has('--auction'));
const RUN_AUCTION = has('--auction') || has('--all') || (!has('--storefront') && !has('--auction'));
const INCLUDE_DISPUTE = has('--include-dispute');
const TAX_MODE = ((args.find((a) => a.startsWith('--tax=')) || '--tax=auto').split('=')[1] || 'auto').toLowerCase();
if (!['auto', 'on', 'off'].includes(TAX_MODE)) { console.error('Unknown --tax mode (use auto|on|off).'); process.exit(2); }
const WEBHOOK_WAIT_MS = Math.max(0, parseInt(process.env.ACCEPT_WEBHOOK_WAIT_MS || '45000', 10) || 45000);

// Marketplace checkout is gated server-side; enable it for THIS process only (never the running server).
process.env.MARKETPLACE_CHECKOUT_ENABLED = 'true';
if (TAX_MODE === 'off') process.env.STRIPE_TAX_ENABLED = 'false';
if (TAX_MODE === 'on') process.env.STRIPE_TAX_ENABLED = 'true';

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. OUTBOUND STUBS — installed in require.cache BEFORE any application module is required, so every
//    service that destructures sendEmail / sendSMS at load time receives the capturing stub.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const path = require('path');
const Module = require('module');
const SRC = path.join(__dirname, '..', 'src');
const captured = { emails: [], sms: [], ownerAlerts: [], conversions: [] };

function installStub(relPath, exportsObj) {
  const file = require.resolve(path.join(SRC, relPath));
  const m = new Module(file, module);
  m.filename = file;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[file] = m;
  return file;
}

// Transactional email (SES). Captures {to, subject}; nothing is sent.
installStub('services/emailService', {
  sendEmail: async ({ to, subject } = {}) => { captured.emails.push({ to: String(to || ''), subject: String(subject || ''), at: Date.now() }); return { messageId: 'captured', sesMessageId: null }; },
  isConfigured: () => true,
  EMAIL_FROM: 'captured@acceptance.invalid',
  marketingConfigurationSet: () => null,
  eventPartnerConfigurationSet: () => null,
  claimedListingConfigurationSet: () => null,
  configurationSetForStream: () => null,
});
// Twilio SMS. Captures the recipient's last 4 digits only; nothing is sent.
installStub('services/smsService', {
  sendSMS: async ({ to } = {}) => { captured.sms.push({ to: '…' + String(to || '').slice(-4), at: Date.now() }); return { sid: 'captured', status: 'captured' }; },
  isConfigured: () => true,
  twilioConfig: () => ({}),
});
// First-party conversion ledger → Meta CAPI / Google conversions. A demo "purchase" must never reach an ad
// platform, so the whole module (and the two senders, belt and braces) is replaced.
const asyncNoop = (label) => async (...a) => { captured.conversions.push({ label, key: a[0] }); return { captured: true }; };
installStub('services/conversionService', {
  record: asyncNoop('record'),
  emit: (key) => { captured.conversions.push({ label: 'emit', key }); },
  dispatchDecisions: asyncNoop('dispatchDecisions'),
  ctxFromReq: () => ({}),
  readCookie: () => null,
  sendMeta: asyncNoop('sendMeta'),
  isInternal: () => true,
});
const proxyStub = (label) => new Proxy({}, { get: (_t, k) => (k === '__esModule' ? false : asyncNoop(label + '.' + String(k))) });
try { installStub('services/measurement/metaCapiService', proxyStub('metaCapi')); } catch (_) { /* module absent */ }
try { installStub('services/measurement/googleConversionsService', proxyStub('googleConversions')); } catch (_) { /* module absent */ }

// Owner alerts: load the real module (its SMS transport is already stubbed) and replace every notify*/send*
// entry point with a capture, so no owner_alert_log dedup rows are written either. disputeService requires
// this module lazily and calls oa.notifyAdminActionRequired through the exports object → captured.
const ownerAlertService = require(path.join(SRC, 'services/ownerAlertService'));
for (const k of Object.keys(ownerAlertService)) {
  if (typeof ownerAlertService[k] === 'function' && /^(notify|send)/.test(k)) {
    ownerAlertService[k] = async (arg) => {
      captured.ownerAlerts.push({ fn: k, actionType: arg && arg.actionType, headline: arg && arg.headline, entityId: arg && arg.entityId });
      return { captured: true, sent: 0 };
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. APPLICATION SERVICES (loaded only after the stubs).
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const Stripe = require('stripe');
const db = require(path.join(SRC, 'db'));
const { isLiveMode } = require(path.join(SRC, 'lib/stripeMode'));
const taxService = require(path.join(SRC, 'services/taxCalculationService'));
const billingTerms = require(path.join(SRC, 'services/billingTermsService'));
const mos = require(path.join(SRC, 'services/marketplaceOrderService'));
const paymentService = require(path.join(SRC, 'services/paymentService'));
const combinedInvoiceService = require(path.join(SRC, 'services/combinedInvoiceService'));
const combinedReceiptService = require(path.join(SRC, 'services/combinedReceiptService'));
const cardService = require(path.join(SRC, 'services/cardService'));
const disputeService = require(path.join(SRC, 'services/disputeService'));
const settlementEngine = require(path.join(SRC, 'services/settlementEngine'));

if (isLiveMode()) { console.error('REFUSE: stripeMode reports LIVE.'); process.exit(2); }
const stripe = Stripe(SK, { apiVersion: '2026-03-25.dahlia' });

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. CONSTANTS + HELPERS
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const DEMO_ITEM_PREFERRED = '00000000-0000-4000-a000-0000000d0009';
const DEMO_AUCTION_PREFERRED = '00000000-0000-4000-a000-0000000d0003';
const DEMO_BUYER_EMAIL_PREFERRED = 'demo-buyer@advantage.bid';
// Synthetic hammer prices for the combined invoice (two lines so per-lot premium rounding is exercised).
const SYNTHETIC_HAMMERS = [12550, 4050];
// Jurisdiction address used ONLY when tax is on and the demo buyer has no tax address (restored afterwards).
// TEST-ONLY addresses. The sandbox has one registration (MI), so a taxed run needs a location there; these are
// acceptance fixtures, never a platform default (the sale location comes from src/lib/saleLocation.js).
const TEST_TAX_ADDRESS = { line1: '2205 Ogden Hwy', city: 'Adrian', state: 'MI', postal_code: '49221', country: 'US' };
// Temporary pickup location put on the DEMO storefront item for the run (restored afterwards).
const TEST_ITEM_PICKUP = { pickup_address_line1: '100 E Maumee St', pickup_address_line2: null, pickup_city: 'Adrian',
  pickup_state: 'MI', pickup_postal_code: '49221', pickup_country: 'US' };
const RUN_ID = Date.now().toString(36);
const RUN_START_SEC = Math.floor(Date.now() / 1000) - 5;

const q = (sql, p) => db.query(sql, p);
const money = (c) => (c == null ? 'n/a' : (Number(c) < 0 ? '-' : '') + '$' + (Math.abs(Number(c)) / 100).toFixed(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (k, v) => console.log('    ' + String(k).padEnd(34) + ' ' + (v === undefined ? '' : v));
const roundHalfUp = (n) => Math.floor(Number(n || 0) + 0.5);
async function waitFor(fn, timeoutMs = 15000, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(stepMs);
  }
}
const emailsSince = (idx) => captured.emails.slice(idx);
const taxOn = () => taxService.taxEnabled();
const setTax = (on) => { process.env.STRIPE_TAX_ENABLED = on ? 'true' : 'false'; };

// ── Result registry ─────────────────────────────────────────────────────────────────────────────────
const results = [];
function record(id, name, pass, figures = {}, note = '') {
  const status = pass ? 'PASS' : 'FAIL';
  results.push({ id, name, status, figures, note });
  console.log(`\n  [${status}] ${id} ${name}`);
  for (const [k, v] of Object.entries(figures)) log(k, v);
  if (note) log('note', note);
}
function skip(id, name, reason) {
  results.push({ id, name, status: 'SKIP', figures: {}, note: reason });
  console.log(`\n  [SKIP] ${id} ${name}\n    reason: ${reason}`);
}
function fail(id, name, e, figures = {}) {
  record(id, name, false, figures, 'error: ' + (e && (e.code ? e.code + ' — ' : '') + (e.message || e)));
}
const notes = [];
const cleanupLog = [];

// ── Webhook settling ────────────────────────────────────────────────────────────────────────────────
// The TEST webhook endpoint points at the PRODUCTION app, so every intent/charge/dispute this run creates is
// ALSO processed there. Before deleting rows we wait until production has finished processing those events
// (stripe_webhook_events.status leaves 'received'), otherwise a late delivery would find no row, fail, and be
// retried by the provider for days. Best-effort: on timeout we log what is still outstanding and continue.
const WEBHOOK_TYPES = ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled',
  'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed'];
async function relevantEvents(objectIds) {
  const out = [];
  const iter = stripe.events.list({ created: { gte: RUN_START_SEC }, types: WEBHOOK_TYPES, limit: 100 });
  let n = 0;
  for await (const ev of iter) {
    if (++n > 1000) break;
    const o = (ev.data && ev.data.object) || {};
    const pi = o.payment_intent && (o.payment_intent.id || o.payment_intent);
    const ch = o.charge && (o.charge.id || o.charge);
    if (objectIds.has(o.id) || (pi && objectIds.has(pi)) || (ch && objectIds.has(ch))) out.push(ev);
  }
  return out;
}
async function settleWebhooks(objectIds, label) {
  if (!objectIds || !objectIds.size || !WEBHOOK_WAIT_MS) return;
  const deadline = Date.now() + WEBHOOK_WAIT_MS;
  let pending = [];
  try {
    for (;;) {
      const evs = await relevantEvents(objectIds);
      const ids = evs.map((e) => e.id);
      const rows = ids.length ? (await q('SELECT id, status FROM stripe_webhook_events WHERE id = ANY($1)', [ids])).rows : [];
      const byId = new Map(rows.map((r) => [r.id, r.status]));
      pending = evs.filter((e) => !byId.has(e.id) || byId.get(e.id) === 'received');
      if (!pending.length) { cleanupLog.push(`${label}: ${evs.length} production webhook event(s) settled`); return; }
      if (Date.now() > deadline) break;
      await sleep(3000);
    }
    const msg = `${label}: ${pending.length} webhook event(s) not yet processed by production after ${WEBHOOK_WAIT_MS}ms: `
      + pending.map((e) => e.type + ' ' + e.id).join(', ');
    cleanupLog.push(msg); notes.push(msg);
  } catch (e) {
    cleanupLog.push(`${label}: webhook settle check failed (${e.message}) — continuing`);
  }
}

// Cancel a PaymentIntent unless it has money in flight. Returns the final status.
async function cancelIfOpen(intentId) {
  try {
    const pi = await stripe.paymentIntents.retrieve(intentId);
    if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
      const c = await stripe.paymentIntents.cancel(intentId);
      return c.status;
    }
    return pi.status;
  } catch (e) { return 'error:' + e.message; }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. DISCOVERY (demo rows only)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const USER_SNAPSHOT_COLS = 'id, email, role, is_demo, stripe_customer_id, stripe_customer_livemode, superseded_stripe_customer_id, '
  + 'tax_address_line1, tax_address_line2, tax_city, tax_state, tax_postal_code, tax_country';

async function discoverBuyers() {
  if (process.env.ACCEPT_BUYER_USER_ID) {
    const u = (await q(`SELECT ${USER_SNAPSHOT_COLS} FROM users WHERE id = $1`, [process.env.ACCEPT_BUYER_USER_ID])).rows[0];
    if (!u) throw new Error('ACCEPT_BUYER_USER_ID not found');
    if (u.is_demo !== true) { console.error('REFUSE: ACCEPT_BUYER_USER_ID is not is_demo.'); process.exit(2); }
    return [u];
  }
  return (await q(
    `SELECT ${USER_SNAPSHOT_COLS} FROM users
      WHERE is_demo = true AND role = 'buyer'
      ORDER BY (lower(email) = $1) DESC, id
      LIMIT 20`, [DEMO_BUYER_EMAIL_PREFERRED])).rows;
}

async function discoverItem(buyerIds) {
  const r = (await q(
    `SELECT mi.id, mi.title, mi.status, mi.price_cents, mi.is_demo, mi.pending_order_id, mi.pending_expires_at,
            mi.seller_id, sp.user_id AS seller_user_id, sp.seller_type, sp.is_demo AS seller_is_demo
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.is_demo = true AND sp.is_demo = true AND mi.status = 'active' AND mi.price_cents > 0 AND mi.shippable = true
      ORDER BY (mi.id = $1) DESC, mi.created_at
      LIMIT 20`, [DEMO_ITEM_PREFERRED])).rows;
  return r.find((it) => billingTerms.isProfessional(it.seller_type) && !buyerIds.includes(it.seller_user_id)) || null;
}

async function discoverAuction() {
  return (await q(
    `SELECT a.id, a.title, a.state, a.is_demo, a.seller_id, sp.user_id AS seller_user_id, sp.seller_type,
            sp.is_demo AS seller_is_demo
       FROM auctions a LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
      WHERE a.id = $1`, [process.env.ACCEPT_AUCTION_ID || DEMO_AUCTION_PREFERRED])).rows[0] || null;
}

async function discoverAdmin() {
  if (process.env.ACCEPT_ADMIN_USER_ID) {
    const u = (await q(`SELECT id, email, role FROM users WHERE id = $1`, [process.env.ACCEPT_ADMIN_USER_ID])).rows[0];
    return u && u.role === 'admin' ? { id: u.id, source: 'ACCEPT_ADMIN_USER_ID' } : null;
  }
  const u = (await q(`SELECT id FROM users WHERE is_demo = true AND role = 'admin' ORDER BY id LIMIT 1`)).rows[0];
  return u ? { id: u.id, source: 'is_demo admin' } : null;
}

// Tax viability probe (auto mode): one TEST-mode Stripe Tax calculation. Failure → tax forced OFF in-process.
async function resolveTaxMode(buyerId) {
  if (TAX_MODE !== 'auto') { notes.push(`Tax mode forced ${TAX_MODE.toUpperCase()} for this process (--tax=${TAX_MODE}).`); return; }
  if (!taxOn()) { notes.push('STRIPE_TAX_ENABLED is not true in this environment — tax paths run as $0 (flag off).'); return; }
  try {
    const t = await taxService.computeTax({ buyerUserId: buyerId, taxableBaseCents: 1000, address: TEST_TAX_ADDRESS, reference: 'acceptance-probe:' + RUN_ID });
    notes.push(`Tax ON: TEST-mode Stripe Tax probe OK (tax on $10.00 in Adrian MI = ${money(t.taxCents)}).`);
  } catch (e) {
    setTax(false);
    notes.push(`Tax FORCED OFF for this process: TEST-mode Stripe Tax calculation failed (${e.code || e.message}). Tax recording/reversal paths were NOT exercised.`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 5. STOREFRONT SCENARIOS (S1–S9)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
async function runStorefront(buyer, item) {
  console.log('\n=== STOREFRONT (Professional Storefront Buy Now) ===');
  log('demo item', `${item.title} (${item.id}) ${money(item.price_cents)}`);
  log('demo seller', `${item.seller_id} (${item.seller_type})`);
  log('demo buyer', `${buyer.email} (${buyer.id})`);

  const created = { orders: [], intents: new Set() };
  const itemSnap = { status: item.status, pending_order_id: item.pending_order_id, pending_expires_at: item.pending_expires_at };
  // The sale location is the item's pickup location: give the demo item a TEST one for this run (restored in cleanup).
  const pickupSnap = (await q(`SELECT pickup_address_line1, pickup_address_line2, pickup_city, pickup_state, pickup_postal_code,
                                      pickup_country, pickup_location_source FROM marketplace_items WHERE id = $1`, [item.id])).rows[0] || {};
  await q(`UPDATE marketplace_items SET pickup_address_line1 = $2, pickup_address_line2 = $3, pickup_city = $4, pickup_state = $5,
                  pickup_postal_code = $6, pickup_country = $7, pickup_location_source = 'seller' WHERE id = $1 AND is_demo = true`,
    [item.id, TEST_ITEM_PICKUP.pickup_address_line1, TEST_ITEM_PICKUP.pickup_address_line2, TEST_ITEM_PICKUP.pickup_city,
     TEST_ITEM_PICKUP.pickup_state, TEST_ITEM_PICKUP.pickup_postal_code, TEST_ITEM_PICKUP.pickup_country]);
  Object.assign(item, TEST_ITEM_PICKUP);
  const itemRow = async () => (await q('SELECT status, pending_order_id, pending_expires_at FROM marketplace_items WHERE id = $1', [item.id])).rows[0];
  const orderRow = async (id) => (await q('SELECT * FROM marketplace_orders WHERE id = $1', [id])).rows[0];
  const track = async (orderId) => {
    created.orders.push(orderId);
    const o = await orderRow(orderId);
    if (o && o.stripe_payment_intent_id) created.intents.add(o.stripe_payment_intent_id);
    return o;
  };
  const storefrontTaxWasOn = taxOn();
  let paidOrder = null, relisted = false;

  try {
    // ── S1 quote ──────────────────────────────────────────────────────────────────────────────────
    try {
      let quote;
      try {
        quote = await mos.quote(item.id, buyer.id, { fulfillment_method: 'shipping', ship_to: TEST_TAX_ADDRESS });
      } catch (e) {
        if (TAX_MODE === 'auto' && taxOn() && (e.code === 'PICKUP_TAX_ADDRESS_UNAVAILABLE' || e.name === 'TaxCalculationError')) {
          setTax(false);
          notes.push(`Storefront: tax forced OFF for storefront scenarios (${e.code}); the demo seller has no usable pickup tax address.`);
          quote = await mos.quote(item.id, buyer.id, { fulfillment_method: 'shipping', ship_to: TEST_TAX_ADDRESS });
        } else throw e;
      }
      const b = quote.breakdown;
      const feeExpected = roundHalfUp(b.item_price_cents * 1100 / 10000);
      const ok = b.item_price_cents === Number(item.price_cents) && b.platform_fee_bps === 1100
        && b.platform_fee_cents === feeExpected
        && b.seller_proceeds_cents === b.item_price_cents + b.shipping_cents - b.platform_fee_cents
        && b.total_charge_cents === b.item_price_cents + b.shipping_cents + b.tax_cents;
      record('S1', 'Quote: item, shipping, tax, 11% fee on item only, proceeds', ok, {
        item_price_cents: b.item_price_cents, shipping_cents: b.shipping_cents,
        tax_cents: b.tax_cents + (quote.tax_enabled ? '' : ' (tax flag off)'),
        platform_fee: `${b.platform_fee_cents} @ ${b.platform_fee_bps} bps (expected ${feeExpected})`,
        seller_proceeds_cents: b.seller_proceeds_cents, buyer_total_cents: b.total_charge_cents,
      });
    } catch (e) { fail('S1', 'Quote', e); }

    // ── Order #1 for S2–S4 ───────────────────────────────────────────────────────────────────────
    let o1 = null;
    try {
      const c1 = await mos.createOrder(item.id, buyer.id, { fulfillment_method: 'shipping', ship_to: TEST_TAX_ADDRESS });
      o1 = await track(c1.order.id);
    } catch (e) { fail('S2-4', 'Create order for card-policy checks', e); }

    // ── S2 prepaid refused ───────────────────────────────────────────────────────────────────────
    if (o1) {
      let err = null;
      try { await mos.payOrder(o1.id, buyer.id, { paymentMethodId: 'pm_card_mastercard_prepaid', idempotencyKey: RUN_ID + '-s2' }); }
      catch (e) { err = e; }
      const it = await itemRow();
      const held = it.status === 'pending_purchase' && it.pending_order_id === o1.id;
      record('S2', 'Prepaid card refused (422 PREPAID_NOT_ACCEPTED), item stays held', !!err && err.status === 422 && err.code === 'PREPAID_NOT_ACCEPTED' && held, {
        response: err ? `${err.status} ${err.code}` : 'NOT REFUSED', item_status: `${it.status} (held by this order: ${held})`,
      });
    } else skip('S2', 'Prepaid card refused', 'order could not be created');

    // ── S3 declined card → neutral decline, item not released ────────────────────────────────────
    if (o1) {
      let err = null;
      try { await mos.payOrder(o1.id, buyer.id, { paymentMethodId: 'pm_card_chargeDeclined', idempotencyKey: RUN_ID + '-s3' }); }
      catch (e) { err = e; }
      const it = await itemRow();
      const held = it.status === 'pending_purchase' && it.pending_order_id === o1.id;
      const neutral = !!err && /declined/i.test(err.message || '') && !/stripe/i.test(err.message || '');
      const orderNow = await orderRow(o1.id);
      record('S3', 'Declined card → neutral decline, item NOT released', !!err && err.status === 402 && err.code === 'CARD_DECLINED' && neutral && held && orderNow.payment_status === 'pending', {
        response: err ? `${err.status} ${err.code}: "${err.message}"` : 'NOT DECLINED',
        order_payment_status: orderNow.payment_status, item_status: `${it.status} (held by this order: ${held})`,
      });
    } else skip('S3', 'Declined card', 'order could not be created');

    // ── S4 3-D Secure card → requires_action ─────────────────────────────────────────────────────
    if (o1) {
      try {
        const r = await mos.payOrder(o1.id, buyer.id, { paymentMethodId: 'pm_card_authenticationRequired', idempotencyKey: RUN_ID + '-s4' });
        record('S4', '3-D Secure card → requires_action returned', r.status === 'requires_action' && !!r.client_secret, {
          status: r.status, client_secret_returned: !!r.client_secret,
        });
      } catch (e) { fail('S4', '3-D Secure card', e); }
      // Reset: retire order #1 through the service (cancels its intent first, then releases the item).
      const released = await mos.releaseOrder(o1.id, 'acceptance:reset_after_3ds', { cancelIntent: true });
      if (!released) notes.push('S4 reset: order #1 could not be released (see cleanup).');
    } else skip('S4', '3-D Secure card', 'order could not be created');

    // ── S5 credit card succeeds via server confirmation + intent-event handler ──────────────────
    try {
      const c2 = await mos.createOrder(item.id, buyer.id, { fulfillment_method: 'shipping', ship_to: TEST_TAX_ADDRESS });
      const o2 = await track(c2.order.id);
      const emailIdx = captured.emails.length;
      const r = await mos.payOrder(o2.id, buyer.id, { paymentMethodId: 'pm_card_visa', idempotencyKey: RUN_ID + '-s5' });
      const intent = await stripe.paymentIntents.retrieve(o2.stripe_payment_intent_id, { expand: ['latest_charge'] });
      // Webhook-equivalent: call the service's intent-event handler with the retrieved PaymentIntent (idempotent),
      // so the result does not depend on production's webhook timing.
      await mos.handleIntentEvent('payment_intent.succeeded', intent);
      await mos.handleIntentEvent('payment_intent.succeeded', intent); // second delivery must be a no-op
      const after = await orderRow(o2.id);
      const it = await itemRow();
      const liveOrders = (await q(`SELECT count(*)::int n FROM marketplace_orders WHERE marketplace_item_id = $1 AND payment_status IN ('pending','processing','paid')`, [item.id])).rows[0].n;
      const mails = emailsSince(emailIdx);
      const ok = r.status === 'succeeded' && intent.status === 'succeeded' && after.payment_status === 'paid'
        && it.status === 'sold' && liveOrders === 1 && !!after.stripe_charge_id;
      record('S5', 'Credit card → succeeded (server-confirmed), order paid, item sold', ok, {
        payOrder_status: r.status, intent_status: intent.status, amount_cents: intent.amount,
        order_payment_status: after.payment_status, tax_cents: after.tax_cents,
        stripe_tax_transaction_id: after.stripe_tax_transaction_id || '(none)', item_status: it.status,
        live_orders_for_item: liveOrders, emails_captured: mails.map((m) => m.subject).join(' | ') || '(none)',
      });
      if (ok) paidOrder = after;
    } catch (e) { fail('S5', 'Credit card payment', e); }

    // ── S6 fulfillment (shipping) → payout eligibility only ────────────────────────────────────────
    if (paidOrder) {
      try {
        const ready = await mos.updateFulfillment(paidOrder.id, item.seller_user_id, 'shipped', { tracking_carrier: 'TEST', tracking_number: 'ACCEPT-' + RUN_ID });
        const done = await mos.updateFulfillment(paidOrder.id, item.seller_user_id, 'complete');
        // "No money moved": the service only flips a flag; confirm no Stripe transfer references this charge.
        const transfers = await stripe.transfers.list({ limit: 10, created: { gte: RUN_START_SEC } });
        const related = transfers.data.filter((t) => t.source_transaction === paidOrder.stripe_charge_id);
        record('S6', 'Shipping fulfillment → payout_eligible, no money moved', ready.payout_eligible === false
          && done.fulfillment_status === 'completed' && done.payout_eligible === true && related.length === 0, {
          after_shipped: `${ready.fulfillment_status} · payout_eligible=${ready.payout_eligible}`,
          after_completed: `${done.fulfillment_status} · payout_eligible=${done.payout_eligible}`,
          transfers_for_charge: related.length,
        });
      } catch (e) { fail('S6', 'Fulfillment', e); }
    } else skip('S6', 'Fulfillment', 'S5 did not produce a paid order');

    // ── S7 full refund (+ tax reversal) → item removed → relist → active ─────────────────────────
    if (paidOrder) {
      try {
        const emailIdx = captured.emails.length;
        const refunded = await mos.refundOrder(paidOrder.id, { adminId: null });
        const row = await orderRow(paidOrder.id);
        const itAfter = await itemRow();
        const needsReversal = Number(row.tax_cents) > 0 && !!row.stripe_tax_transaction_id;
        const reversalOk = !needsReversal || !!row.stripe_tax_reversal_id;
        const re = await mos.relistItem(item.id, item.seller_user_id);
        relisted = re.status === 'active';
        record('S7', 'Full refund → refunded, tax reversal (if taxed), item removed, relist → active',
          refunded.refund_status === 'refunded' && refunded.payment_status === 'refunded' && refunded.payout_eligible === false
          && Number(refunded.refunded_amount_cents) === Number(row.total_charge_cents) && reversalOk
          && itAfter.status === 'removed' && relisted, {
            refunded_amount_cents: refunded.refunded_amount_cents, payment_status: refunded.payment_status,
            tax_cents: row.tax_cents, tax_reversal: needsReversal ? (row.stripe_tax_reversal_id || 'MISSING') : 'n/a (no tax recorded)',
            item_after_refund: itAfter.status, item_after_relist: re.status,
            emails_captured: emailsSince(emailIdx).map((m) => m.subject).join(' | ') || '(none)',
          });
      } catch (e) { fail('S7', 'Refund + relist', e); }
    } else skip('S7', 'Refund + relist', 'S5 did not produce a paid order');

    const itemActive = (await itemRow()).status === 'active';

    // ── S8 expired hold → sweeper releases item + cancels intent ─────────────────────────────────
    if (itemActive) {
      try {
        const c3 = await mos.createOrder(item.id, buyer.id, { fulfillment_method: 'shipping', ship_to: TEST_TAX_ADDRESS });
        const o3 = await track(c3.order.id);
        await q(`UPDATE marketplace_items SET pending_expires_at = now() - interval '1 minute'
                  WHERE id = $1 AND pending_order_id = $2 AND is_demo = true`, [item.id, o3.id]);
        // sweepExpiredHolds() scans EVERY expired hold. Use it only when no real (non-demo) hold is expired;
        // otherwise release just this demo hold through the same per-row function the sweeper uses.
        const realExpired = (await q(`SELECT count(*)::int n FROM marketplace_items
                                       WHERE status = 'pending_purchase' AND pending_expires_at < now() AND is_demo IS NOT TRUE`)).rows[0].n;
        let how;
        if (realExpired === 0) { const s = await mos.sweepExpiredHolds({ limit: 25 }); how = `sweepExpiredHolds ${JSON.stringify(s)}`; }
        else { const r = await mos.releaseExpiredHold({ item_id: item.id, order_id: o3.id, stripe_payment_intent_id: o3.stripe_payment_intent_id }); how = `releaseExpiredHold → ${r} (${realExpired} real expired hold(s) left to the server's sweeper)`; }
        const it = await itemRow();
        const ord = await orderRow(o3.id);
        const pi = await stripe.paymentIntents.retrieve(o3.stripe_payment_intent_id);
        record('S8', 'Expired hold → item released, PaymentIntent canceled', it.status === 'active' && ord.payment_status === 'failed' && pi.status === 'canceled', {
          sweep: how, item_status: it.status, order_payment_status: ord.payment_status, intent_status: pi.status,
        });
      } catch (e) { fail('S8', 'Expired hold sweep', e); }
    } else skip('S8', 'Expired hold sweep', 'demo item is not active (S7 relist did not complete)');

    // ── S9 conflict: order failed, then a succeeded intent → automatic conflict refund ──────────
    if ((await itemRow()).status === 'active') {
      try {
        const c4 = await mos.createOrder(item.id, buyer.id, { fulfillment_method: 'shipping', ship_to: TEST_TAX_ADDRESS });
        const o4 = await track(c4.order.id);
        await mos.releaseOrder(o4.id, 'acceptance:conflict_setup'); // order failed + item released; intent left open
        // The buyer's card is charged anyway (e.g. a late confirmation) — confirm the intent directly.
        await stripe.paymentIntents.confirm(o4.stripe_payment_intent_id, { payment_method: 'pm_card_visa' },
          { idempotencyKey: 'acceptance-conflict:' + o4.id });
        const intent = await stripe.paymentIntents.retrieve(o4.stripe_payment_intent_id, { expand: ['latest_charge'] });
        const emailIdx = captured.emails.length;
        const out = await mos.handleIntentEvent('payment_intent.succeeded', intent);
        const ord = await orderRow(o4.id);
        const it = await itemRow();
        const refunds = await stripe.refunds.list({ payment_intent: intent.id, limit: 5 });
        const refundedCents = refunds.data.reduce((s, r) => s + (r.status !== 'failed' && r.status !== 'canceled' ? r.amount : 0), 0);
        const alreadyByProd = !out; // production's webhook may have processed the conflict first (idempotent)
        record('S9', 'Conflict: failed order + succeeded intent → automatic refund, no crash',
          ord.payment_status === 'refunded' && String(ord.refund_reason || '').startsWith('conflict:')
          && refundedCents === intent.amount && it.status === 'active', {
            handler_result: out ? JSON.stringify(out) : '(no-op — already recorded, likely by the production webhook)',
            order_payment_status: ord.payment_status, refund_reason: ord.refund_reason,
            refunded_cents: `${refundedCents} of ${intent.amount}`, item_status_untouched: it.status,
            emails_captured: emailsSince(emailIdx).map((m) => m.subject).join(' | ') || '(none)',
          }, alreadyByProd ? 'Production processed the TEST webhook first; its conflict-refund email (if any) was sent by production, not captured here.' : '');
      } catch (e) { fail('S9', 'Conflict refund', e); }
    } else skip('S9', 'Conflict refund', 'demo item is not active');
  } finally {
    // ── Storefront cleanup ───────────────────────────────────────────────────────────────────────
    console.log('\n  [cleanup] storefront');
    for (const id of created.intents) { const st = await cancelIfOpen(id); cleanupLog.push(`storefront intent ${id} → ${st}`); }
    await settleWebhooks(created.intents, 'storefront');
    try {
      await q(`UPDATE marketplace_items SET status = $2, pending_order_id = $3, pending_expires_at = $4, updated_at = now()
                WHERE id = $1 AND is_demo = true`, [item.id, itemSnap.status, itemSnap.pending_order_id, itemSnap.pending_expires_at]);
      await q(`UPDATE marketplace_items SET pickup_address_line1 = $2, pickup_address_line2 = $3, pickup_city = $4, pickup_state = $5,
                      pickup_postal_code = $6, pickup_country = COALESCE($7, 'US'), pickup_location_source = $8 WHERE id = $1 AND is_demo = true`,
        [item.id, pickupSnap.pickup_address_line1 || null, pickupSnap.pickup_address_line2 || null, pickupSnap.pickup_city || null,
         pickupSnap.pickup_state || null, pickupSnap.pickup_postal_code || null, pickupSnap.pickup_country || null, pickupSnap.pickup_location_source || null]);
      cleanupLog.push(`storefront item ${item.id} restored to ${itemSnap.status} (pickup location restored)`);
    } catch (e) { cleanupLog.push('storefront item restore FAILED: ' + e.message); }
    if (created.orders.length) {
      try {
        const d = await q(`DELETE FROM marketplace_orders WHERE id = ANY($1::uuid[]) AND is_demo = true AND marketplace_item_id = $2`, [created.orders, item.id]);
        cleanupLog.push(`storefront orders deleted: ${d.rowCount}/${created.orders.length}`);
      } catch (e) { cleanupLog.push('storefront order delete FAILED: ' + e.message); }
    }
    setTax(storefrontTaxWasOn);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 6. AUCTION SCENARIOS (A–G)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
async function runAuction(buyer, auction, admin) {
  console.log('\n=== AUCTION (combined per-buyer invoice) ===');
  log('demo auction', `${auction.title} (${auction.id}) state=${auction.state}`);
  log('demo seller', `${auction.seller_id} (${auction.seller_type || 'untyped'})`);
  log('demo buyer', `${buyer.email} (${buyer.id})`);

  const A = {
    payments: new Set(), bai: new Set(), intents: new Set(), disputeRows: new Set(),
    cardVer: new Set(), pms: [], setupIntents: [],
    sellerPayoutCreated: null, sellerPayoutSnap: null,
    customerId: null, customerCreated: false, custDefaultPmBefore: null,
  };
  const preCardVer = new Set((await q('SELECT id FROM card_verifications WHERE user_id = $1', [buyer.id])).rows.map((r) => r.id));
  const prePayments = new Set((await q('SELECT id FROM payments WHERE auction_id = $1 AND buyer_user_id = $2', [auction.id, buyer.id])).rows.map((r) => r.id));
  const userSnap = buyer; // columns captured by discovery (USER_SNAPSHOT_COLS)

  const baiRow = async (id) => (await q('SELECT * FROM buyer_auction_invoices WHERE id = $1', [id])).rows[0];
  const payRow = async (id) => (await q('SELECT * FROM payments WHERE id = $1', [id])).rows[0];
  const collectOurs = async () => {
    for (const r of (await q('SELECT id, payment_intent_id FROM payments WHERE auction_id = $1 AND buyer_user_id = $2', [auction.id, buyer.id])).rows) {
      if (!prePayments.has(r.id)) { A.payments.add(r.id); if (r.payment_intent_id) A.intents.add(r.payment_intent_id); }
    }
    for (const r of (await q('SELECT id FROM card_verifications WHERE user_id = $1', [buyer.id])).rows) {
      if (!preCardVer.has(r.id)) A.cardVer.add(r.id);
    }
  };

  // Save a card on file through the real card-on-file path: SetupIntent (cardService) → confirm with a TEST
  // PaymentMethod → recordCardOnFile (default PM + 'verified' card_verifications marker, stamped with the mode).
  async function saveCard(pmToken) {
    const si = await cardService.createSetupIntent(buyer.id);
    const siId = String(si.client_secret).split('_secret_')[0];
    A.setupIntents.push(siId);
    const conf = await stripe.setupIntents.confirm(siId, { payment_method: pmToken });
    if (conf.status !== 'succeeded') throw new Error(`SetupIntent ${siId} status ${conf.status}`);
    const pmId = typeof conf.payment_method === 'string' ? conf.payment_method : conf.payment_method.id;
    A.pms.push(pmId);
    const rec = await cardService.recordCardOnFile(buyer.id);
    if (rec.payment_method_id !== pmId) notes.push(`recordCardOnFile recorded ${rec.payment_method_id}, not the just-saved ${pmId}.`);
    await collectOurs();
    return { pmId, rec };
  }

  // Synthetic combined invoice, inserted exactly like combinedInvoiceService.issueForAuction does at close
  // (same columns, same computeTotals + effective buyer-premium bps from billingTermsService). issueForAuction
  // itself is not called: it needs CLOSED winning lots, and closing lots on the demo auction would alter it.
  let terms = null;
  async function createInvoice() {
    const totals = combinedInvoiceService.computeTotals(SYNTHETIC_HAMMERS.map((h) => ({ hammerCents: h })), { buyerPremiumBps: terms.buyer_premium_bps });
    const r = (await q(
      `INSERT INTO buyer_auction_invoices
         (auction_id, buyer_user_id, hammer_cents, buyer_premium_cents,
          sales_tax_cents, shipping_cents, credits_cents, total_cents, status, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'issued', now())
       RETURNING id, invoice_number, total_cents, hammer_cents, buyer_premium_cents`,
      [auction.id, buyer.id, totals.hammerCents, totals.buyerPremiumCents, totals.salesTaxCents,
       totals.shippingCents, totals.creditsCents, totals.totalCents])).rows[0];
    A.bai.add(r.id);
    return { ...r, totals };
  }

  // Delete what the scenario created (after production has processed the related webhooks).
  async function teardown(label) {
    await collectOurs();
    for (const id of A.intents) await cancelIfOpen(id);
    await settleWebhooks(A.intents, label);
    try {
      if (A.intents.size || A.payments.size) {
        const d = await q(`DELETE FROM payment_disputes
                            WHERE (payment_intent_id = ANY($1::text[]) OR payment_id = ANY($2::uuid[]) OR id = ANY($3::uuid[]))`,
          [[...A.intents], [...A.payments], [...A.disputeRows]]);
        if (d.rowCount) cleanupLog.push(`${label}: payment_disputes deleted ${d.rowCount}`);
      }
      if (A.bai.size) {
        const d = await q(`DELETE FROM buyer_auction_invoices WHERE id = ANY($1::uuid[]) AND auction_id = $2 AND buyer_user_id = $3`, [[...A.bai], auction.id, buyer.id]);
        cleanupLog.push(`${label}: buyer_auction_invoices deleted ${d.rowCount}/${A.bai.size}`);
      }
      if (A.payments.size) {
        // payment_tax_reversals rows cascade with their payment.
        const d = await q(`DELETE FROM payments WHERE id = ANY($1::uuid[]) AND auction_id = $2 AND buyer_user_id = $3`, [[...A.payments], auction.id, buyer.id]);
        cleanupLog.push(`${label}: payments deleted ${d.rowCount}/${A.payments.size} (tax reversal rows cascade)`);
      }
      if (A.sellerPayoutCreated) {
        const d = await q(`DELETE FROM seller_payouts WHERE id = $1 AND auction_id = $2`, [A.sellerPayoutCreated, auction.id]);
        cleanupLog.push(`${label}: demo seller_payouts row deleted ${d.rowCount}`);
        A.sellerPayoutCreated = null;
      } else if (A.sellerPayoutSnap) {
        await q(`UPDATE seller_payouts SET settlement_status = $2, on_hold_reason = $3, updated_at = now() WHERE id = $1 AND auction_id = $4`,
          [A.sellerPayoutSnap.id, A.sellerPayoutSnap.settlement_status, A.sellerPayoutSnap.on_hold_reason, auction.id]);
        cleanupLog.push(`${label}: pre-existing demo seller_payouts row restored to ${A.sellerPayoutSnap.settlement_status}`);
        A.sellerPayoutSnap = null;
      }
    } catch (e) { cleanupLog.push(`${label}: teardown FAILED: ${e.message}`); notes.push(`${label}: teardown failed — ${e.message}`); }
    A.bai.clear(); A.payments.clear(); A.intents.clear(); A.disputeRows.clear();
  }

  const auctionTaxWasOn = taxOn();
  let taxAddressSet = false;
  try {
    // ── Setup: Stripe TEST customer + card on file (pm_card_visa) ────────────────────────────────
    A.customerId = await cardService.ensureStripeCustomer(buyer.id);
    A.customerCreated = A.customerId !== userSnap.stripe_customer_id;
    if (!A.customerCreated) {
      const cust = await stripe.customers.retrieve(A.customerId);
      const dp = cust.invoice_settings && cust.invoice_settings.default_payment_method;
      A.custDefaultPmBefore = dp ? (dp.id || dp) : null;
    }
    const visa = await saveCard('pm_card_visa');
    log('card on file', `${visa.rec.brand} …${visa.rec.last4} (${visa.pmId}) customer ${A.customerId}${A.customerCreated ? ' (created)' : ' (reused)'}`);

    // Tax on → the off-session charge needs the buyer's tax address. Set a demo address if missing (restored).
    if (taxOn() && !taxService.addressComplete({ line1: userSnap.tax_address_line1, city: userSnap.tax_city, state: userSnap.tax_state, postal_code: userSnap.tax_postal_code, country: userSnap.tax_country })) {
      await q(`UPDATE users SET tax_address_line1 = $2, tax_city = $3, tax_state = $4, tax_postal_code = $5, tax_country = $6
                WHERE id = $1 AND is_demo = true`, [buyer.id, TEST_TAX_ADDRESS.line1, TEST_TAX_ADDRESS.city, TEST_TAX_ADDRESS.state, TEST_TAX_ADDRESS.postal_code, TEST_TAX_ADDRESS.country]);
      taxAddressSet = true;
    }

    terms = await billingTerms.resolveEffectiveTerms(auction.id);
    log('effective terms', `buyer premium ${terms.buyer_premium_bps} bps (${terms.source}), ${terms.is_professional ? 'professional' : 'individual'} seller, pricing ${terms.pricing_model}`);
    if (!terms.is_professional && terms.buyer_premium_bps !== 1800) notes.push(`Individual seller but buyer premium is ${terms.buyer_premium_bps} bps (expected 1800).`);
    if (terms.is_professional) notes.push(`Demo auction seller is PROFESSIONAL (${auction.seller_type}); premium follows the seller's configured rate (${terms.buyer_premium_bps} bps) and belongs to the seller — the individual 18% rule is checked arithmetically only.`);
    const baseline = await settlementEngine.computeSettlement(auction.id);

    // ── A: off-session charge succeeds → invoice settled + receipt email ─────────────────────────
    let invA = null, payA = null;
    try {
      invA = await createInvoice();
      const expectedPremium = SYNTHETIC_HAMMERS.reduce((s, h) => s + billingTerms.lotBuyerPremiumCents(h, terms.buyer_premium_bps), 0);
      const emailIdx = captured.emails.length;
      // Same sequence as the auction-close hook (auctionService, combined branch).
      const r = await paymentService.chargeCombinedOffSession({ auctionId: auction.id, buyerUserId: buyer.id,
        combinedInvoiceId: invA.id, amountCents: invA.total_cents, idempotencyKey: 'combined:' + invA.id });
      if (r.paymentId) A.payments.add(r.paymentId);
      if (r.intentId) A.intents.add(r.intentId);
      let settled = null;
      if (r.status === 'succeeded') {
        settled = await combinedInvoiceService.settleCombined(invA.id, r.intentId, r.paymentId);
        if (settled && settled.settled) await combinedReceiptService.sendSuccessPackage(invA.id);
      }
      const bai = await baiRow(invA.id);
      payA = r.paymentId ? await payRow(r.paymentId) : null;
      const taxCents = payA ? (payA.sales_tax_cents || 0) : 0;
      const taxRecorded = !taxOn() || taxCents === 0 || !!(payA && payA.stripe_tax_transaction_id);
      const mails = emailsSince(emailIdx);
      record('A', 'Off-session charge → invoice settled, receipt email captured, tax recorded if enabled',
        r.status === 'succeeded' && bai.status === 'paid' && payA && payA.status === 'paid' && mails.length > 0 && taxRecorded
        && invA.buyer_premium_cents === expectedPremium, {
          invoice: `${invA.invoice_number} hammer ${invA.hammer_cents} + premium ${invA.buyer_premium_cents} (${terms.buyer_premium_bps} bps; expected ${expectedPremium}) = ${invA.total_cents}`,
          charge_result: JSON.stringify({ status: r.status, skipped: r.skipped, reason: r.reason }),
          charged_amount_cents: payA ? payA.amount_cents : 'n/a', sales_tax_cents: taxCents,
          stripe_tax_transaction_id: payA && payA.stripe_tax_transaction_id ? payA.stripe_tax_transaction_id : '(none)',
          invoice_status: bai.status, invoice_total_cents: bai.total_cents,
          emails_captured: mails.map((m) => m.subject).join(' | ') || '(none)',
        });
    } catch (e) { fail('A', 'Off-session charge', e); }

    // ── F: settlement check (read-only computeSettlement; delta vs. baseline) ────────────────────
    if (payA && payA.status === 'paid') {
      try {
        const after = await settlementEngine.computeSettlement(auction.id);
        const bai = await baiRow(invA.id);
        const d = (k) => Number(after[k] || 0) - Number(baseline[k] || 0);
        const expect = billingTerms.settlement({ sellerType: terms.seller_type, hammerCents: bai.hammer_cents, buyerPremiumCents: bai.buyer_premium_cents,
          platformFeeBps: terms.platform_fee_bps, processingFeeBps: terms.processing_fee_bps, pricingModel: terms.pricing_model });
        const sellerShareExpected = expect.seller_gross_cents + (bai.shipping_cents || 0);
        const ok = d('seller_collected_cents') === sellerShareExpected
          && d('sales_tax_collected_cents') === (bai.sales_tax_cents || 0)
          && d('advantage_premium_collected_cents') === (terms.is_professional ? 0 : bai.buyer_premium_cents)
          && d('buyer_payments_collected_cents') === bai.total_cents
          && d('seller_collected_cents') + d('sales_tax_collected_cents') + d('advantage_premium_collected_cents') === d('buyer_payments_collected_cents')
          && (terms.is_professional || terms.buyer_premium_bps === 1800);
        record('F', 'Settlement: seller basis excludes tax and the Advantage (individual 18%) premium', ok, {
          collected_delta_cents: d('buyer_payments_collected_cents'),
          seller_collected_delta_cents: `${d('seller_collected_cents')} (billingTerms.settlement seller_gross ${expect.seller_gross_cents} + shipping ${bai.shipping_cents || 0})`,
          sales_tax_excluded_cents: d('sales_tax_collected_cents'),
          advantage_premium_excluded_cents: d('advantage_premium_collected_cents'),
          billingTerms_seller_payout_cents: expect.seller_payout_cents,
          engine_net_seller_proceeds_delta: d('net_seller_proceeds_cents'),
        }, 'computeSettlement is read-only (it may record the actual Stripe fee on the paid payment). Mark Paid / Pay Seller are never called.');
      } catch (e) { fail('F', 'Settlement check', e); }
    } else skip('F', 'Settlement check', 'scenario A did not produce a paid invoice');

    // ── D: refund via processRefund (+ tax reversal when taxed) ──────────────────────────────────
    if (!admin) skip('D', 'Refund via processRefund', 'processRefund is admin-only and no admin actor is configured (set ACCEPT_ADMIN_USER_ID or seed an is_demo admin)');
    else if (!(payA && payA.status === 'paid')) skip('D', 'Refund via processRefund', 'scenario A did not produce a paid payment');
    else {
      try {
        const out = await paymentService.processRefund(admin.id, payA.id, payA.amount_cents, 'acceptance-refund:' + payA.id);
        const row = await payRow(payA.id);
        const revs = (await q('SELECT mode, reversal_amount_cents, stripe_tax_reversal_id FROM payment_tax_reversals WHERE payment_id = $1', [payA.id])).rows;
        const needsReversal = taxOn() && (row.sales_tax_cents || 0) > 0 && !!row.stripe_tax_transaction_id;
        record('D', 'processRefund → payment refunded, tax reversal recorded when taxed',
          out.status === 'refunded' && row.status === 'refunded' && Number(row.refunded_amount_cents) === Number(row.amount_cents)
          && (!needsReversal || revs.length > 0 || !!row.stripe_tax_reversal_id), {
            admin_actor: admin.source, refund_amount_cents: out.refund_amount_cents, stripe_refund_id: out.stripe_refund_id,
            payment_status: row.status, sales_tax_cents: row.sales_tax_cents || 0,
            tax_reversals: needsReversal ? (revs.map((r) => `${r.mode} ${r.reversal_amount_cents} ${r.stripe_tax_reversal_id || ''}`).join('; ') || 'MISSING') : 'n/a (no tax recorded)',
          });
      } catch (e) { fail('D', 'Refund via processRefund', e); }
    }
    await teardown('auction A/D/F');

    // ── B: declining default card → payment_required + payment-required email ───────────────────
    let invB = null;
    try {
      let declineCard = 'pm_card_chargeDeclined', fallbackNote = '';
      try { await saveCard(declineCard); }
      catch (e) {
        // The TEST network may refuse to SAVE a card that always declines. Fall back to the card that saves
        // successfully but declines every charge, so the off-session decline path is still exercised.
        declineCard = 'pm_card_chargeCustomerFail';
        fallbackNote = `pm_card_chargeDeclined could not be saved as a card on file (${e.code || e.message}); used pm_card_chargeCustomerFail (saves, then declines charges).`;
        await saveCard(declineCard);
      }
      invB = await createInvoice();
      const emailIdx = captured.emails.length;
      const r = await paymentService.chargeCombinedOffSession({ auctionId: auction.id, buyerUserId: buyer.id,
        combinedInvoiceId: invB.id, amountCents: invB.total_cents, idempotencyKey: 'combined:' + invB.id });
      if (r.paymentId) A.payments.add(r.paymentId);
      // Same routing as the close hook's routePaymentRequired — EXCEPT the +12h/+24h PAYMENT_REMINDER queue rows,
      // which are deliberately NOT enqueued (the production notification worker would deliver them).
      if (r.skipped || r.status === 'failed') {
        await combinedInvoiceService.markFailed(invB.id, 'acceptance:' + (r.reason || r.skipped));
        await combinedReceiptService.sendPaymentRequired(invB.id, 1);
      }
      await collectOurs();
      const bai = await baiRow(invB.id);
      const pay = r.paymentId ? await payRow(r.paymentId) : null;
      const mails = emailsSince(emailIdx);
      record('B', 'Declining default card → invoice payment_required + payment-required email captured',
        r.status === 'failed' && bai.status === 'payment_required' && pay && pay.status === 'failed' && mails.length > 0, {
          card: declineCard, charge_result: JSON.stringify({ status: r.status, reason: r.reason, skipped: r.skipped }),
          payment_status: pay ? pay.status : 'n/a', invoice_status: bai.status, reminders_sent: bai.reminders_sent,
          emails_captured: mails.map((m) => m.subject).join(' | ') || '(none)',
        }, fallbackNote);
    } catch (e) { fail('B', 'Declining card on file', e); }

    // ── C: on-session server-confirmed payment: prepaid refused 422, then credit succeeds ─────────
    if (invB && (await baiRow(invB.id)).status === 'payment_required') {
      try {
        const cp = await paymentService.createCombinedPaymentIntent(buyer.id, invB.id, 'acceptance-onsession:' + invB.id);
        await collectOurs();
        const checkout = await paymentService.getCheckout(buyer.id, cp.payment_id);
        let prepaidErr = null;
        try { await paymentService.confirmOnSessionPayment(buyer.id, cp.payment_id, 'pm_card_mastercard_prepaid'); }
        catch (e) { prepaidErr = e; }
        const emailIdx = captured.emails.length;
        const ok2 = await paymentService.confirmOnSessionPayment(buyer.id, cp.payment_id, 'pm_card_visa');
        // The synchronous finalize sends the success package fire-and-forget; wait for it.
        const paid = await waitFor(async () => { const b = await baiRow(invB.id); return b.status === 'paid' && b; }, 15000);
        await waitFor(async () => emailsSince(emailIdx).length > 0, 10000);
        const pay = await payRow(cp.payment_id);
        record('C', 'On-session checkout: prepaid refused 422, credit card succeeds (server-confirmed)',
          checkout.payable === true && !!prepaidErr && prepaidErr.status === 422 && prepaidErr.code === 'PREPAID_NOT_ACCEPTED'
          && ok2.status === 'succeeded' && !!paid && pay.status === 'paid', {
            checkout: `kind=${checkout.kind} payable=${checkout.payable} amount=${checkout.amount_cents} tax=${checkout.sales_tax_cents}`,
            prepaid_response: prepaidErr ? `${prepaidErr.status} ${prepaidErr.code}` : 'NOT REFUSED',
            credit_response: ok2.status, payment_status: pay.status, invoice_status: paid ? paid.status : 'not paid',
            emails_captured: emailsSince(emailIdx).map((m) => m.subject).join(' | ') || '(none)',
          });
      } catch (e) { fail('C', 'On-session checkout', e); }
    } else skip('C', 'On-session checkout', 'scenario B did not leave an invoice in payment_required');

    // ── G: TEST/LIVE isolation spot-check (before the markers are cleaned up) ─────────────────────
    try {
      await collectOurs();
      const rows = A.cardVer.size ? (await q('SELECT id, livemode FROM card_verifications WHERE id = ANY($1::uuid[])', [[...A.cardVer]])).rows : [];
      const u = (await q('SELECT stripe_customer_livemode FROM users WHERE id = $1', [buyer.id])).rows[0];
      const cust = await stripe.customers.retrieve(A.customerId);
      record('G', 'TEST/LIVE isolation: card_verifications + customer stamped livemode=false',
        rows.length > 0 && rows.every((r) => r.livemode === false) && u.stripe_customer_livemode === false && cust.livemode === false && !isLiveMode(), {
          card_verifications_written: rows.length, all_livemode_false: rows.every((r) => r.livemode === false),
          users_stripe_customer_livemode: u.stripe_customer_livemode, stripe_customer_livemode: cust.livemode,
        });
    } catch (e) { fail('G', 'TEST/LIVE isolation', e); }
    await teardown('auction B/C');

    // ── E: dispute (opt-in) ──────────────────────────────────────────────────────────────────────
    if (!INCLUDE_DISPUTE) {
      skip('E', 'Dispute → recorded, seller payout on hold, owner alert captured',
        'opt-in: pass --include-dispute. The TEST dispute webhook is also delivered to PRODUCTION, whose handler sends a real owner SMS if it wins the race.');
    } else {
      try {
        // A seller_payouts row must exist BEFORE the charge so whichever handler runs first can hold it.
        const sp = (await q('SELECT id, settlement_status, on_hold_reason FROM seller_payouts WHERE auction_id = $1', [auction.id])).rows[0];
        if (sp) {
          if (sp.settlement_status === 'paid') throw new Error('demo seller_payouts row is already paid — refusing to use it');
          A.sellerPayoutSnap = sp;
        } else {
          A.sellerPayoutCreated = (await q(
            `INSERT INTO seller_payouts (auction_id, seller_user_id) VALUES ($1, $2) RETURNING id`,
            [auction.id, auction.seller_user_id])).rows[0].id;
        }
        const invE = await createInvoice();
        const cp = await paymentService.createCombinedPaymentIntent(buyer.id, invE.id, 'acceptance-dispute:' + invE.id);
        await collectOurs();
        const conf = await paymentService.confirmOnSessionPayment(buyer.id, cp.payment_id, 'pm_card_createDispute');
        const pay = await payRow(cp.payment_id);
        // The dispute is opened asynchronously by the TEST network shortly after the charge.
        const dispute = await waitFor(async () => {
          const l = await stripe.disputes.list({ payment_intent: pay.payment_intent_id, limit: 1 });
          return l.data[0] || null;
        }, 90000, 3000);
        if (!dispute) throw new Error('no dispute appeared within 90s for ' + pay.payment_intent_id);
        const prodFirst = !!(await q('SELECT 1 FROM payment_disputes WHERE stripe_dispute_id = $1', [dispute.id])).rows[0];
        // Use the real charge.dispute.created event when available; otherwise an event of the same shape.
        let event = null;
        for await (const ev of stripe.events.list({ type: 'charge.dispute.created', created: { gte: RUN_START_SEC }, limit: 100 })) {
          if (ev.data && ev.data.object && ev.data.object.id === dispute.id) { event = ev; break; }
        }
        if (!event) event = { id: 'evt_acceptance_' + dispute.id, type: 'charge.dispute.created', livemode: false, data: { object: dispute } };
        const alertIdx = captured.ownerAlerts.length;
        const out = await disputeService.handleDisputeEvent(event, { getStripe: () => stripe });
        const row = (await q('SELECT * FROM payment_disputes WHERE stripe_dispute_id = $1', [dispute.id])).rows[0];
        if (row) A.disputeRows.add(row.id);
        const spAfter = (await q('SELECT settlement_status, on_hold_reason FROM seller_payouts WHERE auction_id = $1', [auction.id])).rows[0];
        const alerts = captured.ownerAlerts.slice(alertIdx);
        const alertOk = alerts.length > 0 || prodFirst;
        record('E', 'Dispute → recorded, demo seller payout on_hold, owner alert captured (not sent)',
          conf.status === 'succeeded' && !!row && row.payment_id === pay.id && row.livemode === false
          && spAfter && spAfter.settlement_status === 'on_hold' && alertOk, {
            dispute: `${dispute.id} ${dispute.status} ${dispute.reason} ${dispute.amount}`,
            event_source: event.id.startsWith('evt_acceptance_') ? 'synthetic (same shape)' : 'real ' + event.id,
            handler_result: JSON.stringify(out), dispute_row_payout_hold_applied: row ? row.payout_hold_applied : 'n/a',
            seller_payout_status: spAfter ? `${spAfter.settlement_status} — ${spAfter.on_hold_reason || ''}` : 'n/a',
            owner_alerts_captured: alerts.map((a) => a.headline).join(' | ') || '(none)',
          }, prodFirst ? 'PRODUCTION processed the TEST dispute webhook first: its owner SMS was sent by production (not capturable here).' : '');
      } catch (e) { fail('E', 'Dispute', e); }
      await teardown('auction E');
    }
  } finally {
    // ── Auction cleanup ──────────────────────────────────────────────────────────────────────────
    console.log('\n  [cleanup] auction');
    await teardown('auction final');
    for (const si of A.setupIntents) {
      try { const s = await stripe.setupIntents.retrieve(si); if (!['succeeded', 'canceled'].includes(s.status)) await stripe.setupIntents.cancel(si); }
      catch (_) { /* best-effort */ }
    }
    for (const pm of A.pms) {
      try { await stripe.paymentMethods.detach(pm); cleanupLog.push(`detached TEST card ${pm}`); }
      catch (e) { cleanupLog.push(`detach ${pm}: ${e.message}`); }
    }
    try {
      if (A.customerId && A.customerCreated) {
        await stripe.customers.del(A.customerId);
        cleanupLog.push(`deleted TEST customer ${A.customerId} (created by this run)`);
      } else if (A.customerId) {
        await stripe.customers.update(A.customerId, { invoice_settings: { default_payment_method: A.custDefaultPmBefore || '' } });
        cleanupLog.push(`restored default payment method on existing TEST customer ${A.customerId}`);
      }
    } catch (e) { cleanupLog.push('customer cleanup: ' + e.message); }
    try {
      await collectOurs();
      if (A.cardVer.size) {
        const d = await q('DELETE FROM card_verifications WHERE id = ANY($1::uuid[]) AND user_id = $2', [[...A.cardVer], buyer.id]);
        cleanupLog.push(`card_verifications deleted ${d.rowCount}/${A.cardVer.size}`);
      }
      await q(`UPDATE users SET stripe_customer_id = $2, stripe_customer_livemode = $3, superseded_stripe_customer_id = $4,
                                tax_address_line1 = $5, tax_address_line2 = $6, tax_city = $7, tax_state = $8,
                                tax_postal_code = $9, tax_country = $10
                WHERE id = $1 AND is_demo = true`,
        [buyer.id, userSnap.stripe_customer_id, userSnap.stripe_customer_livemode, userSnap.superseded_stripe_customer_id,
         userSnap.tax_address_line1, userSnap.tax_address_line2, userSnap.tax_city, userSnap.tax_state,
         userSnap.tax_postal_code, userSnap.tax_country]);
      cleanupLog.push(`demo buyer ${buyer.email} payment/tax columns restored${taxAddressSet ? ' (temporary tax address removed)' : ''}`);
    } catch (e) { cleanupLog.push('buyer restore FAILED: ' + e.message); }
    setTax(auctionTaxWasOn);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 7. MAIN
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('=== Advantage.Bid live-readiness acceptance (Stripe TEST) ===');
  log('run id', RUN_ID);
  log('stripe mode', 'TEST (sk_test_ + pk_test_)');
  log('scope', [RUN_STOREFRONT && 'storefront', RUN_AUCTION && 'auction'].filter(Boolean).join(' + ') + (INCLUDE_DISPUTE ? ' (+dispute)' : ''));

  const buyers = await discoverBuyers();
  if (!buyers.length) {
    console.error('No is_demo buyer found — nothing can run.');
    if (RUN_STOREFRONT) skip('S*', 'Storefront scenarios', 'no is_demo buyer (users.is_demo=true, role=buyer)');
    if (RUN_AUCTION) skip('A–G', 'Auction scenarios', 'no is_demo buyer (users.is_demo=true, role=buyer)');
  } else {
    await resolveTaxMode(buyers[0].id);

    if (RUN_STOREFRONT) {
      const item = await discoverItem(buyers.map((b) => b.id));
      const buyer = buyers.find((b) => !item || b.id !== item.seller_user_id);
      if (!item) skip('S1–S9', 'Storefront scenarios', 'no ACTIVE is_demo marketplace item of an is_demo professional seller (run scripts/seed-demo-storefront.js, or reset the item to active)');
      else if (!buyer) skip('S1–S9', 'Storefront scenarios', 'no is_demo buyer distinct from the item seller');
      else if (item.is_demo !== true || item.seller_is_demo !== true) { console.error('REFUSE: storefront target is not is_demo.'); process.exit(2); }
      else {
        try { await runStorefront(buyer, item); }
        catch (e) { fail('S*', 'Storefront phase aborted', e); }
      }
    }

    if (RUN_AUCTION) {
      const auction = await discoverAuction();
      let buyer = null;
      if (auction) {
        for (const b of buyers) {
          const busy = (await q(`SELECT (SELECT count(*) FROM buyer_auction_invoices WHERE auction_id = $1 AND buyer_user_id = $2)
                                      + (SELECT count(*) FROM payments WHERE auction_id = $1 AND buyer_user_id = $2 AND lot_id IS NULL
                                           AND status IN ('pending','paid','refunded','partially_refunded'))
                                      + (SELECT count(*) FROM invoices WHERE auction_id = $1 AND buyer_user_id = $2) AS n`, [auction.id, b.id])).rows[0];
          if (Number(busy.n) === 0 && b.id !== auction.seller_user_id) { buyer = b; break; }
        }
      }
      if (!auction) skip('A–G', 'Auction scenarios', 'demo auction not found (00000000-0000-4000-a000-0000000d0003 or ACCEPT_AUCTION_ID)');
      else if (auction.is_demo !== true || auction.seller_is_demo !== true) { console.error('REFUSE: auction target or its seller is not is_demo.'); process.exit(2); }
      else if (auction.state === 'closed') skip('A–G', 'Auction scenarios', 'demo auction is CLOSED — the production seller-closeout worker would act on combined invoices for it');
      else if (!buyer) skip('A–G', 'Auction scenarios', 'every is_demo buyer already has a combined invoice/payment on the demo auction (not created by this run; left untouched)');
      else {
        const admin = await discoverAdmin();
        try { await runAuction(buyer, auction, admin); }
        catch (e) { fail('A*', 'Auction phase aborted', e); }
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\n=== CAPTURED (never sent) ===');
  log('emails', captured.emails.length);
  for (const m of captured.emails) log('  subject', m.subject);
  log('sms', captured.sms.length);
  log('owner alerts', captured.ownerAlerts.length);
  for (const a of captured.ownerAlerts) log('  alert', `${a.fn}: ${a.headline || a.actionType || ''}`);
  log('conversion events', captured.conversions.length);

  console.log('\n=== CLEANUP SUMMARY ===');
  for (const c of cleanupLog) log('-', c);

  if (notes.length) { console.log('\n=== NOTES ==='); for (const n of notes) log('-', n); }

  console.log('\n=== RESULTS ===');
  console.log('  ' + 'ID'.padEnd(7) + 'STATUS'.padEnd(8) + 'SCENARIO');
  for (const r of results) console.log('  ' + r.id.padEnd(7) + r.status.padEnd(8) + r.name + (r.status === 'SKIP' ? ' — ' + r.note : ''));
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n  ${passed} PASS · ${failed} FAIL · ${skipped} SKIP (not executed)`);
  console.log('\nRESULT: ' + (failed ? 'FAIL' : 'PASS'));
  await db.pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  try { await db.pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
