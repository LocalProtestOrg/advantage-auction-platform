'use strict';

/**
 * Phase 2B — Individual Estate Sale Promotion ($39 one-time, Stripe TEST). Behavioral tests for the
 * service's pure logic + source-level assertions for gating, webhook routing, moderation emails,
 * customer language, and SEO. No real Stripe/DB/network.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.STRIPE_ESTATE_SALE_PRICE_ID = process.env.STRIPE_ESTATE_SALE_PRICE_ID || 'price_test_es';
const svc = require('../src/services/estateSalePromotionService');

describe('service — one-time checkout config', () => {
  test('builds a one-time (mode:payment) session with server price + internal ids', () => {
    const p = svc.buildCheckoutSessionParams({ priceId: 'price_x', customerId: 'c', userId: 'u1', successUrl: 'S', cancelUrl: 'C' });
    expect(p.mode).toBe('payment');
    expect(p.line_items[0].price).toBe('price_x');
    expect(p.client_reference_id).toBe('u1');
    expect(p.metadata.product_type).toBe('estate_sale_promotion');
    expect(p.metadata.advantage_user_id).toBe('u1');
    expect(p.payment_intent_data.metadata.product_type).toBe('estate_sale_promotion');
    expect(p.success_url).toBe('S');
    expect(p.cancel_url).toBe('C');
  });
  test('isEstateSalePromotion keys on metadata.product_type', () => {
    expect(svc.isEstateSalePromotion({ metadata: { product_type: 'estate_sale_promotion' } })).toBe(true);
    expect(svc.isEstateSalePromotion({ metadata: { product_type: 'appraiser_membership' } })).toBe(false);
    expect(svc.isEstateSalePromotion({})).toBe(false);
  });
});

describe('migration 105 — generic one-time purchase + nationwide market', () => {
  const mig = read('db', 'migrations', '105_one_time_purchases.sql');
  test('creates one_time_purchases with Stripe + consumption columns (generic product_type)', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS one_time_purchases/);
    ['product_type', 'status', 'stripe_checkout_session_id', 'stripe_payment_intent_id', 'event_id', 'consumed_at']
      .forEach((c) => expect(mig).toContain(c));
    expect(mig).toMatch(/CHECK \(status IN \('pending','paid','consumed','refunded'\)\)/);
    expect(mig).toMatch(/ux_one_time_purchases_session/);
  });
  test('seeds a nationwide market (idempotent) and never mutates rows', () => {
    expect(mig).toMatch(/INSERT INTO event_markets .*'national'.*ON CONFLICT \(slug\) DO NOTHING/s);
    const sql = mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/DROP |DELETE |ALTER COLUMN|users\.role/);
  });
});

describe('gating — the $39 promotion is the required, non-bypassable gate', () => {
  const events = read('src', 'services', 'eventsService.js');
  const service = read('src', 'services', 'estateSalePromotionService.js');
  test('estate sales via the free organizer path are gated to professional orgs (individuals still need the $39 promotion)', () => {
    // Owner decision: a PROFESSIONAL org may post its own estate sales free; a non-professional org/individual
    // is still routed to the paid $39 Estate Sale Promotion. Event type is not a proxy for account type.
    expect(events).toMatch(/ev\.sale_type === 'estate_sale' && !AUTO_PUBLISH_ORG_TYPES\.has\(orgType\)/);
    expect(events).toMatch(/ESTATE_SALE_PROMOTION_REQUIRED/);
  });
  test('createDraft sets sale_type only from the server (never asked of the customer)', () => {
    expect(events).toMatch(/saleType === 'estate_sale' \? 'estate_sale'/);
  });
  test('creating a listing requires a paid, unconsumed promotion; submit consumes it', () => {
    expect(service).toMatch(/status='paid' AND event_id IS NULL/);
    expect(service).toMatch(/PROMOTION_REQUIRED/);
    expect(service).toMatch(/UPDATE one_time_purchases SET status='consumed'/);
    // resubmit after rejection: already-consumed promotion is reused (no new charge)
    expect(service).toMatch(/if \(promo\.status === 'paid'\)/);
    // ON CONFLICT must match the PARTIAL unique index (predicate required, or Postgres errors)
    expect(service).toMatch(/ON CONFLICT \(stripe_checkout_session_id\) WHERE stripe_checkout_session_id IS NOT NULL DO NOTHING/);
  });
  test('membership is derived only from the verified webhook (never the success redirect)', () => {
    expect(service).toMatch(/function handleCheckoutCompleted/);
    expect(service).toMatch(/session\.mode !== 'payment' \|\| !isEstateSalePromotion/);
  });
});

describe('webhook — routed by product_type through the shared idempotent pipeline', () => {
  const pay = read('src', 'services', 'paymentService.js');
  test('checkout.session.completed routes estate_sale_promotion to its handler', () => {
    expect(pay).toMatch(/productType === 'estate_sale_promotion'/);
    expect(pay).toMatch(/require\('\.\/estateSalePromotionService'\)\.handleCheckoutCompleted/);
  });
  test('no second webhook endpoint (reuses /api/payments/webhook)', () => {
    const route = read('src', 'routes', 'estateSale.js');
    expect(route).not.toMatch(/\.(post|use)\([^)]*webhook|express\.raw|constructEvent/);
  });
});

describe('route + moderation wiring', () => {
  const route = read('src', 'routes', 'estateSale.js');
  const admin = read('src', 'routes', 'adminEvents.js');
  test('endpoints are auth-gated; checkout uses financial guards + server price', () => {
    expect(route).toMatch(/router\.use\(authMiddleware\)/);
    expect(route).toMatch(/'\/checkout-session', strictLimiter, idempotency/);
    expect(route).not.toMatch(/req\.body\.price|req\.body\.amount/);
    expect(route).toMatch(/STRIPE_ESTATE_SALE_PRICE_ID/);
    expect(read('server.js')).toMatch(/app\.use\('\/api\/estate-sale', estateSaleRoutes\)/);
  });
  test('admin publish/reject notify the homeowner (estate-sale events only)', () => {
    expect(admin).toMatch(/notifyModeration\(ev, 'published'\)/);
    expect(admin).toMatch(/notifyModeration\(ev, 'needs_changes'/);
    expect(read('src', 'services', 'estateSalePromotionService.js')).toMatch(/event\.sale_type !== 'estate_sale'\) return/);
  });
});

describe('emails — lifecycle exists for estate sales (none existed before)', () => {
  const em = read('src', 'services', 'estateSaleEmails.js');
  test('receipt, received, published, and needs-changes builders exist', () => {
    ['buildReceiptEmail', 'buildReceivedEmail', 'buildPublishedEmail', 'buildNeedsChangesEmail'].forEach((f) => expect(em).toContain(f));
    expect(em).toMatch(/no additional charge to resubmit/i); // rejected → resubmit is free
    const emNoComments = em.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(emNoComments).not.toContain('—'); // no em dash in rendered customer copy
  });
});

describe('customer pages — simple language, correct SEO/gating', () => {
  const landing = read('public', 'promote-estate-sale.html');
  const welcome = read('public', 'estate-sale-welcome.html');
  const create = read('public', 'create-estate-sale.html');
  const dash = read('public', 'my-estate-sales.html');
  const robots = read('public', 'robots.txt');
  const gate = read('src', 'middleware', 'htmlAuthGate.js');

  test('landing is public + indexable with the $39 offer + JSON-LD', () => {
    expect(landing).not.toMatch(/name="robots" content="noindex/);
    expect(landing).toContain('$39');
    expect(landing).toMatch(/Promote My Estate Sale/);
    expect(landing).toMatch(/application\/ld\+json/);
    expect(landing).toMatch(/"price":"39\.00"/);
    expect(landing).toMatch(/No subscription\. No membership\./);
  });
  test('welcome / create / dashboard are noindex, robots-disallowed, and member-gated', () => {
    [welcome, create, dash].forEach((p) => expect(p).toMatch(/name="robots" content="noindex, nofollow"/));
    ['/estate-sale-welcome.html', '/create-estate-sale.html', '/my-estate-sales.html'].forEach((u) => {
      expect((robots.match(new RegExp('Disallow: ' + u.replace(/[/.]/g, '\\$&'), 'g')) || []).length).toBe(2);
      expect(gate).toContain("'" + u + "'");
    });
    expect(gate).not.toMatch(/'\/promote-estate-sale\.html'/); // landing stays public
  });
  test('never exposes internal concepts (credit / entitlement / capability / customer organization)', () => {
    [welcome, create, dash].forEach((p) => expect(p).not.toMatch(/\bcredit\b|\bentitlement\b|\bcapability\b|\borganization\b/i));
    // landing: the only "Organization" is the schema.org provider type, not the customer's org
    const landingNoLd = landing.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
    expect(landingNoLd).not.toMatch(/\bcredit\b|\bentitlement\b|\bcapability\b|\borganization\b/i);
  });
  test('success page uses approved wording and confirms via the API (not the query string)', () => {
    expect(welcome).toMatch(/You’re all set!/);
    expect(welcome).toMatch(/Your Estate Sale Promotion has been activated/);
    expect(welcome).toMatch(/Create Your Estate Sale/);
    expect(welcome).toMatch(/\/api\/estate-sale\/promotion/);
    expect(welcome).not.toMatch(/session_id.*activated|\?success=1/);
  });
  test('dashboard card is action-oriented (Ready to Use + Create Your Estate Sale)', () => {
    expect(dash).toMatch(/Ready to Use/);
    expect(dash).toMatch(/Estate Sale Promotion/);
    expect(dash).toMatch(/Create Your Estate Sale/);
    expect(dash).not.toMatch(/Purchased and ready/);
  });
  test('landing CTA stays "Promote My Estate Sale" and auto-continues after sign-in', () => {
    expect((landing.match(/Promote My Estate Sale/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(landing).toMatch(/sessionStorage\.setItem\('es_intent','1'\)/);
    expect(landing).toMatch(/sessionStorage\.getItem\('es_intent'\)\)\{ sessionStorage\.removeItem\('es_intent'\); start\(\)/);
  });
});

describe('scope guard — professional + billing paths unaffected', () => {
  test('appraiser membership + auctions untouched; professional (non-estate) events still submit', () => {
    // the submit guard only blocks sale_type='estate_sale'; NULL/auction pass through unchanged
    const events = read('src', 'services', 'eventsService.js');
    expect(events).toMatch(/const plan = await getPlanForOrg\(client, ev\.organization_id\)/); // normal path intact
    expect(read('src', 'services', 'appraiserMembershipService.js')).not.toMatch(/estate_sale_promotion/);
  });
});
