#!/usr/bin/env node
/* storefront-pilot-preflight.js — READ-ONLY readiness check for one controlled live storefront purchase (owner 2026-11-11).

   Usage (production, from the linked project folder):
     railway run --service advantage-auction-platform --environment production \
       node scripts/storefront-pilot-preflight.js [--seller timeless-treasures] [--buyer <email or user id>] [--item <item id>]
                                                  [--max-price-cents 500] [--base https://bid.advantage.bid] [--json]

   What it checks, using the SAME server code checkout runs (not a copy of its rules):
     seller account, business verification (verificationService.publicationGate), signed storefront agreement
     (agreementService.storefrontAgreementStatus), payout readiness (payoutPreferenceService + sellerSaleEligibility.payoutReady),
     overall eligibility (sellerSaleEligibility.assertSellerCanSell), pickup location (saleLocation.forItem), published Store
     Terms and Shipping & Pickup Policy (sellerPolicyService.snapshotFor + marketplaceOrderService.assertPurchasePolicies), a
     low-value pilot item (marketplaceOrderService.loadItemForPurchase), the sales tax rule for the sale state
     (marketplaceOrderService.taxRuleFor), Buyer Terms, the pilot buyer, and pilot checkout eligibility (launchGuards).

   Statuses: PASS · BLOCKED (the server would refuse) · NEEDS OWNER ACTION (an owner step completes it) · UNVERIFIED (cannot be
   read from here, e.g. inside Stripe; confirm by hand).

   SAFETY: read-only by construction. One database connection is opened and set to default_transaction_read_only, and the
   application's database module is replaced by that connection BEFORE any service loads, so any write the code attempted
   would be refused by the database. It sends no email or text, calls no payment provider, and changes nothing. Output holds
   no credentials, bank or card details, account numbers, addresses beyond city/state, or buyer contact details.
   Exit code: 0 = every check PASS (UNVERIFIED items still listed for manual confirmation); 1 = not ready; 2 = could not run. */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const JSON_OUT = args.includes('--json');
