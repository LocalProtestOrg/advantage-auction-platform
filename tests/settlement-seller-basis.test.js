'use strict';

/**
 * LIVE blocker fix (2026-09-27): the settlement workbench must pay sellers only their own money.
 *   - Sales tax is collected for the state: never seller proceeds.
 *   - Individual-seller auctions: the fixed 18% buyer's premium is retained by Advantage.Bid.
 *   - Professional sellers keep their own premium.
 *   - Refunds reduce the seller's share proportionally.
 * Before the fix, the payout started from everything buyers paid (hammer + premium + tax), so an individual
 * seller would have been proposed hammer + 18% + tax − 3%. The workbench must now agree with the payout
 * computed at close by billingTermsService.settlement (the single fee model).
 */

jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');
const engine = require('../src/services/settlementEngine');
const billing = require('../src/services/billingTermsService');

const base = (o) => Object.assign({ refundsCents: 0, marketingDeductionCents: 0, adjustments: [], pricingModel: 'v2_separated', processingFeeBps: 300 }, o);

describe('pure formula: seller basis', () => {
  test('individual seller: premium (Advantage) and tax are excluded; payout = hammer − 3%', () => {
    // $1,000 hammer, $180 premium (18%), $95.40 tax → buyer paid $1,275.40
    const t = engine.computeSettlementTotals(base({
      sellerType: 'private', grossSalesCents: 100000, buyerPaymentsExpectedCents: 127540, buyerPaymentsCollectedCents: 127540,
      sellerCollectedCents: 100000, salesTaxCollectedCents: 9540, advantagePremiumCollectedCents: 18000, sellerRefundsCents: 0,
    }));
    expect(t.net_collected_cents).toBe(100000);
    expect(t.credit_card_processing_fee_cents).toBe(3000);
    expect(t.seller_platform_fee_cents).toBe(0);
    expect(t.final_payout_cents).toBe(97000);
    expect(t.sales_tax_collected_cents).toBe(9540);
    expect(t.advantage_premium_collected_cents).toBe(18000);
  });
  test('professional seller: keeps own premium, tax excluded; payout = hammer + premium − 4% − 3%', () => {
    // $1,000 hammer, $150 seller premium (15%), $92 tax → buyer paid $1,242
    const t = engine.computeSettlementTotals(base({
      sellerType: 'auction_house', sellerPlatformFeeBps: 400, grossSalesCents: 100000,
      buyerPaymentsExpectedCents: 124200, buyerPaymentsCollectedCents: 124200,
      sellerCollectedCents: 115000, salesTaxCollectedCents: 9200, advantagePremiumCollectedCents: 0, sellerRefundsCents: 0,
    }));
    expect(t.net_collected_cents).toBe(115000);
    expect(t.seller_platform_fee_cents).toBe(4000);
    expect(t.credit_card_processing_fee_cents).toBe(3000);
    expect(t.final_payout_cents).toBe(108000);
  });
  test('safety net: a caller that supplies no split still never pays tax or the Advantage premium', () => {
    const t = engine.computeSettlementTotals(base({
      sellerType: 'private', grossSalesCents: 100000, buyerPaymentsExpectedCents: 127540, buyerPaymentsCollectedCents: 127540,
      salesTaxCollectedCents: 9540, advantagePremiumCollectedCents: 18000,
    }));
    expect(t.net_collected_cents).toBe(100000);
    expect(t.final_payout_cents).toBe(97000);
  });
  test('a full refund removes the seller\'s whole share (not the buyer total)', () => {
    const t = engine.computeSettlementTotals(base({
      sellerType: 'private', grossSalesCents: 100000, buyerPaymentsExpectedCents: 127540, buyerPaymentsCollectedCents: 127540,
      refundsCents: 127540, sellerCollectedCents: 100000, sellerRefundsCents: 100000, salesTaxCollectedCents: 9540, advantagePremiumCollectedCents: 18000,
    }));
    expect(t.net_collected_cents).toBe(0);
    expect(t.final_payout_cents).toBe(0);
  });
  test('legacy auctions keep their legacy processing (actual card cost), on the seller basis', () => {
    const t = engine.computeSettlementTotals({
      sellerType: 'private', pricingModel: 'legacy', grossSalesCents: 50000, buyerPaymentsExpectedCents: 50000, buyerPaymentsCollectedCents: 50000,
      sellerCollectedCents: 50000, salesTaxCollectedCents: 0, advantagePremiumCollectedCents: 0, stripeFeeCents: 1480, refundsCents: 0, adjustments: [],
    });
    expect(t.credit_card_processing_fee_cents).toBe(1480);
    expect(t.final_payout_cents).toBe(48520);
  });
});

