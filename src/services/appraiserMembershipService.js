'use strict';

/**
 * appraiserMembershipService — Railway-native Appraiser membership (Phase 2A), Stripe TEST.
 *
 * Membership is derived ONLY from verified Stripe webhooks (never a client success redirect).
 * BILLING lives in professional_memberships (this service). ACCESS is granted through the existing
 * additive capability system (organization_capabilities via capabilityService) — the paying user
 * stays their org's owner and keeps every buyer/seller/admin right; admins bypass capability checks.
 * The model is generic (membership_type + capability_key) so future professional memberships reuse it.
 *
 * Access policy (documented):
 *   active | trialing            → capability GRANTED (full access)
 *   past_due                     → capability GRANTED (grace while Stripe retries; payment-failed email)
 *   unpaid | canceled | paused | incomplete | incomplete_expired | pending → capability REVOKED
 *   cancel_at_period_end=true with status still active → access remains until Stripe ends it
 *     (Stripe keeps status 'active' until period end, then emits subscription.deleted → canceled → revoke)
 */

const db = require('../db');
const Stripe = require('stripe');
const { withTransaction } = require('../utils/withTransaction');
const capabilityService = require('./capabilityService');
const organizationsService = require('./organizationsService');
const cardService = require('./cardService');
const auditService = require('./auditService');
const analyticsService = require('./analyticsService');
const emailService = require('./emailService');
const appraiserEmails = require('./appraiserEmails');

const STRIPE_API_VERSION = '2026-03-25.dahlia'; // matches paymentService pin
const MEMBERSHIP_TYPE = 'appraiser';
const CAPABILITY_KEY = 'appraiser';
const ACCESS_STATUSES = new Set(['active', 'trialing', 'past_due']);

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}
function priceId() {
  const id = process.env.STRIPE_APPRAISER_PRICE_ID;
  if (!id) throw new Error('STRIPE_APPRAISER_PRICE_ID is not set');
  return id;
}
function appBase() { return (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, ''); }

// ── Pure helpers (no I/O — unit-testable) ──────────────────────────────────────
function membershipGrantsAccess(status) { return ACCESS_STATUSES.has(status); }

function tsToDate(sec) { return sec ? new Date(sec * 1000) : null; }

/** Extract the price id from a Stripe subscription. */
function subscriptionPriceId(sub) {
  try { return (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id) || null; }
  catch (_) { return null; }
}

/**
 * Billing period. Newer Stripe API versions (our pin) moved current_period_start/end from the
 * subscription top-level onto the subscription ITEM, so read the item first and fall back to the
 * legacy top-level for older payloads.
 */
function subscriptionPeriod(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const start = (item && item.current_period_start != null) ? item.current_period_start : sub.current_period_start;
  const end = (item && item.current_period_end != null) ? item.current_period_end : sub.current_period_end;
  return { start: tsToDate(start), end: tsToDate(end) };
}

/** Is this Stripe subscription an Appraiser membership? (price match or metadata) */
function isAppraiserSubscription(sub) {
  if (!sub) return false;
  if (subscriptionPriceId(sub) === process.env.STRIPE_APPRAISER_PRICE_ID) return true;
  const mt = sub.metadata && sub.metadata.membership_type;
  return mt === MEMBERSHIP_TYPE;
}

/** Normalize a Stripe subscription into our membership columns. */
function mapSubscription(sub) {
  const period = subscriptionPeriod(sub);
  return {
    status: sub.status,
    stripe_subscription_id: sub.id,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null,
    stripe_price_id: subscriptionPriceId(sub),
    current_period_start: period.start,
    current_period_end: period.end,
    cancel_at_period_end: !!sub.cancel_at_period_end,
  };
}

/** Checkout Session params (pure) — subscription mode, server-selected price, internal ids in metadata. */
function buildCheckoutSessionParams({ priceId: pid, customerId, userId, orgId, successUrl, cancelUrl }) {
  return {
    mode: 'subscription',
    line_items: [{ price: pid, quantity: 1 }],
    customer: customerId,
    client_reference_id: String(userId),
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      product_type: 'appraiser_membership',
      membership_type: MEMBERSHIP_TYPE,
      advantage_user_id: String(userId),
      advantage_organization_id: orgId ? String(orgId) : '',
    },
    subscription_data: {
      metadata: {
        membership_type: MEMBERSHIP_TYPE,
        advantage_user_id: String(userId),
        advantage_organization_id: orgId ? String(orgId) : '',
      },
    },
  };
}

