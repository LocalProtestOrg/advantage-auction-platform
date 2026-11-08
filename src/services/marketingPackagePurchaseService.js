'use strict';

/**
 * marketingPackagePurchaseService — the REAL Stripe prepaid purchase lifecycle for paid Marketing Packages
 * (FEATURED/PREMIUM/SIGNATURE) and Additional Promotions (BOOST/REACH/SPOTLIGHT/CUSTOM).
 *
 * Rules (owner-locked): prepaid card only · NO fulfillment before successful payment · NON-REFUNDABLE ·
 * never advanced against auction proceeds · never recovered from proceeds · immutable separate purchase
 * record · ACTUAL paid amount drives the internal policy snapshot · package identity comes from the
 * checkout metadata (NEVER inferred from price). Stripe TEST mode preserved (uses STRIPE_SECRET_KEY as-is).
 *
 * On the authoritative paid webhook transition it: freezes an immutable snapshot (price, seller copy,
 * guaranteed deliverables, discretionary tools, economic-policy version, derived internal authority),
 * creates fulfillment obligations, hands off to the Marketing Director planner, and fires ONE Owner SMS via
 * the certified multi-recipient alert. Reuses estate-sale's Stripe pattern + paymentService webhook pipe.
 */

const db = require('../db');
const Stripe = require('stripe');
const { withTransaction } = require('../utils/withTransaction');
const cardService = require('./cardService');
const registry = require('./packageRegistryService');
const econ = require('./economicPolicyService');
const obligations = require('./marketingObligationEngine');
const director = require('./marketingPackageDirectorService');
const marketingConfig = require('./marketingConfigService');
const ownerAlertService = require('./ownerAlertService');
const analyticsService = require('./analyticsService');

const STRIPE_API_VERSION = '2026-03-25.dahlia';
const PKG = 'marketing_package';
const ADDL = 'additional_promotion';
const ADDL_KEYS = ['boost', 'reach', 'spotlight', 'custom'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(status, message, code) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }

// ── Deliverability (owner decision 2026-11-06) ───────────────────────────────────
// Paid advertising fulfillment is not live (channelDispatch returns paid_provider_inactive for the PAID channel), so a
// package or promotion that would create ANY paid obligation, guaranteed or discretionary, cannot be sold: the seller
// would pay for something that cannot be delivered. Decided from the catalogue data itself, so a new package version
// without paid components becomes purchasable without a code change.
const UNAVAILABLE_PAID = 'This option includes paid advertising, which is not available yet, so it cannot be purchased right now.';
const UNAVAILABLE_CUSTOM = 'Custom promotions are arranged with Advantage.Bid directly and cannot be purchased online.';

function featureKeyOf(component) {
  const key = component && (component.feature_key || component.key || component);
  try { const f = require('./phase3oContract').featureByKey(String(key)); return f ? f.feature_key : String(key); } catch (_) { return String(key); }
}
// Owned placements (owner decision 2026-11-07: sell only what the production system actually delivers). The placement
// executor records reservations and evidence, but no public page or public API reads them yet (verified 2026-11-08),
// so a featured badge, listing priority, category prominence, notable-lot spotlight, Closing Soon or homepage
// placement never reaches buyers. A component whose key is not mapped to a real channel only falls through to the
// generic SERVICE default, which the fulfillment monitor marks complete without delivering anything; it is
// undeliverable too. Mapped SERVICE items (analytics, reports, reviews) are real.
const MAPPED_SERVICE_KEYS = ['listing_standard', 'follower_launch_notification', 'performance_standard', 'reporting_standard', 'reporting_detailed',
  'catalog_readiness_review', 'managed_campaign_documents', 'managed_review_added_wave', 'recommendations_written', 'custom_bundle'];
