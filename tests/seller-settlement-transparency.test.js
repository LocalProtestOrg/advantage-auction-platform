'use strict';

/**
 * Seller settlement transparency + Professional payout terms. Platform/Software Fee and Payment Processing
 * are presented SEPARATELY (never a "7% commission"); Individual 0%+3%; Storefront 11% (no extra 3%);
 * marketing package itemized; payout never negative; Thursday-processing agreement/UI language.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const engine = require('../src/services/settlementEngine');
const view = require('../src/lib/sellerSettlementView');

const totalsFor = (opts) => engine.computeSettlementTotals(Object.assign({
  grossSalesCents: 100000, buyerPaymentsExpectedCents: 118000, buyerPaymentsCollectedCents: 118000,
  refundsCents: 0, marketingDeductionCents: 0, adjustments: [],
}, opts));

// ── Professional auction: platform + processing SEPARATE ─────────────────────────
describe('Professional auction settlement — separate platform + processing', () => {
  test('standard 4% platform + 3% processing shown as separate cents + rates', () => {
    const t = totalsFor({ sellerType: 'auction_house', sellerPlatformFeeBps: 400, pricingModel: 'v2_separated', processingFeeBps: 300 });
    const d = view.sellerSettlementDetailView({ auctionId: 'a', auction: {}, sp: null, totals: t });
    expect(d.platform_fee_cents).toBe(4000);
    expect(d.payment_processing_cents).toBe(3000);
    expect(d.platform_fee_label).toMatch(/Platform\/Software Fee/);
    expect(d.payment_processing_label).toBe('Payment Processing');
    expect(d.platform_fee_pct).toBe('4.00%');
    expect(d.payment_processing_pct).toBe('3.00%');
  });
  test('negotiated platform rate (e.g. 250 bps) is honored from the snapshot; processing stays 3%', () => {
    const t = totalsFor({ sellerType: 'estate_sale_company', sellerPlatformFeeBps: 250, pricingModel: 'v2_separated', processingFeeBps: 300 });
    const d = view.sellerSettlementDetailView({ auctionId: 'a', auction: {}, sp: null, totals: t });
    expect(d.platform_fee_cents).toBe(2500);
    expect(d.payment_processing_cents).toBe(3000);
  });
  test('the seller UI never presents a combined "7% commission" / "7% platform fee"', () => {
    const html = read('public', 'seller-settlements.html');
    expect(html).not.toMatch(/7%\s*(Advantage\.?Bid|commission|platform fee|seller fee)/i);
    expect(html).toMatch(/Platform\/Software Fee/);
    expect(html).toMatch(/Payment Processing/);
    expect(html).not.toMatch(/Actual Stripe Processing/); // no Stripe pass-through framing
  });
});

// ── Individual auction ───────────────────────────────────────────────────────────
describe('Individual auction settlement', () => {
  test('0% platform + 3% processing (no accidental pro fee)', () => {
    const t = totalsFor({ sellerType: 'private', pricingModel: 'v2_separated', processingFeeBps: 300 });
    const d = view.sellerSettlementDetailView({ auctionId: 'a', auction: {}, sp: null, totals: t });
    expect(d.platform_fee_cents).toBe(0);
    expect(d.platform_fee_pct).toBe('0.00%');
    expect(d.payment_processing_cents).toBe(3000);
  });
});

// ── Marketing package + zero/shortfall ───────────────────────────────────────────
describe('marketing package + zero/shortfall payout', () => {
  test('marketing package is a separate line', () => {
    const t = totalsFor({ sellerType: 'private', pricingModel: 'v2_separated', processingFeeBps: 300, marketingDeductionCents: 9900 });
    const d = view.sellerSettlementDetailView({ auctionId: 'a', auction: {}, sp: null, totals: t });
    expect(d.marketing_package_cents).toBe(9900);
  });
  test('deductions exceed proceeds → payout clamps to $0 (never negative) + proceeds_insufficient flag', () => {
    const t = totalsFor({ sellerType: 'private', pricingModel: 'v2_separated', processingFeeBps: 300, buyerPaymentsCollectedCents: 3000, marketingDeductionCents: 9900 });
    expect(t.net_seller_proceeds_cents).toBeLessThan(0);
    const d = view.sellerSettlementDetailView({ auctionId: 'a', auction: {}, sp: null, totals: t });
    expect(d.net_seller_payment_cents).toBe(0);
    expect(d.proceeds_insufficient).toBe(true);
  });
  test('history row net payment is never negative and processing is a separate field', () => {
    const item = view.sellerSettlementListItem({ auction_id: 'a', settlement_status: 'pending_review', gross_revenue_cents: 1000, platform_fee_cents: 40, processing_fee_cents: 30, seller_payout_cents: -500 });
    expect(item.net_seller_payment_cents).toBe(0);
    expect(item.payment_processing_cents).toBe(30);
  });
  test('seller settlement UI shows the $0 explanation without internal loss accounting', () => {
    const html = read('public', 'seller-settlements.html');
    expect(html).toMatch(/No payout is due for this auction/);
    expect(html).not.toMatch(/direct.spend|growth pool|60\/40|write-off|shortfall/i);
  });
});

// ── Storefront unaffected (11% only, no extra 3%) ────────────────────────────────
describe('Storefront economics unaffected by the auction settlement fix', () => {
  test('marketplace order fee remains 1100 bps with no added processing', () => {
    const mo = read('src', 'services', 'marketplaceOrderService.js');
    expect(mo).toMatch(/STOREFRONT_FEE_BPS = 1100/);
    expect(mo).not.toMatch(/\+ 300\b/);
  });
});

// ── Authoritative-source (snapshot, not global config) ───────────────────────────
describe('authoritative data source', () => {
  test('the settlement view reads stored snapshot fields, not today\'s global pricing config', () => {
    const v = read('src', 'lib', 'sellerSettlementView.js');
    expect(v).toMatch(/t\.seller_platform_fee_cents/);
    expect(v).toMatch(/t\.credit_card_processing_fee_cents/);
    expect(v).not.toMatch(/pricingConfigService|require\(.*config/);
  });
});

// ── Professional agreement + Thursday payout language ────────────────────────────
describe('agreement + payout language', () => {
  const doc = read('docs', 'seller-agreement-v1-content.md');
  test('§6.7 states 4% platform + 3% processing separately (not a 7% commission)', () => {
    expect(doc).toMatch(/platform\/software fee of 4% of the hammer price/i);
    expect(doc).toMatch(/processing fee of 3% of the hammer price/i);
    expect(doc).not.toMatch(/7%\s*Advantage\.?Bid commission/i);
  });
  test('§6.3 individual = 0% seller commission + 3% processing', () => {
    expect(doc).toMatch(/0% seller commission/i);
    expect(doc).toMatch(/payment processing fee of 3%/i);
  });
  test('§7.3 payout = Thursday PROCESSING (not "14 days"), storefront Wed 11:59 cutoff, "processed" not "received/deposited"', () => {
    expect(doc).toMatch(/processed .*every .*Thursday|weekly cycle, every \*\*Thursday\*\*/i);
    expect(doc).toMatch(/Wednesday \*\*11:59 PM\*\*|Wednesday 11:59/i);
    expect(doc).not.toMatch(/issued 14 days after auction close/);
    expect(doc).toMatch(/outside Advantage's direct control/);
  });
  test('payout-profile UI states Thursday processing without guaranteeing bank receipt timing', () => {
    const pp = read('public', 'payout-profile.html');
    expect(pp).toMatch(/processed every Thursday/i);
    expect(pp).toMatch(/depends on your bank\/ACH/i);
    expect(pp).not.toMatch(/deposited (on|every) Thursday|received (on|every) Thursday/i);
  });
});