// ── DB reads ────────────────────────────────────────────────────────────────
async function getForUser(userId) {
  const { rows } = await db.query(
    'SELECT * FROM professional_memberships WHERE user_id = $1 AND membership_type = $2 LIMIT 1',
    [userId, MEMBERSHIP_TYPE]);
  return rows[0] || null;
}
async function getBySubscriptionId(subId) {
  const { rows } = await db.query('SELECT * FROM professional_memberships WHERE stripe_subscription_id = $1 LIMIT 1', [subId]);
  return rows[0] || null;
}
async function getByCustomerId(custId) {
  const { rows } = await db.query(
    'SELECT * FROM professional_memberships WHERE stripe_customer_id = $1 AND membership_type = $2 LIMIT 1',
    [custId, MEMBERSHIP_TYPE]);
  return rows[0] || null;
}

/** Public-safe membership view for the account/welcome UI. */
function publicView(m) {
  if (!m) return { active: false, status: 'none' };
  return {
    active: membershipGrantsAccess(m.status),
    status: m.status,
    membership_type: m.membership_type,
    current_period_end: m.current_period_end,
    cancel_at_period_end: m.cancel_at_period_end,
    organization_id: m.organization_id,
  };
}

// ── Context: ensure the paying user has a Stripe customer + an organization ────
async function ensureContext(userId) {
  const customerId = await cardService.ensureStripeCustomer(userId); // reuse the existing customer per user
  let org = await organizationsService.getPrimaryOrgForUser(userId);
  if (!org) {
    const u = (await db.query('SELECT email, full_name FROM users WHERE id = $1', [userId])).rows[0] || {};
    const name = (u.full_name && u.full_name.trim())
      || (u.email ? u.email.split('@')[0] : '')
      || 'My Appraisal Practice';
    // Reuse the existing organization onboarding workflow (owner membership + plan caps + audit).
    org = await organizationsService.onboardOrganization(userId, { name, contactEmail: u.email || undefined });
  }
  return { customerId, orgId: org ? org.id : null };
}

// ── Checkout + billing portal ─────────────────────────────────────────────────
async function createCheckoutSession(userId, origin) {
  const base = origin || appBase();
  const { customerId, orgId } = await ensureContext(userId);
  const stripe = getStripe();
  const params = buildCheckoutSessionParams({
    priceId: priceId(),
    customerId,
    userId,
    orgId,
    successUrl: `${base}/appraiser-welcome.html?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/appraiser-membership.html?canceled=1`,
  });
  const session = await stripe.checkout.sessions.create(params);
  analyticsService.insertEvent(
    { event_type: 'appraiser_checkout_redirected', metadata: { membership_type: MEMBERSHIP_TYPE } },
    null).catch(() => {});
  return { url: session.url, id: session.id };
}