describe('workbench agrees with the payout computed at close (single fee model)', () => {
  test.each([
    ['private', null, 100000],
    ['auction_house', 400, 100000],
    ['estate_sale_company', 250, 73500],
  ])('%s (platform bps %p), hammer %p', (sellerType, bps, hammer) => {
    const premiumBps = sellerType === 'private' ? 1800 : 1500;
    const premium = Math.floor(hammer * premiumBps / 10000 + 0.5);
    const close = billing.settlement({ sellerType, hammerCents: hammer, buyerPremiumCents: premium, platformFeeBps: bps, processingFeeBps: 300, pricingModel: 'v2_separated' });
    const pro = sellerType !== 'private';
    const tax = 8000;
    const t = engine.computeSettlementTotals(base({
      sellerType, sellerPlatformFeeBps: bps, grossSalesCents: hammer,
      buyerPaymentsExpectedCents: hammer + premium + tax, buyerPaymentsCollectedCents: hammer + premium + tax,
      sellerCollectedCents: hammer + (pro ? premium : 0), salesTaxCollectedCents: tax, advantagePremiumCollectedCents: pro ? 0 : premium, sellerRefundsCents: 0,
    }));
    expect(t.final_payout_cents).toBe(close.seller_payout_cents);
  });
});

describe('assembler: builds the seller split from paid invoices', () => {
  const stub = (sellerType) => db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/SUM\(winning_amount_cents\)/.test(s)) return { rows: [{ gross: 100000 }] };
    if (/FROM auctions a LEFT JOIN seller_profiles/.test(s)) return { rows: [{ seller_type: sellerType, seller_platform_bps: 400, snap_platform_bps: 400, processing_fee_bps: 300, pricing_model: 'v2_separated' }] };
    if (/FROM buyer_auction_invoices/.test(s)) return { rows: [{ expected: 127540, collected: 127540, outstanding: 0, paid_hammer: 100000, paid_premium: 18000, paid_tax: 9540, paid_shipping: 0 }] };
    if (/FROM payments WHERE auction_id/.test(s)) return { rows: [] };
    if (/FROM marketing_jobs/.test(s)) return { rows: [{ total: 0, job_id: null }] };
    return { rows: [] };
  });
  test('individual seller: premium goes to Advantage, tax excluded', async () => {
    stub('private');
    const i = await engine.assembleSettlementInputs('a1');
    expect(i.sellerCollectedCents).toBe(100000);
    expect(i.advantagePremiumCollectedCents).toBe(18000);
    expect(i.salesTaxCollectedCents).toBe(9540);
    expect(engine.computeSettlementTotals(i).final_payout_cents).toBe(97000);
  });
  test('professional seller: premium stays with the seller, tax excluded', async () => {
    stub('auction_house');
    const i = await engine.assembleSettlementInputs('a1');
    expect(i.sellerCollectedCents).toBe(118000);
    expect(i.advantagePremiumCollectedCents).toBe(0);
    expect(engine.computeSettlementTotals(i).final_payout_cents).toBe(118000 - 4000 - 3000);
  });
});