const UNAVAILABLE_NOT_DELIVERED = 'This option is not available yet: some of its benefits cannot be delivered yet, so it cannot be purchased right now.';
function isUndeliverable(component) {
  const channelDispatch = require('./channelDispatch');
  const ch = component && typeof component === 'object' ? String(component.channel || '').toLowerCase() : '';
  const key = featureKeyOf(component);
  const channel = channelDispatch.channelOf(key);
  if (ch === 'paid' || channel === 'PAID') return 'paid';
  if (channel === 'OWNED' || ['listing', 'onsite', 'homepage'].includes(ch)) return 'not_delivered';
  if (channel === 'SERVICE' && MAPPED_SERVICE_KEYS.indexOf(key) === -1) return 'not_delivered';
  return false;
}
function deliverabilityOf(components) {
  const reasons = components.map((c) => [c, isUndeliverable(c)]).filter(([, r]) => r);
  if (!reasons.length) return { purchasable: true, blocked: [], reason: null };
  const paid = reasons.some(([, r]) => r === 'paid');
  return { purchasable: false, blocked: reasons.map(([c]) => (c && (c.label || c.key)) || String(c)), reason: paid ? UNAVAILABLE_PAID : UNAVAILABLE_NOT_DELIVERED };
}
/** { purchasable, blocked: [labels], reason } for one package version (guaranteed + discretionary components). */
function packageDeliverability(version) {
  if (!version) return { purchasable: false, blocked: [], reason: 'No active version for package' };
  // Guaranteed deliverables must all be delivered; discretionary tools are "may include" extras, but a paid one is
  // still never sold (owner decision 2026-11-06).
  const guaranteed = deliverabilityOf(version.guaranteed_deliverables || []);
  if (!guaranteed.purchasable) return guaranteed;
  const paidExtras = (version.discretionary_tools || []).filter((d) => isUndeliverable(d) === 'paid');
  return paidExtras.length ? { purchasable: false, blocked: paidExtras.map((d) => d.label || d.key), reason: UNAVAILABLE_PAID } : { purchasable: true, blocked: [], reason: null };
}
/** Same for an Additional Promotion, from the recipe children it would execute. CUSTOM has no online composition. */
function promotionDeliverability(promotionKey) {
  const key = String(promotionKey || '').toLowerCase();
  if (key === 'custom') return { purchasable: false, blocked: ['custom bundle'], reason: UNAVAILABLE_CUSTOM };
  const { children } = require('./additionalPromotionExecutor').composeChildren(key.toUpperCase());
  if (!children.length) return { purchasable: false, blocked: [], reason: 'Unknown promotion' };
  return deliverabilityOf(children);
}

// ── Ownership (server-side) ───────────────────────────────────────────────────────
// A seller may buy only for their OWN auction. An admin may buy for any auction (admin override), and that override is
// audited. Returns the auction's seller profile id (attribution) or null.
async function assertAuctionAccess(actor, auctionId, { action, runner = db } = {}) {
  const isAdmin = actor && actor.role === 'admin';
  if (!auctionId) {
    if (isAdmin) return null;
    throw fail(400, 'Choose the auction this promotion is for.', 'AUCTION_REQUIRED');
  }
  if (!UUID.test(String(auctionId))) throw fail(404, 'Auction not found.', 'AUCTION_NOT_FOUND');
  const row = (await runner.query(
    `SELECT a.id, sp.id AS seller_profile_id, sp.user_id FROM auctions a JOIN seller_profiles sp ON sp.id = a.seller_id WHERE a.id = $1`,
    [auctionId])).rows[0];
  if (!row) throw fail(404, 'Auction not found.', 'AUCTION_NOT_FOUND');
  if (String(row.user_id) === String(actor && actor.id)) return row.seller_profile_id;
  if (!isAdmin) throw fail(403, 'You can only buy promotion for your own auction.', 'NOT_YOUR_AUCTION');
  await require('../lib/auditLog').writeAuditLog({ event_type: 'marketing_package.admin_override_purchase', entity_type: 'auction',
    entity_id: row.id, auction_id: row.id, actor_id: actor.id, metadata: { action, seller_profile_id: row.seller_profile_id } });
  return row.seller_profile_id;
}