async function createBillingPortalSession(userId, origin) {
  const base = origin || appBase();
  const m = await getForUser(userId);
  const customerId = (m && m.stripe_customer_id)
    || (await db.query('SELECT stripe_customer_id FROM users WHERE id = $1', [userId])).rows[0]?.stripe_customer_id;
  if (!customerId) { const e = new Error('No billing account found for this user.'); e.status = 404; e.code = 'NO_CUSTOMER'; throw e; }
  const stripe = getStripe();
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${base}/appraiser-membership.html`,
  });
  return { url: portal.url };
}

// ── Core upsert (billing row + capability grant/revoke) ────────────────────────
/**
 * Write membership state from a verified Stripe subscription and reconcile the capability.
 * Returns { membership, transitionedToActive, wasActive }.
 */
async function upsertFromSubscription(sub, ids = {}) {
  const mapped = mapSubscription(sub);
  const userId = ids.userId;
  if (!userId) throw new Error('upsertFromSubscription requires a resolved userId');
  let orgId = ids.orgId || null;

  return withTransaction(async (client) => {
    // Ensure an org exists to own the capability (self-heal if metadata lacked one).
    if (!orgId) {
      const existing = await client.query(
        'SELECT organization_id FROM professional_memberships WHERE user_id = $1 AND membership_type = $2',
        [userId, MEMBERSHIP_TYPE]);
      orgId = existing.rows[0] && existing.rows[0].organization_id;
    }

    const before = await client.query(
      'SELECT status FROM professional_memberships WHERE user_id = $1 AND membership_type = $2',
      [userId, MEMBERSHIP_TYPE]);
    const wasActive = before.rows[0] ? membershipGrantsAccess(before.rows[0].status) : false;

    const { rows } = await client.query(
      `INSERT INTO professional_memberships
         (user_id, organization_id, membership_type, capability_key, status,
          stripe_customer_id, stripe_subscription_id, stripe_price_id,
          current_period_start, current_period_end, cancel_at_period_end, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (user_id, membership_type) DO UPDATE SET
         organization_id        = COALESCE(professional_memberships.organization_id, EXCLUDED.organization_id),
         status                 = EXCLUDED.status,
         stripe_customer_id     = EXCLUDED.stripe_customer_id,
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         stripe_price_id        = EXCLUDED.stripe_price_id,
         current_period_start   = EXCLUDED.current_period_start,
         current_period_end     = EXCLUDED.current_period_end,
         cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
         updated_at             = now()
       RETURNING *`,
      [userId, orgId, MEMBERSHIP_TYPE, CAPABILITY_KEY, mapped.status,
       mapped.stripe_customer_id, mapped.stripe_subscription_id, mapped.stripe_price_id,
       mapped.current_period_start, mapped.current_period_end, mapped.cancel_at_period_end]);
    const membership = rows[0];

    // Reconcile the capability grant with verified status (additive; never touches users.role).
    const grant = membershipGrantsAccess(mapped.status);
    if (membership.organization_id) {
      await capabilityService.setCapability(membership.organization_id, CAPABILITY_KEY, grant, 'grant', client);
    }

    await auditService.logEvent(client, {
      eventType: 'appraiser_membership.updated',
      entityType: 'professional_membership', entityId: membership.id,
      actorId: userId,
      metadata: {
        status: mapped.status, cancel_at_period_end: mapped.cancel_at_period_end,
        access: grant, subscription_id: mapped.stripe_subscription_id, price_id: mapped.stripe_price_id,
      },
    });

    const transitionedToActive = !wasActive && grant && mapped.status !== 'past_due';
    return { membership, transitionedToActive, wasActive };
  });
}

// ── Identity resolution for webhook objects ────────────────────────────────────
async function resolveIdentity({ metadata, customerId, subscriptionId, clientReferenceId }) {
  let userId = (metadata && metadata.advantage_user_id) || clientReferenceId || null;
  let orgId = (metadata && metadata.advantage_organization_id) || null;
  if (userId) return { userId, orgId: orgId || null };

  // Fall back to an existing membership row (by subscription, then customer).
  let m = subscriptionId ? await getBySubscriptionId(subscriptionId) : null;
  if (!m && customerId) m = await getByCustomerId(customerId);
  if (m) return { userId: m.user_id, orgId: m.organization_id };

  // Last resort: match the Stripe customer to a user.
  if (customerId) {
    const { rows } = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1 LIMIT 1', [customerId]);
    if (rows[0]) return { userId: rows[0].id, orgId: null };
  }
  return { userId: null, orgId: null };
}

async function sendActivatedEmail(userId) {
  try {
    const u = (await db.query('SELECT email, contact_email FROM users WHERE id = $1', [userId])).rows[0];
    const to = u && (u.contact_email || u.email);
    if (!to) return;
    const { subject, html, text } = appraiserEmails.buildActivatedEmail();
    await emailService.sendEmail({ to, subject, html, text });
  } catch (e) { console.error('[appraiser] activated email failed:', e.message); }
}
async function sendPaymentFailedEmail(userId) {
  try {
    const u = (await db.query('SELECT email, contact_email FROM users WHERE id = $1', [userId])).rows[0];
    const to = u && (u.contact_email || u.email);
    if (!to) return;
    const { subject, html, text } = appraiserEmails.buildPaymentFailedEmail();
    await emailService.sendEmail({ to, subject, html, text });
  } catch (e) { console.error('[appraiser] payment-failed email failed:', e.message); }
}

// ── Webhook handlers (called from paymentService dispatcher; idempotent) ───────
async function handleCheckoutCompleted(session) {
  if (session.mode !== 'subscription') return; // not ours
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(session.subscription);
  if (!isAppraiserSubscription(sub)) return; // some other future subscription product
  const { userId, orgId } = await resolveIdentity({
    metadata: session.metadata, customerId: session.customer,
    subscriptionId: session.subscription, clientReferenceId: session.client_reference_id,
  });
  if (!userId) { console.warn('[appraiser] checkout.session.completed unresolved user', session.id); return; }
  const { transitionedToActive } = await upsertFromSubscription(sub, { userId, orgId });
  if (transitionedToActive) {
    await sendActivatedEmail(userId);
    analyticsService.insertEvent({ event_type: 'appraiser_membership_activated', metadata: { membership_type: MEMBERSHIP_TYPE } }, null).catch(() => {});
  }
}

async function handleSubscriptionEvent(sub, eventType) {
  if (!isAppraiserSubscription(sub)) return;
  const { userId, orgId } = await resolveIdentity({
    metadata: sub.metadata, customerId: sub.customer, subscriptionId: sub.id,
  });
  if (!userId) { console.warn('[appraiser] subscription event unresolved user', sub.id, eventType); return; }
  const { transitionedToActive, membership } = await upsertFromSubscription(sub, { userId, orgId });
  if (transitionedToActive) {
    await sendActivatedEmail(userId);
    analyticsService.insertEvent({ event_type: 'appraiser_membership_activated', metadata: { membership_type: MEMBERSHIP_TYPE } }, null).catch(() => {});
  }
  if (eventType === 'customer.subscription.deleted' || (sub.cancel_at_period_end && sub.status === 'active')) {
    try {
      const endStr = membership && membership.current_period_end ? new Date(membership.current_period_end).toDateString() : '';
      const { subject, html, text } = appraiserEmails.buildCanceledEmail(sub.cancel_at_period_end ? endStr : '');
      const u = (await db.query('SELECT email, contact_email FROM users WHERE id = $1', [userId])).rows[0];
      const to = u && (u.contact_email || u.email);
      if (to) await emailService.sendEmail({ to, subject, html, text });
    } catch (e) { console.error('[appraiser] cancel email failed:', e.message); }
  }
}

async function handleInvoicePaid(invoice) {
  if (!invoice.subscription) return;
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(invoice.subscription);
  if (!isAppraiserSubscription(sub)) return;
  const { userId, orgId } = await resolveIdentity({ metadata: sub.metadata, customerId: sub.customer, subscriptionId: sub.id });
  if (!userId) return;
  await upsertFromSubscription(sub, { userId, orgId }); // refreshes period on renewal
}

async function handleInvoicePaymentFailed(invoice) {
  if (!invoice.subscription) return;
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(invoice.subscription);
  if (!isAppraiserSubscription(sub)) return;
  const { userId, orgId } = await resolveIdentity({ metadata: sub.metadata, customerId: sub.customer, subscriptionId: sub.id });
  if (!userId) return;
  await upsertFromSubscription(sub, { userId, orgId }); // status likely past_due/unpaid
  await sendPaymentFailedEmail(userId);
}

module.exports = {
  // constants / policy
  MEMBERSHIP_TYPE, CAPABILITY_KEY, membershipGrantsAccess,
  // pure helpers
  mapSubscription, subscriptionPriceId, isAppraiserSubscription, buildCheckoutSessionParams, publicView,
  // reads
  getForUser, getBySubscriptionId, getByCustomerId, ensureContext, resolveIdentity,
  // actions
  createCheckoutSession, createBillingPortalSession, upsertFromSubscription,
  // webhook handlers
  handleCheckoutCompleted, handleSubscriptionEvent, handleInvoicePaid, handleInvoicePaymentFailed,
};
