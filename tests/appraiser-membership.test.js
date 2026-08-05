'use strict';

/**
 * Phase 2A — Railway-native Appraiser membership (Stripe TEST). Behavioral tests for the service's
 * pure logic + source-level assertions for wiring, security, copy, and reuse of existing
 * infrastructure (webhook pipeline, capability grants, idempotency, auth). No real Stripe/DB calls.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// Behavioral: the service's pure functions (no I/O).
process.env.STRIPE_APPRAISER_PRICE_ID = process.env.STRIPE_APPRAISER_PRICE_ID || 'price_test_appr';
const svc = require('../src/services/appraiserMembershipService');

describe('access policy (verified Stripe status → capability)', () => {
  test('active / trialing / past_due grant access; everything else does not', () => {
    ['active', 'trialing', 'past_due'].forEach((s) => expect(svc.membershipGrantsAccess(s)).toBe(true));
    ['pending', 'incomplete', 'incomplete_expired', 'unpaid', 'canceled', 'paused'].forEach(
      (s) => expect(svc.membershipGrantsAccess(s)).toBe(false));
  });
});

describe('mapSubscription', () => {
  const base = {
    id: 'sub_1', status: 'active', customer: 'cus_1', cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_test_appr' }, current_period_start: 1000, current_period_end: 2000 }] },
    metadata: { membership_type: 'appraiser' },
  };
  test('reads item-level current_period_* (new Stripe API shape)', () => {
    const m = svc.mapSubscription(base);
    expect(m.stripe_price_id).toBe('price_test_appr');
    expect(m.current_period_start).toBeInstanceOf(Date);
    expect(m.current_period_end).toBeInstanceOf(Date);
    expect(m.current_period_end.getTime()).toBe(2000 * 1000);
  });
  test('falls back to top-level period for legacy payloads', () => {
    const legacy = { id: 'sub_2', status: 'active', customer: 'c', cancel_at_period_end: false,
      current_period_start: 5, current_period_end: 9, items: { data: [{ price: { id: 'p' } }] } };
    expect(svc.mapSubscription(legacy).current_period_end.getTime()).toBe(9000);
  });
  test('isAppraiserSubscription matches by price OR metadata', () => {
    expect(svc.isAppraiserSubscription(base)).toBe(true); // price match
    expect(svc.isAppraiserSubscription({ items: { data: [{ price: { id: 'other' } }] }, metadata: { membership_type: 'appraiser' } })).toBe(true);
    expect(svc.isAppraiserSubscription({ items: { data: [{ price: { id: 'other' } }] }, metadata: {} })).toBe(false);
  });
});

describe('buildCheckoutSessionParams (server-selected price, subscription mode)', () => {
  const p = svc.buildCheckoutSessionParams({
    priceId: 'price_x', customerId: 'cus_x', userId: 'u1', orgId: 'o1', successUrl: 'S', cancelUrl: 'C',
  });
  test('subscription mode with the server price and internal ids', () => {
    expect(p.mode).toBe('subscription');
    expect(p.line_items[0].price).toBe('price_x');
    expect(p.line_items[0].quantity).toBe(1);
    expect(p.client_reference_id).toBe('u1');
    expect(p.metadata.advantage_user_id).toBe('u1');
    expect(p.metadata.membership_type).toBe('appraiser');
    expect(p.subscription_data.metadata.advantage_organization_id).toBe('o1');
    expect(p.success_url).toBe('S');
    expect(p.cancel_url).toBe('C');
  });
});

describe('publicView', () => {
  test('safe status projection', () => {
    expect(svc.publicView(null)).toEqual({ active: false, status: 'none' });
    const v = svc.publicView({ status: 'active', membership_type: 'appraiser', current_period_end: null, cancel_at_period_end: false, organization_id: 'o' });
    expect(v.active).toBe(true);
    expect(v.status).toBe('active');
  });
});

describe('security — price is server-side only', () => {
  const service = read('src', 'services', 'appraiserMembershipService.js');
  const route = read('src', 'routes', 'appraiser.js');
  test('price comes from STRIPE_APPRAISER_PRICE_ID env, never the client', () => {
    expect(service).toMatch(/process\.env\.STRIPE_APPRAISER_PRICE_ID/);
    expect(route).not.toMatch(/req\.body\.price|req\.body\.priceId|req\.body\.amount/);
    // no hardcoded price id anywhere in shipped source
    expect(read('src', 'services', 'appraiserMembershipService.js')).not.toMatch(/price_1[A-Za-z0-9]{10,}/);
  });
  test('checkout requires auth + reuses financial guards (strictLimiter + idempotency)', () => {
    expect(route).toMatch(/router\.use\(authMiddleware\)/);
    expect(route).toMatch(/'\/checkout-session', strictLimiter, idempotency/);
  });
  test('billing portal opens only the caller\'s own customer', () => {
    expect(service).toMatch(/createBillingPortalSession/);
    expect(service).toMatch(/billingPortal\.sessions\.create/);
  });
});

describe('webhook — reuses the existing signature-verified, idempotent pipeline', () => {
  const pay = read('src', 'services', 'paymentService.js');
  test('the shared dispatcher handles the subscription/checkout/invoice events', () => {
    ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated',
     'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'].forEach((t) => {
      expect(pay).toContain(t);
    });
    expect(pay).toMatch(/require\('\.\/appraiserMembershipService'\)/);
    expect(pay).toMatch(/handleCheckoutCompleted|handleSubscriptionEvent|handleInvoicePaid|handleInvoicePaymentFailed/);
  });
  test('no second webhook endpoint was created (reuses /api/payments/webhook)', () => {
    const route = read('src', 'routes', 'appraiser.js');
    expect(route).not.toMatch(/\.(post|get|use)\([^)]*webhook/i);
    expect(route).not.toMatch(/express\.raw|constructEvent/);
  });
});

describe('entitlement is additive via the capability system (never users.role)', () => {
  test('capability grant is transaction-aware and used by the membership service', () => {
    expect(read('src', 'services', 'capabilityService.js')).toMatch(/setCapability\(organizationId, capability, enabled, source = 'grant', runner\)/);
    const service = read('src', 'services', 'appraiserMembershipService.js');
    expect(service).toMatch(/capabilityService\.setCapability\(membership\.organization_id, CAPABILITY_KEY, grant, 'grant', client\)/);
    // membership attaches to user AND organization; never mutates users.role
    expect(service).toMatch(/organizationsService\.onboardOrganization/);
    expect(service).not.toMatch(/UPDATE users SET role/);
  });
});

describe('migration 103 — generic professional_memberships + appraiser capability', () => {
  const mig = read('db', 'migrations', '103_professional_memberships.sql');
  test('creates the billing table with Stripe subscription fields', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS professional_memberships/);
    ['stripe_customer_id', 'stripe_subscription_id', 'stripe_price_id', 'current_period_start',
     'current_period_end', 'cancel_at_period_end', 'status'].forEach((c) => expect(mig).toContain(c));
  });
  test('status CHECK mirrors Stripe (no conflicting second status system)', () => {
    expect(mig).toMatch(/CHECK \(status IN \('pending','incomplete','incomplete_expired','trialing','active','past_due','unpaid','canceled','paused'\)\)/);
  });
  test('generic + reusable (membership_type + capability_key) and one-per-user', () => {
    expect(mig).toMatch(/membership_type\s+TEXT NOT NULL DEFAULT 'appraiser'/);
    expect(mig).toMatch(/capability_key\s+TEXT NOT NULL DEFAULT 'appraiser' REFERENCES capabilities\(key\)/);
    expect(mig).toMatch(/UNIQUE INDEX IF NOT EXISTS ux_prof_memberships_user_type/);
    expect(mig).toMatch(/ON professional_memberships \(stripe_subscription_id\) WHERE stripe_subscription_id IS NOT NULL/);
  });
  test('catalogs the appraiser capability (additive, idempotent)', () => {
    expect(mig).toMatch(/INSERT INTO capabilities[\s\S]{0,120}'appraiser'[\s\S]{0,120}ON CONFLICT \(key\) DO NOTHING/);
  });
});

describe('setup script — guarded, idempotent, TEST-only', () => {
  const s = read('scripts', 'stripe', 'setup-appraiser-membership.js');
  test('aborts unless sk_test_ and searches by metadata before creating', () => {
    expect(s).toMatch(/startsWith\('sk_test_'\)/);
    expect(s).toMatch(/product_type === 'appraiser_membership'/);
    expect(s).toMatch(/unit_amount === UNIT_AMOUNT/);
  });
  test('$19.99 USD yearly, prints ids, never a secret', () => {
    expect(s).toMatch(/UNIT_AMOUNT = 1999/);
    expect(s).toMatch(/interval: INTERVAL/);
    expect(s).toMatch(/STRIPE_APPRAISER_PRICE_ID/);
    expect(s).not.toMatch(/console\.log[^\n]*sk_(test|live)_/);
  });
});

describe('pages — branded, noindex, correct CTA, no banned terms, no query-string trust', () => {
  const landing = read('public', 'appraiser-membership.html');
  const welcome = read('public', 'appraiser-welcome.html');
  test('both pages are noindex', () => {
    expect(landing).toMatch(/<meta name="robots" content="noindex, nofollow" \/>/);
    expect(welcome).toMatch(/<meta name="robots" content="noindex, nofollow" \/>/);
  });
  test('approved CTA + pricing/renewal/cancellation copy', () => {
    expect(landing).toContain('Start Appraiser Membership');
    expect(landing).toContain('$19.99');
    expect(landing).toMatch(/renews automatically each year/);
    expect(landing).toMatch(/cancel any time/i);
  });
  test('no AI/vendor terms in customer copy; no em dashes (comments excluded — they are not rendered)', () => {
    const stripComments = (s) => s
      .replace(/<!--[\s\S]*?-->/g, '')       // HTML comments
      .replace(/\/\*[\s\S]*?\*\//g, '')      // JS block comments
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // JS line comments (leave URLs like https:// intact)
    [landing, welcome].map(stripComments).forEach((p) => {
      expect(p).not.toMatch(/\bA\.?I\.?\b|Artificial Intelligence|OpenAI|GPT/);
      expect(p).not.toMatch(/Stripe|Cloudinary|Railway|Postmark/); // neutral payment language in rendered copy
      expect(p).not.toContain('—'); // em dash
    });
  });
  test('welcome page confirms via the authoritative API, not the query string', () => {
    expect(welcome).toMatch(/\/api\/appraiser\/membership/);
    expect(welcome).toMatch(/membership && d\.membership\.active/);
    expect(welcome).not.toMatch(/session_id.*active|\?success=1/);
  });
  test('analytics events fire (existing first-party system)', () => {
    expect(landing).toMatch(/appraiser_checkout_started/);
    expect(welcome).toMatch(/appraiser_membership_activated/);
  });
});

describe('routing / SEO gates', () => {
  test('welcome page is member-gated; landing page stays public for pricing', () => {
    const gate = read('src', 'middleware', 'htmlAuthGate.js');
    expect(gate).toMatch(/'\/appraiser-welcome\.html'/);
    expect(gate).not.toMatch(/'\/appraiser-membership\.html'/); // public entry (JS gates the CTA)
  });
  test('both pages disallowed in robots.txt (both crawler blocks)', () => {
    const robots = read('public', 'robots.txt');
    expect((robots.match(/Disallow: \/appraiser-membership\.html/g) || []).length).toBe(2);
    expect((robots.match(/Disallow: \/appraiser-welcome\.html/g) || []).length).toBe(2);
  });
  test('route mounted at /api/appraiser', () => {
    expect(read('server.js')).toMatch(/app\.use\('\/api\/appraiser', appraiserRoutes\)/);
  });
});

describe('regression — sibling surfaces + payment posture unaffected', () => {
  test('Dashboard Home, photo enlargement, map viewport, existing webhook events intact', () => {
    expect(read('public', 'widgets', 'shared', 'member-chrome.js')).toMatch(/Dashboard Home/);
    expect(read('public', 'event.html')).toMatch(/#lb \.lbimg\{[^}]*width:94vw;height:90vh/);
    expect(read('public', 'index.html')).toMatch(/map\.on\('moveend', scheduleDrawerRefresh\)/);
    const pay = read('src', 'services', 'paymentService.js');
    ['payment_intent.succeeded', 'charge.refunded'].forEach((t) => expect(pay).toContain(t));
  });
});
