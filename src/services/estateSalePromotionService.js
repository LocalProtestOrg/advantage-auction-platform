'use strict';

/**
 * estateSalePromotionService — Individual Estate Sale Promotion (Phase 2B, Stripe TEST).
 *
 * Homeowners buy a ONE-TIME $39 "Estate Sale Promotion" (not a membership/subscription). The purchase
 * is the required gate to submit ONE estate sale for review — the free events capability can never
 * bypass it (eventsService.submit blocks sale_type='estate_sale'; homeowners submit only through this
 * service, which consumes the promotion). Reuses: Stripe checkout + webhook, org onboarding, the event
 * editor/moderation, event pages, maps, analytics. Membership is derived ONLY from the verified webhook.
 *
 * Purchase lifecycle: pending → paid (webhook) → consumed (on submit; event_id links the sale). An
 * "available" promotion = status='paid' AND event_id IS NULL. Rejected sales resubmit for free (the
 * promotion stays consumed on the same event); a NEW sale needs a NEW promotion.
 */

const db = require('../db');
const Stripe = require('stripe');
const { withTransaction } = require('../utils/withTransaction');
const orgs = require('./organizationsService');
const eventsService = require('./eventsService');
const cardService = require('./cardService');
const auditService = require('./auditService');
const analyticsService = require('./analyticsService');
const emailService = require('./emailService');
const estateSaleEmails = require('./estateSaleEmails');

const STRIPE_API_VERSION = '2026-03-25.dahlia';
const PRODUCT_TYPE = 'estate_sale_promotion';