function getStripe() { if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set'); return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION }); }
function appBase() { return (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, ''); }

// ── Checkout: PACKAGE (FEATURED/PREMIUM/SIGNATURE) ───────────────────────────────
// Dynamic price_data straight from the versioned registry (no per-package Stripe price id needed). Card
// only (prepaid). Identity + version travel in metadata so the webhook never infers identity from price.
async function createPackageCheckout(userId, { packageKey, auctionId, origin, actor = null }) {
  const key = String(packageKey || '').toLowerCase();
  if (registry.PAID_KEYS.indexOf(key) === -1) { const e = new Error('Only FEATURED/PREMIUM/SIGNATURE are purchasable'); e.status = 400; throw e; }
  const version = await registry.activeVersion(key);
  if (!version) { const e = new Error('No active version for package'); e.status = 409; throw e; }
  const deliverable = packageDeliverability(version);
  if (!deliverable.purchasable) throw fail(409, deliverable.reason, 'NOT_AVAILABLE');
  await assertAuctionAccess(actor || { id: userId, role: 'seller' }, auctionId, { action: 'package:' + key });
  const base = origin || appBase();
  const customerId = await cardService.ensureStripeCustomer(userId);
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer: customerId,
    client_reference_id: String(userId),
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: version.price_cents,
      product_data: { name: 'Advantage.Bid ' + version.seller_name + ' Marketing Package' } } }],
    success_url: `${base}/seller/marketing.html?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/seller/marketing.html?purchase=canceled`,
    metadata: { product_type: PKG, package_key: key, package_version: String(version.version), advantage_user_id: String(userId), auction_id: auctionId ? String(auctionId) : '' },
    payment_intent_data: { metadata: { product_type: PKG, package_key: key, advantage_user_id: String(userId) } },
  });
  await db.query(
    `INSERT INTO marketing_package_purchases
       (seller_user_id, auction_id, package_key, package_version, amount_paid_cents, seller_copy, guaranteed_deliverables,
        discretionary_tools, economic_policy_version, direct_fulfillment_bps, internal_authority_cents, status, stripe_checkout_session_id)
     VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,$6,0,0,'pending',$7)
     ON CONFLICT (stripe_checkout_session_id) DO NOTHING`,
    [userId, auctionId || null, key, version.version, version.price_cents, version.economic_policy_version, session.id]);
  return { url: session.url, id: session.id };
}

// ── Checkout: ADDITIONAL PROMOTION (BOOST/REACH/SPOTLIGHT/CUSTOM) ─────────────────
// CUSTOM is never priced by the buyer: the design is an admin-composed bundle, snapshotted and shown before payment
// (additionalPromotionExecutor.verifyPrepaidSnapshot). No such composition exists online, so CUSTOM is refused here,
// and a buyer-entered amount is never used for any promotion.
async function createAdditionalPromotionCheckout(userId, { promotionKey, auctionId, packagePurchaseId, customAmountCents, origin, actor = null }) {
  const key = String(promotionKey || '').toLowerCase();
  if (ADDL_KEYS.indexOf(key) === -1) { const e = new Error('Invalid promotion'); e.status = 400; throw e; }
  void customAmountCents;   // never trusted: prices come only from the admin-managed configuration
  const deliverable = promotionDeliverability(key);
  if (!deliverable.purchasable) throw fail(409, deliverable.reason, 'NOT_AVAILABLE');
  const who = actor || { id: userId, role: 'seller' };
  await assertAuctionAccess(who, auctionId, { action: 'promotion:' + key });
  if (packagePurchaseId) {
    if (!UUID.test(String(packagePurchaseId))) throw fail(404, 'Package purchase not found.', 'PURCHASE_NOT_FOUND');
    const pp = (await db.query('SELECT seller_user_id, auction_id FROM marketing_package_purchases WHERE id = $1', [packagePurchaseId])).rows[0];
    if (!pp || (who.role !== 'admin' && String(pp.seller_user_id) !== String(who.id))) throw fail(404, 'Package purchase not found.', 'PURCHASE_NOT_FOUND');
    if (auctionId && pp.auction_id && String(pp.auction_id) !== String(auctionId)) throw fail(400, 'That package purchase is for a different auction.', 'AUCTION_MISMATCH');
  }
  const amount = await marketingConfig.getInt('marketing.pkg.addl.' + key + '.price_cents', 0);
  if (!amount) { const e = new Error('No configured price for ' + key); e.status = 409; throw e; }
  const base = origin || appBase();
  const customerId = await cardService.ensureStripeCustomer(userId);
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment', payment_method_types: ['card'], customer: customerId, client_reference_id: String(userId),
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amount, product_data: { name: 'Advantage.Bid Additional Promotion: ' + key.toUpperCase() } } }],
    success_url: `${base}/seller/marketing.html?promo=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/seller/marketing.html?promo=canceled`,
    metadata: { product_type: ADDL, promotion_key: key, advantage_user_id: String(userId), auction_id: auctionId ? String(auctionId) : '', package_purchase_id: packagePurchaseId || '' },
    payment_intent_data: { metadata: { product_type: ADDL, promotion_key: key, advantage_user_id: String(userId) } },
  });
  await db.query(
    `INSERT INTO marketing_additional_promotions
       (promotion_key, seller_user_id, auction_id, package_purchase_id, amount_paid_cents, benefits, economic_policy_version, direct_fulfillment_bps, internal_authority_cents, status, stripe_checkout_session_id)
     VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,'v1',0,0,'pending',$6)
     ON CONFLICT (stripe_checkout_session_id) DO NOTHING`,
    [key, userId, auctionId || null, packagePurchaseId || null, amount, session.id]);
  return { url: session.url, id: session.id };
}

