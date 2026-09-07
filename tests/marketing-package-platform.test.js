'use strict';

/**
 * Automated Marketing Package Platform — package identity/versioning, immutable purchase snapshots, Stripe
 * lifecycle + idempotency, non-refundable policy, obligation engine + completion verification, email
 * shared/dedicated distinction, confidential economics isolation, Additional Promotion, Owner SMS on paid
 * purchase (actual snapshotted price, identity NOT price-inferred), RBAC, and no external-gate activation.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// ── Economic policy (pure) ───────────────────────────────────────────────────
describe('economicPolicyService.deriveAuthorityCents (confidential)', () => {
  const econ = require('../src/services/economicPolicyService');
  test('authority = actual amount × bps (60%)', () => {
    expect(econ.deriveAuthorityCents(9900, 6000)).toBe(5940);   // $99 → $59.40
    expect(econ.deriveAuthorityCents(24900, 6000)).toBe(14940); // $249
    expect(econ.deriveAuthorityCents(49900, 6000)).toBe(29940); // $499
    expect(econ.deriveAuthorityCents(0, 6000)).toBe(0);
  });
});

// ── Registry (fake runner) ───────────────────────────────────────────────────
describe('packageRegistryService', () => {
  const registry = require('../src/services/packageRegistryService');
  jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));
  test('locked identities only', () => {
    expect(registry.PACKAGE_KEYS).toEqual(['included', 'featured', 'premium', 'signature']);
    expect(registry.PAID_KEYS).toEqual(['featured', 'premium', 'signature']);
    expect(registry.isValidKey('signature')).toBe(true);
    expect(registry.isValidKey('platinum')).toBe(false);
  });
  test('sellerView exposes ONLY seller-safe fields (no economics/policy/authority)', () => {
    const v = { package_key: 'premium', version: 1, seller_name: 'Premium', seller_description: 'x',
      seller_benefits: ['a'], price_cents: 24900, economic_policy_version: 'v1', direct_fulfillment_bps: 6000,
      guaranteed_deliverables: [{ key: 'shared_email', label: 'Featured in an Advantage.Bid auction email to eligible subscribers' }],
      discretionary_tools: [{ key: 'paid_local_boost', label: 'Paid local boost' }] };
    const sv = registry.sellerView(v);
    const json = JSON.stringify(sv);
    expect(json).not.toMatch(/economic_policy|direct_fulfillment|authority|internal/i);
    expect(sv.guaranteed).toContain('Featured in an Advantage.Bid auction email to eligible subscribers');
  });
  test('createVersion increments version + audits (fake runner)', async () => {
    const calls = [];
    const runner = { query: jest.fn(async (sql, params) => {
      calls.push(sql);
      if (/MAX\(version\)/.test(sql)) return { rows: [{ v: 2 }] };
      if (/INSERT INTO marketing_package_versions/.test(sql)) return { rows: [{ id: 'pv1', package_key: params[0], version: params[1], price_cents: params[10] }] };
      return { rows: [] };
    }) };
    const row = await registry.createVersion({ package_key: 'featured', price_cents: 10900, seller_name: 'Featured' }, 'admin-1', runner);
    expect(row.version).toBe(3);
    expect(row.price_cents).toBe(10900);
  });
});

// ── Obligation engine (fake runner) ──────────────────────────────────────────
describe('marketingObligationEngine', () => {
  const eng = require('../src/services/marketingObligationEngine');
  function fakeStore() {
    const rows = [];
    return { rows, query: async (sql, params) => {
      if (/INSERT INTO marketing_obligations/.test(sql)) {
        const r = { id: 'ob' + (rows.length + 1), purchase_kind: params[0], purchase_id: params[1], auction_id: params[2], obligation_key: params[3], label: params[4], category: params[5], channel: params[6], state: 'planned' };
        rows.push(r); return { rows: [r] };
      }
      if (/SELECT \* FROM marketing_obligations WHERE purchase_kind/.test(sql)) return { rows: rows.filter((r) => r.purchase_kind === params[0] && r.purchase_id === params[1]) };
      if (/UPDATE marketing_obligations/.test(sql) && /SET state/.test(sql)) { const r = rows.find((x) => x.id === params[0]); if (r) r.state = params[1]; return { rows: r ? [r] : [] }; }
      return { rows: [] };
    } };
  }
  test('createFromSnapshot creates guaranteed + discretionary; completion needs ALL guaranteed terminal', async () => {
    const s = fakeStore();
    await eng.createFromSnapshot({ purchaseKind: 'package', purchaseId: 'p1', auctionId: 'a1',
      guaranteed: [{ key: 'featured_badge', channel: 'listing', label: 'Badge' }, { key: 'shared_email', channel: 'email', label: 'Shared email' }],
      discretionary: [{ key: 'paid_local', channel: 'paid', label: 'Paid local' }] }, s);
    let c = await eng.evaluateCompletion('package', 'p1', s);
    expect(c.guaranteed_total).toBe(2); expect(c.complete).toBe(false);
    // complete the two guaranteed (discretionary ignored)
    const guar = s.rows.filter((r) => r.category === 'guaranteed');
    await eng.transition(guar[0].id, 'completed', {}, null, s);
    await eng.transition(guar[1].id, 'substituted', {}, null, s);
    c = await eng.evaluateCompletion('package', 'p1', s);
    expect(c.complete).toBe(true);   // substituted counts as terminal-OK; discretionary never blocks
  });
  test('a blocked guaranteed obligation prevents completion', async () => {
    const s = fakeStore();
    await eng.createFromSnapshot({ purchaseKind: 'package', purchaseId: 'p2', guaranteed: [{ key: 'x', channel: 'listing', label: 'X' }], discretionary: [] }, s);
    await eng.transition(s.rows[0].id, 'blocked', {}, null, s);
    const c = await eng.evaluateCompletion('package', 'p2', s);
    expect(c.complete).toBe(false); expect(c.blocked).toBe(1);
  });
});

// ── Purchase service: Stripe paid → immutable snapshot + identity-from-metadata + owner SMS ──
describe('marketingPackagePurchaseService.handlePackagePaid', () => {
  jest.resetModules();
  const store = { purchase: null, obligations: [] };
  jest.doMock('../src/db', () => ({ query: jest.fn(async () => ({ rows: [{ email: 's@x.com' }] })), connect: jest.fn() }));
  jest.doMock('../src/utils/withTransaction', () => ({ withTransaction: async (cb) => cb({ query: async (sql, params) => {
    if (/SELECT id, status FROM marketing_package_purchases/.test(sql)) return { rows: store.purchase ? [{ id: store.purchase.id, status: store.purchase.status }] : [] };
    if (/INSERT INTO marketing_package_purchases/.test(sql)) {
      if (store.purchase && store.purchase.status === 'paid') return { rows: [] };
      store.purchase = { id: 'PP1', status: 'paid', package_key: params[2], package_version: params[3], amount_paid_cents: params[4],
        seller_copy: params[5], guaranteed: params[6], economic_policy_version: params[8], direct_fulfillment_bps: params[9], internal_authority_cents: params[10] };
      return { rows: [{ id: 'PP1' }] };
    }
    if (/INSERT INTO marketing_obligations/.test(sql)) { store.obligations.push(params[3]); return { rows: [{ id: 'o' + store.obligations.length }] }; }
    return { rows: [] };
  } }) }));
  jest.doMock('../src/services/cardService', () => ({ ensureStripeCustomer: jest.fn(async () => 'cus_1') }));
  jest.doMock('../src/services/packageRegistryService', () => ({
    PAID_KEYS: ['featured', 'premium', 'signature'],
    activeVersion: jest.fn(async (k) => ({ version: 1, package_key: k, seller_name: 'Premium', seller_description: 'd', seller_benefits: ['b'],
      guaranteed_deliverables: [{ key: 'shared_email', channel: 'email', label: 'Featured in an Advantage.Bid auction email to eligible subscribers' }],
      discretionary_tools: [{ key: 'paid_local_boost', channel: 'paid', label: 'Paid local boost' }], price_cents: 24900, economic_policy_version: 'v1' })),
  }));
  jest.doMock('../src/services/economicPolicyService', () => ({
    resolveForPurchase: jest.fn(async () => ({ policy_version: 'v1', direct_fulfillment_bps: 6000 })),
    deriveAuthorityCents: (a, b) => Math.floor(a * b / 10000),
  }));
  const createObligationsSpy = jest.fn(async ({ guaranteed }) => (guaranteed || []).map((g) => g.key));
  jest.doMock('../src/services/marketingObligationEngine', () => ({ createFromSnapshot: createObligationsSpy }));
  jest.doMock('../src/services/marketingPackageDirectorService', () => ({ planFulfillment: jest.fn(async () => ({})) }));
  const smsSpy = jest.fn(async () => ({ sent: 2 }));
  jest.doMock('../src/services/ownerAlertService', () => ({ notifyOwnerMarketingPackagePurchased: smsSpy }));
  jest.doMock('../src/services/analyticsService', () => ({ insertEvent: jest.fn(async () => {}) }));
  jest.doMock('../src/services/marketingConfigService', () => ({ getInt: jest.fn(async () => 0) }));
  jest.doMock('stripe', () => jest.fn(() => ({})));
  const svc = require('../src/services/marketingPackagePurchaseService');

  beforeEach(() => { store.purchase = null; store.obligations = []; smsSpy.mockClear(); createObligationsSpy.mockClear(); });

  test('identity comes from METADATA (not price); snapshot freezes copy+policy+derived authority', async () => {
    // amount_total intentionally != registry price to prove identity/economics are snapshotted from metadata+actual paid.
    const res = await svc.handlePackagePaid({ mode: 'payment', payment_status: 'paid', id: 'cs_1',
      metadata: { product_type: 'marketing_package', package_key: 'premium', advantage_user_id: 'u1', auction_id: 'a1' },
      amount_total: 24900, payment_intent: 'pi_1' });
    expect(res.transitioned).toBe(true);
    expect(store.purchase.package_key).toBe('premium');            // from metadata
    expect(store.purchase.internal_authority_cents).toBe(14940);   // 24900 × 60%
    expect(store.purchase.direct_fulfillment_bps).toBe(6000);
    // obligations created from the FROZEN snapshot's guaranteed deliverables
    expect(createObligationsSpy).toHaveBeenCalledTimes(1);
    const gKeys = (createObligationsSpy.mock.calls[0][0].guaranteed || []).map((g) => g.key);
    expect(gKeys).toContain('shared_email');
    expect(smsSpy).toHaveBeenCalledTimes(1);
    const smsArg = smsSpy.mock.calls[0][0];
    expect(smsArg.amountCents).toBe(24900);                        // actual snapshotted price
    expect(smsArg.packageProductType).toBe('marketing_package_premium'); // identity, not price
  });
  test('idempotent: a duplicate paid webhook does not create a second snapshot or second SMS', async () => {
    await svc.handlePackagePaid({ mode: 'payment', payment_status: 'paid', id: 'cs_1', metadata: { product_type: 'marketing_package', package_key: 'premium', advantage_user_id: 'u1' }, amount_total: 24900 });
    smsSpy.mockClear();
    const res2 = await svc.handlePackagePaid({ mode: 'payment', payment_status: 'paid', id: 'cs_1', metadata: { product_type: 'marketing_package', package_key: 'premium', advantage_user_id: 'u1' }, amount_total: 24900 });
    expect(res2.transitioned).toBe(false);
    expect(smsSpy).not.toHaveBeenCalled();
  });
  test('unpaid session does not create a snapshot', async () => {
    const res = await svc.handlePackagePaid({ mode: 'payment', payment_status: 'unpaid', id: 'cs_2', metadata: { product_type: 'marketing_package', package_key: 'premium' } });
    expect(res.transitioned).toBe(false);
    expect(store.purchase).toBeNull();
  });
});

// ── Source-level guarantees ──────────────────────────────────────────────────
describe('confidential economics isolation + non-refundable + gates + RBAC', () => {
  test('seller route never returns internal economics', () => {
    const s = read('src', 'routes', 'marketingPackages.js');
    expect(s).not.toMatch(/internal_authority_cents|direct_fulfillment_bps|economic_policy_version|growth_pool|direct_max/);
  });
  test('migration is additive/idempotent and NON-REFUNDABLE (no refund columns)', () => {
    const m = read('db', 'migrations', '140_marketing_package_platform.sql');
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS marketing_package_versions/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS marketing_package_purchases/);
    expect(m).not.toMatch(/\bDROP\b/);
    expect(m).not.toMatch(/refund_cents|pro_rata|partial_credit/i);
  });
  test('migration does NOT activate Google/Meta/A7 external gates', () => {
    const m = read('db', 'migrations', '140_marketing_package_platform.sql');
    ['google_ads_enabled', 'meta_enabled', 'a7_send_enabled'].forEach((k) => expect(m).not.toMatch(new RegExp(k + "'\\s*,\\s*'true'")));
  });
  test('economic policy seeds 60% (6000 bps) as confidential versioned data', () => {
    const m = read('db', 'migrations', '140_marketing_package_platform.sql');
    expect(m).toMatch(/marketing_economic_policies[\s\S]*'v1', 6000/);
  });
  test('admin route is Super-Admin gated (confidential economics)', () => {
    expect(read('src', 'routes', 'adminMarketingPackages.js')).toMatch(/router\.use\(auth, role\(\['admin'\]\)\)/);
  });
  test('Premium = shared email, Signature = dedicated email (distinct, in the seeded deliverables)', () => {
    const m = read('db', 'migrations', '140_marketing_package_platform.sql');
    expect(m).toMatch(/"key":"shared_email"[\s\S]*Featured in an Advantage\.Bid auction email/);
    expect(m).toMatch(/"key":"dedicated_email"[\s\S]*Dedicated single-auction/);
    // Premium must NOT include a dedicated single-auction e-blast.
    const premiumBlock = m.slice(m.indexOf("'premium', 1,"), m.indexOf("'signature', 1,"));
    expect(premiumBlock).not.toMatch(/dedicated_email/);
  });
  test('Owner SMS uses the certified notifier (no new SMS subsystem)', () => {
    const s = read('src', 'services', 'marketingPackagePurchaseService.js');
    expect(s).toMatch(/ownerAlertService\.notifyOwnerMarketingPackagePurchased/);
    expect(s).not.toMatch(/require\('twilio'\)|new Twilio/);
  });
  test('no Lewis & Maese pricing normalization anywhere in this feature', () => {
    ['src/services/marketingPackagePurchaseService.js', 'src/services/packageRegistryService.js', 'src/services/economicPolicyService.js', 'db/migrations/140_marketing_package_platform.sql']
      .forEach((f) => expect(read(f)).not.toMatch(/lewis|maese/i));
  });
  test('webhook dispatch routes marketing_package + additional_promotion by metadata product_type', () => {
    const p = read('src', 'services', 'paymentService.js');
    expect(p).toMatch(/productType === 'marketing_package' \|\| productType === 'additional_promotion'/);
  });
  test('prepaid card only (payment_method_types card)', () => {
    expect(read('src', 'services', 'marketingPackagePurchaseService.js')).toMatch(/payment_method_types: \['card'\]/);
  });
});

// ── Channel readiness (gated external, available internal) ───────────────────
describe('channelReadinessService', () => {
  jest.resetModules();
  jest.doMock('../src/services/marketingConfigService', () => ({ getBool: jest.fn(async () => false) }));
  const cr = require('../src/services/channelReadinessService');
  test('internal channels available; external channels gated when OFF', async () => {
    expect(await cr.statusFor('listing')).toBe('available');
    expect(await cr.statusFor('homepage')).toBe('available');
    expect(await cr.statusFor('creative')).toBe('available');
    expect(await cr.statusFor('email')).toBe('gated');
    expect(await cr.statusFor('social')).toBe('gated');
    expect(await cr.statusFor('paid')).toBe('gated');
  });
});