const SELLER = arg('seller', 'timeless-treasures');
const BUYER = arg('buyer');
const ITEM = arg('item');
const MAX_PRICE = Number(arg('max-price-cents', '500'));
const BASE = String(arg('base', process.env.APP_BASE_URL || 'https://bid.advantage.bid')).replace(/\/+$/, '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PASS = 'PASS', BLOCKED = 'BLOCKED', OWNER = 'NEEDS OWNER ACTION', UNVERIFIED = 'UNVERIFIED';
const checks = [];
const add = (area, status, finding, action = null) => checks.push({ area, status, finding, action });

async function main() {
  if (!process.env.DATABASE_URL) { console.error('REFUSE: DATABASE_URL is not set (run through railway run).'); return 2; }
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  const ro = (await client.query('SHOW default_transaction_read_only')).rows[0];
  if (!ro || ro.default_transaction_read_only !== 'on') { console.error('REFUSE: could not make the session read-only.'); await client.end(); return 2; }
  // Every service below talks to the database only through this read-only connection.
  const runner = { query: (t, p) => client.query(t, p), connect: async () => ({ query: (t, p) => client.query(t, p), release() {} }), pool: null };
  const dbPath = require.resolve(path.join(ROOT, 'src', 'db'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: runner };
  const q1 = async (sql, p) => (await client.query(sql, p)).rows[0] || null;
  const svc = (p) => require(path.join(ROOT, 'src', p));

  try {
    // ── 1. Seller account ──────────────────────────────────────────────────────────────────────────────────────────
    const sp = await q1(`SELECT sp.id, sp.user_id, sp.seller_type, sp.display_name, sp.storefront_slug, sp.storefront_published, sp.is_demo,
        sp.show_branding_to_buyers, sp.created_at, sp.default_pickup_city, sp.default_pickup_state, sp.default_pickup_confirmed_at,
        u.is_active AS owner_active
      FROM seller_profiles sp LEFT JOIN users u ON u.id = sp.user_id
      WHERE ${UUID.test(SELLER) ? 'sp.id = $1' : 'sp.storefront_slug = $1'}`, [SELLER]);
    if (!sp) { add('Seller account', BLOCKED, `No seller found for "${SELLER}".`); return report(); }
    const pro = svc('services/sellerTypeRules').isProfessional(sp.seller_type);
    const sellerName = sp.display_name || sp.storefront_slug;
    if (!pro || sp.is_demo || sp.owner_active === false) {
      add('Seller account', BLOCKED, `${sellerName}: ${!pro ? 'not a Professional Seller' : sp.is_demo ? 'a demo account' : 'the owner account is closed'}.`);
    } else {
      add('Seller account', PASS, `${sellerName} (${sp.seller_type.replace(/_/g, ' ')}), active, registered ${new Date(sp.created_at).toISOString().slice(0, 10)}; storefront ${sp.storefront_published ? 'published' : 'NOT published'} at /pro/${sp.storefront_slug}.`);
    }

    // ── 2. Business verification (the sale gate) ─────────────────────────────────────────────────────────────────
    const gate = await svc('services/verificationService').publicationGate(sp.id, runner);
    if (!gate.blocked) add('Business verification', PASS, gate.reason === 'verified' ? 'Approved.' : 'Not required for this seller.');
    else {
      const last = await q1(`SELECT v.status, (SELECT count(*)::int FROM verification_documents d WHERE d.request_id = v.id) AS docs FROM verification_requests v
                              WHERE v.seller_profile_id = $1 ORDER BY COALESCE(v.updated_at, v.created_at) DESC LIMIT 1`, [sp.id]);
      const st = svc('services/ownerReviewDigestService').verificationState(last && last.status, last && last.docs);
      add('Business verification', OWNER, `Required and not approved: ${st.missing}.`,
        `Admin > Verification (${BASE}/admin/verification.html?seller=${sp.id}): open a request if none exists, review, approve.`);
    }

    // ── 3. Storefront agreement ───────────────────────────────────────────────────────────────────────────────────
    const agr = await svc('services/agreementService').storefrontAgreementStatus(sp.id, runner);
    add('Seller Agreement (storefront terms)', agr && agr.ok ? PASS : OWNER, agr && agr.ok ? 'Signed on the current storefront terms.' : 'No signed agreement with the current storefront terms.',
      agr && agr.ok ? null : 'The seller signs the current Seller Agreement (/sign-agreement.html?current=1).');

    // ── 4. Payout readiness (booleans only; no account or bank details) ───────────────────────────────────────────
    const pref = await svc('services/payoutPreferenceService').getSellerPayoutPreference(sp.user_id, runner);
    const ready = svc('services/sellerSaleEligibility').payoutReady(pref);
    const parts = pref ? `payout method ${pref.payout_method || 'not chosen'}; connected account ${pref.stripe_account_id ? 'yes' : 'no'}; transfers active ${!!pref.connect_transfers_active}; payouts enabled ${!!pref.connect_payouts_enabled}` : 'no payout setup on record';
    add('Payout account (Stripe Connect)', ready ? PASS : OWNER, `${ready ? 'Ready' : 'Not ready'}: ${parts}.`,
      ready ? null : 'Signed in as the seller: Payout settings (/payout-profile.html), complete Stripe Connect with a bank account until transfers and payouts are active.');
    if (ready && pref.stripe_account_livemode === false) add('Payout account mode', BLOCKED, 'The connected account was created in Stripe TEST mode; a live sale needs a live account.');

    // ── 5. Overall seller eligibility (exactly what every quote, order and payment calls) ─────────────────────────
    try { await svc('services/sellerSaleEligibility').assertSellerCanSell(sp.id, runner); add('Seller may sell (server check)', PASS, 'assertSellerCanSell passes.'); }
    catch (e) { add('Seller may sell (server check)', BLOCKED, `The server refuses orders: ${e.code || e.message} (resolves when the items above pass).`); }

    // ── 6. Store Terms + Shipping & Pickup Policy ─────────────────────────────────────────────────────────────────
    const shown = require(path.join(ROOT, 'src', 'lib', 'sellerBranding')).brandingVisible(sp.seller_type, sp.show_branding_to_buyers);
    const snap = await svc('services/sellerPolicyService').snapshotFor(sp.id, runner, { shown });
    const missingPolicies = [!snap.store_terms && 'Store Terms', !snap.shipping_pickup && 'Shipping & Pickup Policy'].filter(Boolean);
    if (!shown) add('Store policies', BLOCKED, 'Seller branding is hidden from buyers, so its policies cannot be shown and checkout refuses the sale.');
    else if (missingPolicies.length) {
      const drafts = (await client.query(`SELECT kind FROM seller_policy_versions WHERE seller_id = $1 AND status = 'draft'`, [sp.id])).rows.map((r) => r.kind);
      add('Store policies', OWNER, `Not published: ${missingPolicies.join(' and ')}${drafts.length ? ` (draft${drafts.length > 1 ? 's' : ''} exist)` : ''}.`,
        `Signed in as the seller: My Storefront > Store (/seller-storefront.html?tab=store), publish ${missingPolicies.join(' and ')}.`);
    } else add('Store policies', PASS, `Published: Store Terms v${snap.store_terms.version}, Shipping & Pickup Policy v${snap.shipping_pickup.version}.`);

    // ── 7. Pickup location (city/state only) ──────────────────────────────────────────────────────────────────────
    const saleLocation = svc('lib/saleLocation');
    const dflt = saleLocation.fromSellerDefault ? saleLocation.forItem({ pickup_location_source: 'default', ...(await q1(`SELECT default_pickup_address_line1, default_pickup_address_line2, default_pickup_city, default_pickup_state,
        default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at FROM seller_profiles WHERE id = $1`, [sp.id])) }) : null;
    if (dflt && !dflt.missing.length) add('Pickup location', PASS, `Confirmed default pickup location in ${dflt.address.city || '?'}, ${dflt.address.state || '?'}.`);
    else add('Pickup location', OWNER, `Missing: ${(dflt && dflt.missing.join(', ')) || 'confirmed storefront pickup location'}.`,
      'Signed in as the seller: set and confirm the storefront pickup address (with state) and pickup window.');

    // ── 8. Pilot item ─────────────────────────────────────────────────────────────────────────────────────────────
    const items = (await client.query(`SELECT id, title, price_cents, quantity, quantity_sold, status, moderation_status, is_demo
        FROM marketplace_items WHERE seller_id = $1 ${ITEM ? 'AND id = $2' : `AND status = 'active'`} ORDER BY price_cents ASC LIMIT 1`,
      ITEM ? [sp.id, ITEM] : [sp.id])).rows;
    const it = items[0] || null;
    const orders = svc('services/marketplaceOrderService');
    let loaded = null;
    if (!it) add('Pilot item', OWNER, ITEM ? `Item ${ITEM} is not this seller's.` : 'The seller has no active item.', `Signed in as the seller: list one item, price at most $${(MAX_PRICE / 100).toFixed(2)}, quantity 1, pickup only.`);
    else {
      const avail = Number(it.quantity || 1) - Number(it.quantity_sold || 0);
      const problems = [it.status !== 'active' && `status ${it.status}`, it.moderation_status !== 'none' && `moderation ${it.moderation_status}`, it.is_demo && 'demo item',
        !(avail > 0) && 'none available', Number(it.price_cents) > MAX_PRICE && `price $${(it.price_cents / 100).toFixed(2)} is above the pilot limit $${(MAX_PRICE / 100).toFixed(2)}`].filter(Boolean);
      add('Pilot item', problems.length ? OWNER : PASS, `"${String(it.title).slice(0, 80)}" (${it.id}), $${(it.price_cents / 100).toFixed(2)}, ${avail} available${problems.length ? '; ' + problems.join('; ') : ''}.`,
        problems.length ? 'Adjust the item or list a suitable one.' : null);
      // Checkout's own item load (eligibility, own-item rule, price, pickup). A placeholder buyer id never matches the seller.
      try { loaded = await orders.loadItemForPurchase(it.id, '00000000-0000-4000-8000-000000000000', 'pickup', runner); add('Item purchasable for pickup (server check)', PASS, 'loadItemForPurchase passes.'); }
      catch (e) { add('Item purchasable for pickup (server check)', BLOCKED, `Checkout refuses: ${e.code || e.message}.`); }
    }

    // ── 9. Sales tax rule for the sale state ──────────────────────────────────────────────────────────────────────
    const state = (it && loaded ? saleLocation.forItem(loaded.item) : dflt) && ((loaded ? saleLocation.forItem(loaded.item) : dflt).address || {}).state;
    if (!state) add('Sales tax rule', BLOCKED, 'The sale state is unknown until the pickup location is confirmed.', 'Confirm the pickup location first, then the rule below.');
    else {
      const rule = await orders.taxRuleFor(state, runner);
      if (!rule) add('Sales tax rule', BLOCKED, `No effective rule for ${state}: every order there fails closed (TAX_CONFIGURATION_REQUIRED).`,
        `Get the CPA's decision for ${state}, then add it in Admin > Tax Jurisdictions (seller_direct, or platform/seller with a Stripe Tax registration).`);
      else {
        add('Sales tax rule', PASS, `${state}: remitter "${rule.remitter}".`);
        if (rule.remitter === 'platform' || rule.remitter === 'seller') add('Stripe Tax registration', UNVERIFIED, `The rule collects tax at checkout, so Stripe must be collecting in ${state}; registrations cannot be read from here.`,
          `Stripe Dashboard (live) > Tax > Registrations: confirm ${state}. A registration also taxes auction invoices there.`);
      }
    }
    const taxSvc = svc('services/taxCalculationService');
    const taxOn = typeof taxSvc.taxEnabled === 'function' ? !!taxSvc.taxEnabled() : null;
    if (taxOn !== null) add('Tax calculation switch', PASS, `Stripe Tax calculation is ${taxOn ? 'on' : 'off'} (STRIPE_TAX_ENABLED).`);

    // ── 10. Buyer Terms ───────────────────────────────────────────────────────────────────────────────────────────
    const terms = await q1(`SELECT version_int, title, effective_at, body_markdown FROM terms_versions WHERE kind = 'buyer_terms' AND is_current LIMIT 1`);
    if (!terms) add('Buyer Terms', BLOCKED, 'No current Buyer Terms version is published.');
    else {
      const covers = /(fixed[- ]price|buy now|storefront|store terms)/i.test(terms.body_markdown || '');
      add('Buyer Terms', covers ? PASS : OWNER, `Current: v${terms.version_int} (effective ${new Date(terms.effective_at).toISOString().slice(0, 10)}); the buyer accepts it at checkout and the acceptance is recorded. ${covers ? 'Covers fixed-price purchases.' : 'Does not mention fixed-price / storefront purchases.'}`,
        covers ? null : 'Legal decision: publish Buyer Terms v4 (fixed-price), or approve v3 for the pilot in writing.');
    }

    // ── 11. Pilot buyer ───────────────────────────────────────────────────────────────────────────────────────────
    let buyer = null;
    if (!BUYER) add('Pilot buyer', OWNER, 'No buyer given (--buyer).', 'Create a buyer account separate from the seller account, save a real non-prepaid card, then re-run with --buyer.');
    else {
      buyer = await q1(`SELECT id, is_active, email_verified FROM users WHERE ${UUID.test(BUYER) ? 'id = $1' : 'lower(email) = lower($1)'}`, [BUYER]);
      if (!buyer) add('Pilot buyer', BLOCKED, 'No account found for the given buyer.');
      else if (buyer.id === sp.user_id) add('Pilot buyer', BLOCKED, 'The buyer is the seller\'s own account (CANNOT_BUY_OWN).', 'Use a separate buyer account.');
      else if (buyer.is_active === false) add('Pilot buyer', BLOCKED, 'The buyer account is closed.');
      else {
        const card = await q1(`SELECT count(*)::int n FROM card_verifications WHERE user_id = $1 AND status = 'verified' AND stripe_payment_method_id IS NOT NULL`, [buyer.id]).catch(() => null);
        add('Pilot buyer', PASS, `Account ${buyer.id}, active, separate from the seller.`);
        add('Buyer card on file', card && card.n > 0 ? UNVERIFIED : OWNER, card && card.n > 0 ? 'A verified card is on record; whether it was saved in live mode is confirmed at checkout.' : 'No verified card on record.',
          card && card.n > 0 ? 'Confirm at checkout that the saved card is a real (non-prepaid) card.' : 'Signed in as the buyer: save a real debit or credit card.');
      }
    }

    // ── 12. Pilot checkout eligibility (read from this process's environment; never changed here) ──────────────────
    const lg = svc('lib/launchGuards');
    const globalOn = lg.marketplaceCheckoutEnabled();
    const pilot = lg.marketplaceCheckoutPilot();
    add('Global checkout switch', globalOn ? BLOCKED : PASS, globalOn ? 'MARKETPLACE_CHECKOUT_ENABLED is ON: checkout is open to every buyer. Turn it off for a controlled pilot.' : 'Off (MARKETPLACE_CHECKOUT_ENABLED unset): no one outside the pilot lists can buy.');
    const sellerListed = pilot.sellers.includes(String(sp.id).toLowerCase());
    const buyerListed = !!(buyer && pilot.users.includes(String(buyer.id).toLowerCase()));
    if (lg.marketplaceCheckoutAllowed({ sellerId: sp.id, userId: buyer && buyer.id })) add('Pilot checkout allowed', PASS, 'This buyer may check out from this seller (pilot lists).');
    else add('Pilot checkout allowed', OWNER, `Not yet: seller ${sellerListed ? 'listed' : 'not listed'} in MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS; buyer ${buyerListed ? 'listed' : 'not listed'} in MARKETPLACE_CHECKOUT_PILOT_USER_IDS. (Lists now: ${pilot.sellers.length} seller(s), ${pilot.users.length} buyer(s).)`,
      `Activation step, only with explicit owner approval and only after every other check passes: set both lists to ${sp.id} and the buyer's id. Leave the global switch off.`);

    // ── 13. Stripe live mode and webhooks ─────────────────────────────────────────────────────────────────────────
    try {
      const h = await (await fetch(BASE + '/api/health', { headers: { 'User-Agent': 'AdvantageBid-PilotPreflight/1.0' } })).json();
      add('Stripe live mode (production health)', h && h.stripe_mode === 'live' && h.stripe_keys_consistent ? PASS : BLOCKED, `Production reports stripe_mode=${h && h.stripe_mode}, keys consistent=${h && h.stripe_keys_consistent}.`);
    } catch (e) { add('Stripe live mode (production health)', UNVERIFIED, `Could not read ${BASE}/api/health.`); }
    const wh = await q1(`SELECT max(received_at) AS last, count(*)::int AS n FROM stripe_webhook_events`).catch(() => null);
    add('Live webhook endpoint and events', UNVERIFIED, `Last webhook received ${wh && wh.last ? new Date(wh.last).toISOString().slice(0, 10) : 'never'}; the endpoint's subscribed events and signing secret live in Stripe.`,
      'Stripe Dashboard (live) > Developers > Webhooks: run the 8-step check in docs/operations/stripe-live-webhook-verification.md.');

    // ── 14. Who hears about the sale ──────────────────────────────────────────────────────────────────────────────
    const admins = await q1(`SELECT count(*) FILTER (WHERE email_verified IS TRUE)::int v, count(*)::int n FROM users
      WHERE (role = 'admin' OR staff_role IN ('super_admin','finance')) AND is_active IS NOT FALSE AND staff_active IS NOT FALSE`).catch(() => null);
    if (admins) add('Admin sale notices', admins.v > 0 ? PASS : OWNER, `${admins.v} of ${admins.n} administrator email address(es) verified (only verified addresses receive sale notices).`,
      admins.v > 0 ? null : 'Verify at least one administrator email address.');
  } finally {
    await client.end().catch(() => {});
  }
  return report();
}

function report() {
  const order = { [BLOCKED]: 0, [OWNER]: 1, [UNVERIFIED]: 2, [PASS]: 3 };
  const notReady = checks.some((c) => c.status === BLOCKED || c.status === OWNER);
  if (JSON_OUT) { console.log(JSON.stringify({ seller: SELLER, ready: !notReady, checks }, null, 2)); return notReady ? 1 : 0; }
  console.log(`\nStorefront pilot pre-flight (read-only) - seller "${SELLER}"${BUYER ? ', buyer given' : ''} - ${new Date().toISOString()}\n`);
  for (const c of checks) {
    console.log(`[${c.status}] ${c.area}: ${c.finding}`);
    if (c.action) console.log(`    -> ${c.action}`);
  }
  const counts = checks.reduce((m, c) => (m[c.status] = (m[c.status] || 0) + 1, m), {});
  console.log(`\nSummary: ${Object.keys(order).filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(', ')}`);
  console.log(notReady ? 'RESULT: NOT READY for the first controlled live purchase.' : 'RESULT: READY, after confirming every UNVERIFIED item by hand.');
  return notReady ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error('PREFLIGHT ERROR:', e && e.message); process.exit(2); });