// ── Webhook: authoritative paid transition → immutable snapshot + obligations + plan + Owner SMS ──
async function handleCheckoutCompleted(session) {
  if (!session || session.mode !== 'payment') return;
  const pt = session.metadata && session.metadata.product_type;
  if (pt === PKG) return handlePackagePaid(session);
  if (pt === ADDL) return handleAdditionalPromotionPaid(session);
}

async function handlePackagePaid(session) {
  const paid = session.payment_status === 'paid' || session.status === 'complete';
  if (!paid) return { transitioned: false };
  const key = String(session.metadata.package_key || '').toLowerCase();
  const userId = session.metadata.advantage_user_id || session.client_reference_id || null;
  const auctionId = session.metadata.auction_id || null;

  // Resolve the version by IDENTITY (metadata), never by price. Freeze the snapshot fields.
  const version = await registry.activeVersion(key);
  const policy = await econ.resolveForPurchase(version ? version.economic_policy_version : 'v1');
  const amount = (session.amount_total != null) ? session.amount_total : (version ? version.price_cents : 0);
  const authority = econ.deriveAuthorityCents(amount, policy.direct_fulfillment_bps);

  const res = await withTransaction(async (client) => {
    const existing = (await client.query('SELECT id, status FROM marketing_package_purchases WHERE stripe_checkout_session_id = $1 FOR UPDATE', [session.id])).rows[0];
    if (existing && existing.status === 'paid') return { transitioned: false, purchaseId: existing.id };
    const snap = {
      seller_copy: { name: version && version.seller_name, description: version && version.seller_description, benefits: version && version.seller_benefits },
      guaranteed: (version && version.guaranteed_deliverables) || [],
      discretionary: (version && version.discretionary_tools) || [],
    };
    // Freeze the immutable snapshot (upsert-by-session; idempotent). Actual paid amount drives authority.
    const row = (await client.query(
      `INSERT INTO marketing_package_purchases
         (seller_user_id, auction_id, package_key, package_version, amount_paid_cents, seller_copy, guaranteed_deliverables,
          discretionary_tools, economic_policy_version, direct_fulfillment_bps, internal_authority_cents, status,
          stripe_checkout_session_id, stripe_payment_intent_id, purchased_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,'paid',$12,$13, now())
       ON CONFLICT (stripe_checkout_session_id) DO UPDATE SET
         status='paid', amount_paid_cents=EXCLUDED.amount_paid_cents, package_version=EXCLUDED.package_version,
         seller_copy=EXCLUDED.seller_copy, guaranteed_deliverables=EXCLUDED.guaranteed_deliverables,
         discretionary_tools=EXCLUDED.discretionary_tools, economic_policy_version=EXCLUDED.economic_policy_version,
         direct_fulfillment_bps=EXCLUDED.direct_fulfillment_bps, internal_authority_cents=EXCLUDED.internal_authority_cents,
         stripe_payment_intent_id=EXCLUDED.stripe_payment_intent_id, purchased_at=COALESCE(marketing_package_purchases.purchased_at, now())
       WHERE marketing_package_purchases.status <> 'paid'
       RETURNING id`,
      [userId, auctionId, key, version ? version.version : 1, amount, JSON.stringify(snap.seller_copy), JSON.stringify(snap.guaranteed),
       JSON.stringify(snap.discretionary), policy.policy_version, policy.direct_fulfillment_bps, authority,
       session.id, session.payment_intent || null])).rows[0];
    if (!row) return { transitioned: false, purchaseId: existing && existing.id };
    // Create obligations from the FROZEN snapshot (guaranteed + discretionary), within the same tx.
    const runner = { query: (...a) => client.query(...a) };
    await obligations.createFromSnapshot({ purchaseKind: 'package', purchaseId: row.id, auctionId, guaranteed: snap.guaranteed, discretionary: snap.discretionary }, runner);
    return { transitioned: true, purchaseId: row.id, amount, key };
  });

  if (res.transitioned && res.purchaseId) {
    // Marketing Director autonomously plans fulfillment (campaign + homepage + obligation advancement).
    director.planFulfillment({ purchaseKind: 'package', purchaseId: res.purchaseId, auctionId, campaignClass: 'seller' }).catch(() => {});
    // ONE Owner operational SMS on the authoritative paid purchase — ACTUAL identity + snapshotted amount.
    (async () => {
      try {
        const em = userId ? (await db.query('SELECT email, contact_email FROM users WHERE id = $1', [userId])).rows[0] : null;
        await ownerAlertService.notifyOwnerMarketingPackagePurchased({
          userId, purchaseId: res.purchaseId, packageName: (version && version.seller_name) || key,
          amountCents: res.amount, packageProductType: 'marketing_package_' + key,
        });
        if (em) { /* email surfaced by the notifier's own userId lookup */ }
      } catch (e) { console.error('[pkg-purchase] owner-alert failed:', e.message); }
    })().catch(() => {});
    analyticsService.insertEvent({ event_type: 'marketing_package_purchased', metadata: { package: key } }, null).catch(() => {});
  }
  return res;
}

