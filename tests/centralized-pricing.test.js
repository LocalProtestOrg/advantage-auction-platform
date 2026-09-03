'use strict';

/**
 * Centralized pricing/fee architecture — owner-authoritative model (2026-09-03).
 *
 * Professional auction = 4% platform + 3% processing (SEPARATE, never one "7% fee"); Individual = 0%
 * platform + 3% processing; buyer premium unchanged; legacy auctions untouched (no flat processing, no
 * double Stripe charge); actual Stripe cost retained for reconciliation only; historical protection;
 * RBAC; and separate-component presentation everywhere.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

const billing = require('../src/services/billingTermsService');
const policy = require('../src/lib/settlementPolicy');
const engine = require('../src/services/settlementEngine');

// ── Pure fee primitives ──────────────────────────────────────────────────────────
describe('settlementPolicy.processingFeeCents — separate 3% primitive', () => {
  test('3% of hammer, cents-safe, own base (never fee-on-fee)', () => {
    expect(policy.processingFeeCents(10000, 300)).toBe(300);   // $100 → $3
    expect(policy.processingFeeCents(100000, 300)).toBe(3000); // $1,000 → $30
    expect(policy.DEFAULT_PROCESSING_FEE_BPS).toBe(300);
  });
  test('rounds deterministically on odd amounts', () => {
    expect(policy.processingFeeCents(99, 300)).toBe(3);      // $0.99 → 2.97 → 3
    expect(policy.processingFeeCents(1234, 300)).toBe(37);   // $12.34 → 37.02 → 37
    expect(policy.processingFeeCents(9999, 300)).toBe(300);  // $99.99 → 299.97 → 300
    expect(policy.processingFeeCents(12345, 300)).toBe(370); // $123.45 → 370.35 → 370
  });
  test('null/invalid bps → 0 (legacy auctions carry 0 → no deduction)', () => {
    expect(policy.processingFeeCents(100000, null)).toBe(0);
    expect(policy.processingFeeCents(100000, undefined)).toBe(0);
  });
});

// ── billingTermsService.settlement — v2 model, components separate ────────────────
describe('settlement() — Professional v2 (4% platform + 3% processing, separate)', () => {
  const pro = (h, bp) => billing.settlement({ sellerType: 'auction_house', hammerCents: h, buyerPremiumCents: bp, platformFeeBps: 400, processingFeeBps: 300, pricingModel: 'v2_separated' });
  test('$100 hammer → $4 platform + $3 processing kept separate', () => {
    const s = pro(10000, 1500);
    expect(s.platform_fee_cents).toBe(400);
    expect(s.processing_fee_cents).toBe(300);
    expect(s.platform_fee_bps).toBe(400);
    expect(s.processing_fee_bps).toBe(300);
    expect(s.seller_payout_cents).toBe(10000 + 1500 - 400 - 300); // hammer + own BP − platform − processing
  });
  test('$1,000 hammer → $40 platform + $30 processing', () => {
    const s = pro(100000, 0);
    expect(s.platform_fee_cents).toBe(4000);
    expect(s.processing_fee_cents).toBe(3000);
    expect(s.seller_payout_cents).toBe(100000 - 4000 - 3000);
  });
  test('there is no single combined "fee" field — the total is only the derived sum', () => {
    const s = pro(100000, 0);
    expect(s.platform_fee_cents + s.processing_fee_cents).toBe(7000); // 7% DERIVED
    expect(s).not.toHaveProperty('total_fee_cents');
    expect(s).not.toHaveProperty('combined_fee_cents');
  });
});

describe('settlement() — Individual v2 (0% platform + 3% processing)', () => {
  const ind = (h, bp) => billing.settlement({ sellerType: 'private', hammerCents: h, buyerPremiumCents: bp, processingFeeBps: 300, pricingModel: 'v2_separated' });
  test('$100 hammer → $0 platform, $3 processing, $97 to seller', () => {
    const s = ind(10000, 1800);
    expect(s.platform_fee_cents).toBe(0);
    expect(s.processing_fee_cents).toBe(300);
    expect(s.seller_payout_cents).toBe(9700);
    expect(s.advantage_revenue_cents).toBe(1800 + 300); // buyer premium (100%) + processing
  });
  test('$1,000 hammer → $30 processing, $970 to seller', () => {
    const s = ind(100000, 18000);
    expect(s.processing_fee_cents).toBe(3000);
    expect(s.seller_payout_cents).toBe(97000);
  });
});

describe('settlement() — LEGACY auctions unchanged (no flat processing)', () => {
  test('legacy professional: seller keeps hammer + BP − platform, NO processing deduction', () => {
    const s = billing.settlement({ sellerType: 'auction_house', hammerCents: 100000, buyerPremiumCents: 15000, platformFeeBps: 400 }); // no pricingModel
    expect(s.processing_fee_cents).toBe(0);
    expect(s.seller_payout_cents).toBe(100000 + 15000 - 4000);
  });
  test('legacy individual: seller receives full hammer, NO processing deduction', () => {
    const s = billing.settlement({ sellerType: 'private', hammerCents: 100000, buyerPremiumCents: 18000 });
    expect(s.processing_fee_cents).toBe(0);
    expect(s.seller_payout_cents).toBe(100000);
  });
});

// ── settlement workbench (engine): v2 = flat 3%, actual Stripe reconciliation-only ─
describe('settlementEngine.computeSettlementTotals — no double processing charge', () => {
  const base = { grossSalesCents: 100000, buyerPaymentsExpectedCents: 118000, buyerPaymentsCollectedCents: 118000, refundsCents: 0, marketingDeductionCents: 0, adjustments: [], sellerType: 'auction_house', sellerPlatformFeeBps: 400, stripeFeeCents: 3200 };
  test('v2: deducts flat 3% processing; actual Stripe cost retained but NOT deducted again', () => {
    const t = engine.computeSettlementTotals({ ...base, pricingModel: 'v2_separated', processingFeeBps: 300 });
    expect(t.credit_card_processing_fee_cents).toBe(3000); // flat 3% of hammer, DEDUCTED
    expect(t.actual_stripe_cost_cents).toBe(3200);         // real Stripe cost, reconciliation only
    expect(t.processing_fee_bps).toBe(300);
    // netProceeds = 118000 − 3000 processing − 4000 platform (Stripe 3200 NOT subtracted)
    expect(t.net_seller_proceeds_cents).toBe(118000 - 3000 - 4000);
  });
  test('legacy: actual Stripe cost IS the processing deduction (prior behavior preserved)', () => {
    const t = engine.computeSettlementTotals(base); // no pricingModel → legacy
    expect(t.credit_card_processing_fee_cents).toBe(3200); // actual Stripe deducted
    expect(t.processing_fee_bps).toBe(0);
    expect(t.net_seller_proceeds_cents).toBe(118000 - 3200 - 4000);
  });
});

// ── pricingConfigService — components separate, total derived, no editable total ───
describe('pricingConfigService — separate components; derived total', () => {
  jest.resetModules();
  jest.doMock('../src/services/configService', () => ({ get: jest.fn().mockResolvedValue(null), setPlatformConfig: jest.fn() }));
  const svc = require('../src/services/pricingConfigService');
  afterAll(() => jest.dontMock('../src/services/configService'));
  test('defaults resolve to 4% / 3% / 0% / 18% / 11% / $39 / $19.99', async () => {
    const p = await svc.getPricing();
    expect(p.auction.professional.platform_fee_bps).toBe(400);
    expect(p.auction.professional.processing_fee_bps).toBe(300);
    expect(p.auction.professional.total_seller_deduction_bps).toBe(700); // DERIVED
    expect(p.auction.individual.platform_fee_bps).toBe(0);
    expect(p.auction.individual.processing_fee_bps).toBe(300);
    expect(p.auction.individual.buyer_premium_bps).toBe(1800);
    expect(p.storefront.seller_fee_bps).toBe(1100);
    expect(p.estate_sale.price_cents).toBe(3900);
    expect(p.appraiser.price_cents).toBe(1999);
  });
  test('there is no independently-editable combined-total key', () => {
    const src = read('src', 'services', 'pricingConfigService.js');
    expect(src).not.toMatch(/total_fee_bps|professional_total_fee_bps|combined_fee_bps/);
  });
  test('setBps rejects out-of-range rates', async () => {
    await expect(svc.setBps('pricing.auction.processing_fee_bps', 9999)).rejects.toThrow();
    await expect(svc.setBps('pricing.auction.processing_fee_bps', -5)).rejects.toThrow();
  });
});

// ── Migration 125: additive, legacy protection, separate columns, no 700 key ───────
describe('migration 125 — snapshot + protection + config seed', () => {
  const mig = read('db', 'migrations', '125_centralized_pricing.sql');
  test('adds publish-time snapshot + separate processing columns', () => {
    expect(mig).toMatch(/ALTER TABLE auctions ADD COLUMN IF NOT EXISTS platform_fee_bps/);
    expect(mig).toMatch(/ALTER TABLE auctions ADD COLUMN IF NOT EXISTS processing_fee_bps/);
    expect(mig).toMatch(/ALTER TABLE auctions ADD COLUMN IF NOT EXISTS pricing_model/);
    expect(mig).toMatch(/ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS processing_fee_cents/);
  });
  test('freezes existing LIVE/historical auctions as legacy (processing 0); leaves drafts NULL', () => {
    expect(mig).toMatch(/pricing_model = 'legacy'[\s\S]*processing_fee_bps = 0/);
    expect(mig).toMatch(/state IN \('published', 'active', 'closed'\)/);
  });
  test('seeds SEPARATE platform + processing config; NO combined 700 key', () => {
    expect(mig).toMatch(/pricing\.auction\.professional\.platform_fee_bps', '400'/);
    expect(mig).toMatch(/pricing\.auction\.processing_fee_bps',\s*'300'/);
    expect(mig).not.toMatch(/'700'|professional_total_fee_bps/);
  });
});

// ── Publish-time snapshot wiring ───────────────────────────────────────────────────
describe('publish freezes the v2 snapshot exactly once', () => {
  const a = read('src', 'services', 'auctionService.js');
  test('publishAuction writes pricing_model=v2_separated + processing snapshot, only when never frozen', () => {
    expect(a).toMatch(/pricing_model = 'v2_separated'/);
    expect(a).toMatch(/processing_fee_bps = \$3/);
    expect(a).toMatch(/WHERE id = \$1 AND pricing_model IS NULL/); // never re-freezes legacy or existing v2
  });
});

// ── Storefront unchanged (11% inclusive, no +3%) ───────────────────────────────────
describe('storefront economics unchanged', () => {
  const mo = read('src', 'services', 'marketplaceOrderService.js');
  test('still a flat 1100 bps on item price; no auction platform/processing applied', () => {
    expect(mo).toMatch(/STOREFRONT_FEE_BPS = 1100/);
    expect(mo).not.toMatch(/\+ 300\b|processing_fee_bps \* |platform_fee_bps.*processing/);
  });
});

// ── Agreement text: professional 4% + 3% separate (not 2%, not "7% commission") ────
describe('agreement source states professional fees separately', () => {
  const doc = read('docs', 'seller-agreement-v1-content.md');
  test('professional §6.7 now states 4% platform + 3% processing as separate components', () => {
    expect(doc).toMatch(/platform\/software fee of 4% of the hammer price/i);
    expect(doc).toMatch(/processing fee of 3% of the hammer price/i);
    expect(doc).not.toMatch(/software\/platform fee equal to 2%/);
  });
  test('individual sections remain 0% seller commission + 3% processing + 18% BP', () => {
    expect(doc).toMatch(/0% seller commission/i);
    expect(doc).toMatch(/payment processing fee of 3%/i);
    expect(doc).toMatch(/18% Buyer's Premium/);
  });
});

// ── Admin Pricing & Fees route: RBAC + only two editable rates + audit ─────────────
describe('admin pricing route — RBAC, editable whitelist, audit', () => {
  const r = read('src', 'routes', 'adminPricing.js');
  test('view needs sales/finance permission; write needs manage (Super Admin)', () => {
    expect(r).toMatch(/requirePermission\('seller_platform_fee\.view'\)/);
    expect(r).toMatch(/requirePermission\('seller_platform_fee\.manage'\)/);
  });
  test('only professional platform + processing are editable here', () => {
    expect(r).toMatch(/pricing\.auction\.professional\.platform_fee_bps/);
    expect(r).toMatch(/pricing\.auction\.processing_fee_bps/);
    expect(r).not.toMatch(/individual\.platform_fee_bps'.*EDITABLE|storefront.*EDITABLE/);
  });
  test('rate changes are audited (old + new)', () => {
    expect(r).toMatch(/pricing\.rate_changed/);
    expect(r).toMatch(/old_bps|new_bps/);
  });
  test('the admin page keeps platform + processing separate; 7% only as a derived label', () => {
    const page = read('public', 'admin', 'pricing.html');
    expect(page).toMatch(/Platform \/ Software Fee/i);
    expect(page).toMatch(/Processing Fee/i);
    expect(page).toMatch(/Derived/);
  });
});

// ── RBAC: who can change pricing ───────────────────────────────────────────────────
describe('pricing RBAC', () => {
  const rbac = require('../src/lib/rbac');
  test('Super Admin can manage pricing; marketing/seller/buyer/demo cannot', () => {
    expect(rbac.hasPermission({ role: 'admin', staff_role: 'super_admin' }, 'seller_platform_fee.manage')).toBe(true);
    expect(rbac.hasPermission({ role: 'buyer', staff_role: 'marketing', staff_active: true }, 'seller_platform_fee.manage')).toBe(false);
    expect(rbac.hasPermission({ role: 'seller', staff_role: null }, 'seller_platform_fee.manage')).toBe(false);
    expect(rbac.hasPermission({ role: 'buyer', staff_role: null }, 'seller_platform_fee.manage')).toBe(false);
  });
});