function getStripe() { if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set'); return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION }); }
function priceId() { const id = process.env.STRIPE_ESTATE_SALE_PRICE_ID; if (!id) throw new Error('STRIPE_ESTATE_SALE_PRICE_ID is not set'); return id; }
function appBase() { return (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, ''); }
function isEstateSalePromotion(session) { return !!(session && session.metadata && session.metadata.product_type === PRODUCT_TYPE); }

/** Checkout Session params (pure) — one-time payment, server-selected price, internal ids in metadata. */
function buildCheckoutSessionParams({ priceId: pid, customerId, userId, successUrl, cancelUrl }) {
  return {
    mode: 'payment',
    line_items: [{ price: pid, quantity: 1 }],
    customer: customerId,
    client_reference_id: String(userId),
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { product_type: PRODUCT_TYPE, advantage_user_id: String(userId) },
    payment_intent_data: { metadata: { product_type: PRODUCT_TYPE, advantage_user_id: String(userId) } },
  };
}

/** Ensure the customer has a Stripe customer + an organization (hidden from the homeowner UX). */
async function ensureContext(userId) {
  const customerId = await cardService.ensureStripeCustomer(userId);
  let org = await orgs.getPrimaryOrgForUser(userId);
  if (!org) {
    const u = (await db.query('SELECT email, full_name FROM users WHERE id = $1', [userId])).rows[0] || {};
    const base = (u.full_name && u.full_name.trim()) || (u.email ? u.email.split('@')[0] : '') || 'My Estate Sale';
    org = await orgs.onboardOrganization(userId, { name: base + ' Estate Sale', contactEmail: u.email || undefined });
  }
  return { customerId, orgId: org ? org.id : null };
}

// ── Checkout ───────────────────────────────────────────────────────────────
async function createCheckoutSession(userId, origin) {
  const base = origin || appBase();
  const { customerId, orgId } = await ensureContext(userId);
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create(buildCheckoutSessionParams({
    priceId: priceId(), customerId, userId,
    successUrl: `${base}/estate-sale-welcome.html?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/promote-estate-sale.html?canceled=1`,
  }));
  // Record a pending purchase keyed by the session (idempotent) so the dashboard + webhook can track it.
  await db.query(
    `INSERT INTO one_time_purchases (user_id, organization_id, product_type, status, stripe_customer_id, stripe_checkout_session_id, amount_cents, currency)
       VALUES ($1,$2,$3,'pending',$4,$5,3900,'usd')
     ON CONFLICT (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL DO NOTHING`,
    [userId, orgId, PRODUCT_TYPE, customerId, session.id]);
  analyticsService.insertEvent({ event_type: 'estate_sale_checkout_redirected', metadata: { product: PRODUCT_TYPE } }, null).catch(() => {});
  return { url: session.url, id: session.id };
}

// ── Webhook: mark the purchase paid (source of truth) ────────────────────────
async function handleCheckoutCompleted(session) {
  if (session.mode !== 'payment' || !isEstateSalePromotion(session)) return; // not ours
  const userId = (session.metadata && session.metadata.advantage_user_id) || session.client_reference_id || null;
  const paid = session.payment_status === 'paid' || session.status === 'complete';
  const res = await withTransaction(async (client) => {
    // Upsert-by-session so a duplicate delivery is idempotent, and a session created before the row
    // (edge) still records the paid purchase.
    const existing = (await client.query('SELECT id, status FROM one_time_purchases WHERE stripe_checkout_session_id = $1 FOR UPDATE', [session.id])).rows[0];
    if (existing) {
      if (existing.status === 'pending' && paid) {
        await client.query(
          `UPDATE one_time_purchases SET status='paid', paid_at=now(), stripe_payment_intent_id=$2, stripe_customer_id=$3, updated_at=now() WHERE id=$1`,
          [existing.id, session.payment_intent || null, (typeof session.customer === 'string' ? session.customer : null)]);
        return { transitioned: true, purchaseId: existing.id };
      }
      return { transitioned: false, purchaseId: existing.id };
    }
    if (userId && paid) {
      const ins = await client.query(
        `INSERT INTO one_time_purchases (user_id, product_type, status, stripe_customer_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents, currency, paid_at)
           VALUES ($1,$2,'paid',$3,$4,$5,COALESCE($6,3900),'usd', now()) RETURNING id`,
        [userId, PRODUCT_TYPE, (typeof session.customer === 'string' ? session.customer : null), session.id, session.payment_intent || null, session.amount_total || null]);
      return { transitioned: true, purchaseId: ins.rows[0].id };
    }
    return { transitioned: false, purchaseId: null };
  });
  if (res.transitioned && userId) {
    sendReceiptEmail(userId).catch(() => {});
    analyticsService.insertEvent({ event_type: 'estate_sale_promotion_activated', metadata: { product: PRODUCT_TYPE } }, null).catch(() => {});
  }
}

// ── Dashboard status ─────────────────────────────────────────────────────────
async function statusForUser(userId) {
  const avail = (await db.query(
    "SELECT count(*)::int n FROM one_time_purchases WHERE user_id=$1 AND product_type=$2 AND status='paid' AND event_id IS NULL",
    [userId, PRODUCT_TYPE])).rows[0].n;
  const org = await orgs.getPrimaryOrgForUser(userId);
  let sales = [];
  if (org) {
    sales = (await db.query(
      `SELECT id, slug, title, status, start_at, end_at, submitted_at, published_at, review_reason
         FROM events WHERE organization_id=$1 AND sale_type='estate_sale' ORDER BY created_at DESC`, [org.id])).rows;
  }
  return { available_promotions: avail, has_available: avail > 0, estate_sales: sales };
}

// ── Create the estate sale draft (reserves a paid promotion) ──────────────────
async function createEstateSale(userId, input) {
  const { orgId } = await ensureContext(userId);
  const org = await orgs.getById(orgId);
  // Require an available (paid, unconsumed) promotion BEFORE creating anything.
  const avail = (await db.query(
    "SELECT id FROM one_time_purchases WHERE user_id=$1 AND product_type=$2 AND status='paid' AND event_id IS NULL ORDER BY paid_at ASC LIMIT 1",
    [userId, PRODUCT_TYPE])).rows[0];
  if (!avail) { const e = new Error('An Estate Sale Promotion is required to create a listing.'); e.status = 402; e.code = 'PROMOTION_REQUIRED'; e.expose = true; throw e; }

  // The software does the thinking: always an estate sale, nationwide market by default.
  const event = await eventsService.createDraft(userId, org, {
    title: input.title, description: input.description, marketSlug: input.marketSlug || 'national',
    categorySlug: 'estate_sales', saleType: 'estate_sale',
    venueName: input.venueName, address: input.address, city: input.city, state: input.state, zip: input.zip,
    startAt: input.startAt, endAt: input.endAt, timezone: input.timezone, externalUrl: input.externalUrl,
  });
  // Reserve the promotion to this sale. If someone raced us (per-user, negligible), roll back the draft.
  const reserved = await db.query(
    "UPDATE one_time_purchases SET event_id=$1, updated_at=now() WHERE id=$2 AND event_id IS NULL RETURNING id", [event.id, avail.id]);
  if (!reserved.rowCount) {
    await eventsService.archiveByOwner(userId, event.id).catch(() => {});
    const e = new Error('An Estate Sale Promotion is required to create a listing.'); e.status = 402; e.code = 'PROMOTION_REQUIRED'; e.expose = true; throw e;
  }
  analyticsService.insertEvent({ event_type: 'estate_sale_created', metadata: { product: PRODUCT_TYPE } }, null).catch(() => {});
  return event;
}

// ── Submit for review (consumes the promotion; the paywall gate) ──────────────
async function submitEstateSale(userId, eventId) {
  const out = await withTransaction(async (client) => {
    const ev = (await client.query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0];
    if (!ev) throw orgs.svcErr(404, 'EVENT_NOT_FOUND', 'Estate sale not found.');
    await orgs.assertOwner(userId, ev.organization_id, client); // 403 if not the owner
    if (ev.sale_type !== 'estate_sale') throw orgs.svcErr(400, 'NOT_ESTATE_SALE', 'This listing is not an estate sale.');
    if (!['draft', 'rejected'].includes(ev.status)) throw orgs.svcErr(409, 'INVALID_TRANSITION', `Cannot submit from ${ev.status}.`);

    const promo = (await client.query('SELECT * FROM one_time_purchases WHERE event_id=$1 AND user_id=$2 FOR UPDATE', [eventId, userId])).rows[0];
    if (!promo || promo.status === 'refunded') { const e = new Error('An Estate Sale Promotion is required to submit this listing.'); e.status = 402; e.code = 'PROMOTION_REQUIRED'; e.expose = true; throw e; }
    if (promo.status === 'paid') { // consume once; a rejected→resubmit finds it already 'consumed' and skips
      await client.query("UPDATE one_time_purchases SET status='consumed', consumed_at=now(), updated_at=now() WHERE id=$1", [promo.id]);
    }
    const { rows } = await client.query(
      "UPDATE events SET status='submitted', submitted_at=now(), review_reason=NULL, updated_at=now() WHERE id=$1 RETURNING *", [eventId]);
    await auditService.logEvent(client, { eventType: 'event.submitted', entityType: 'event', entityId: eventId, actorId: userId, metadata: { via: 'estate_sale_promotion' } });
    return rows[0];
  });
  sendLifecycleEmail(userId, 'received').catch(() => {});
  analyticsService.insertEvent({ event_type: 'estate_sale_submitted', metadata: { product: PRODUCT_TYPE } }, null).catch(() => {});
  return out;
}

// ── Emails ────────────────────────────────────────────────────────────────
async function recipient(userId) { const u = (await db.query('SELECT email, contact_email FROM users WHERE id=$1', [userId])).rows[0]; return u && (u.contact_email || u.email); }
async function sendReceiptEmail(userId) { try { const to = await recipient(userId); if (!to) return; const m = estateSaleEmails.buildReceiptEmail(); await emailService.sendEmail({ to, ...m }); } catch (e) { console.error('[estate-sale] receipt email failed:', e.message); } }
async function sendLifecycleEmail(userId, kind, extra) {
  try { const to = await recipient(userId); if (!to) return;
    const m = kind === 'received' ? estateSaleEmails.buildReceivedEmail()
      : kind === 'published' ? estateSaleEmails.buildPublishedEmail(extra)
      : estateSaleEmails.buildNeedsChangesEmail(extra);
    await emailService.sendEmail({ to, ...m });
  } catch (e) { console.error('[estate-sale] lifecycle email failed:', e.message); }
}
/** Called by the admin moderation route for estate-sale events (publish / needs-changes). */
async function notifyModeration(event, kind, reason) {
  try {
    if (!event || event.sale_type !== 'estate_sale') return;
    const owner = await orgs.getOwner(event.organization_id); if (!owner) return;
    await sendLifecycleEmail(owner.id, kind, kind === 'published' ? { slug: event.slug, title: event.title } : { reason, title: event.title });
    analyticsService.insertEvent({ event_type: kind === 'published' ? 'estate_sale_published' : 'estate_sale_needs_changes', metadata: { product: PRODUCT_TYPE } }, null).catch(() => {});
  } catch (e) { console.error('[estate-sale] moderation notify failed:', e.message); }
}

module.exports = {
  PRODUCT_TYPE, isEstateSalePromotion, buildCheckoutSessionParams, ensureContext,
  createCheckoutSession, handleCheckoutCompleted, statusForUser, createEstateSale, submitEstateSale, notifyModeration,
};