async function handleAdditionalPromotionPaid(session) {
  const paid = session.payment_status === 'paid' || session.status === 'complete';
  if (!paid) return { transitioned: false };
  const key = String(session.metadata.promotion_key || '').toLowerCase();
  const userId = session.metadata.advantage_user_id || session.client_reference_id || null;
  const auctionId = session.metadata.auction_id || null;
  const packagePurchaseId = session.metadata.package_purchase_id || null;
  const policy = await econ.resolveForPurchase('v1');
  const amount = (session.amount_total != null) ? session.amount_total : 0;
  const authority = econ.deriveAuthorityCents(amount, policy.direct_fulfillment_bps);
  const benefits = [{ key: key, channel: 'paid', label: 'Additional Promotion: ' + key.toUpperCase() }];

  const res = await withTransaction(async (client) => {
    const existing = (await client.query('SELECT id, status FROM marketing_additional_promotions WHERE stripe_checkout_session_id = $1 FOR UPDATE', [session.id])).rows[0];
    if (existing && existing.status === 'paid') return { transitioned: false, purchaseId: existing.id };
    const row = (await client.query(
      `INSERT INTO marketing_additional_promotions
         (promotion_key, seller_user_id, auction_id, package_purchase_id, amount_paid_cents, benefits, economic_policy_version, direct_fulfillment_bps, internal_authority_cents, status, stripe_checkout_session_id, stripe_payment_intent_id, purchased_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'paid',$10,$11, now())
       ON CONFLICT (stripe_checkout_session_id) DO UPDATE SET status='paid', amount_paid_cents=EXCLUDED.amount_paid_cents,
         direct_fulfillment_bps=EXCLUDED.direct_fulfillment_bps, internal_authority_cents=EXCLUDED.internal_authority_cents,
         stripe_payment_intent_id=EXCLUDED.stripe_payment_intent_id
       WHERE marketing_additional_promotions.status <> 'paid'
       RETURNING id`,
      [key, userId, auctionId, packagePurchaseId, amount, JSON.stringify(benefits), policy.policy_version, policy.direct_fulfillment_bps, authority, session.id, session.payment_intent || null])).rows[0];
    if (!row) return { transitioned: false, purchaseId: existing && existing.id };
    const runner = { query: (...a) => client.query(...a) };
    await obligations.createFromSnapshot({ purchaseKind: 'additional_promotion', purchaseId: row.id, auctionId, guaranteed: benefits, discretionary: [] }, runner);
    return { transitioned: true, purchaseId: row.id, amount, key };
  });

  if (res.transitioned && res.purchaseId) {
    director.planFulfillment({ purchaseKind: 'additional_promotion', purchaseId: res.purchaseId, auctionId, campaignClass: 'seller' }).catch(() => {});
    ownerAlertService.notifyOwnerMarketingPackagePurchased({ userId, purchaseId: res.purchaseId, packageName: 'Additional Promotion: ' + key.toUpperCase(), amountCents: res.amount, packageProductType: 'additional_promotion_' + key }).catch(() => {});
  }
  return res;
}

module.exports = { createPackageCheckout, createAdditionalPromotionCheckout, handleCheckoutCompleted, handlePackagePaid, handleAdditionalPromotionPaid,
  packageDeliverability, promotionDeliverability, assertAuctionAccess, isUndeliverable, PKG, ADDL, ADDL_KEYS };
