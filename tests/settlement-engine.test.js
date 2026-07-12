// Settlement engine — pure formula (collected-basis, refund-aware, actual Stripe fee,
// adjustments, 0% platform fee, cents-safe). DB layer is validated separately with live data.
const { computeSettlementTotals } = require('../src/services/settlementEngine');

describe('computeSettlementTotals (pure)', () => {
  test('collected-basis with unpaid balance, refund, adjustments, and actual Stripe fee', () => {
    const r = computeSettlementTotals({
      grossSalesCents: 300000,
      buyerPaymentsExpectedCents: 300000,
      buyerPaymentsCollectedCents: 250000, // one buyer's $500 lot unpaid
      refundsCents: 10000,
      failedPaymentsCents: 1,
      adjustments: [
        { adjustment_type: 'credit', amount_cents: 5000 },
        { adjustment_type: 'debit',  amount_cents: 2000 },
      ],
      marketingDeductionCents: 0,
      stripeFeeCents: 7500, // actual Stripe cost
    });
    expect(r.outstanding_balance_cents).toBe(50000);      // expected - collected
    expect(r.net_collected_cents).toBe(240000);           // collected - refunds
    expect(r.adjustments.net_cents).toBe(3000);           // +5000 credit - 2000 debit
    expect(r.seller_platform_fee_cents).toBe(0);          // 0% always
    expect(r.credit_card_processing_fee_cents).toBe(7500);
    // 240000 + 3000 - 0 marketing - 7500 fee - 0 platform
    expect(r.net_seller_proceeds_cents).toBe(235500);
    expect(r.final_amount_owed_cents).toBe(235500);
  });

  test('payout is based on COLLECTED, not gross/expected', () => {
    const r = computeSettlementTotals({
      grossSalesCents: 500000, buyerPaymentsExpectedCents: 500000,
      buyerPaymentsCollectedCents: 0, // nobody paid yet
      stripeFeeCents: 0,
    });
    expect(r.net_collected_cents).toBe(0);
    expect(r.net_seller_proceeds_cents).toBe(0);          // never pays out on uncollected funds
    expect(r.outstanding_balance_cents).toBe(500000);
  });

  test('full refund removes the collected amount from proceeds', () => {
    const r = computeSettlementTotals({
      buyerPaymentsExpectedCents: 100000, buyerPaymentsCollectedCents: 100000,
      refundsCents: 100000, stripeFeeCents: 0,
    });
    expect(r.net_collected_cents).toBe(0);
    expect(r.net_seller_proceeds_cents).toBe(0);
  });

  test('partial refund reduces proceeds by the refunded amount', () => {
    const r = computeSettlementTotals({
      buyerPaymentsCollectedCents: 100000, refundsCents: 25000, stripeFeeCents: 2900,
    });
    expect(r.net_collected_cents).toBe(75000);
    expect(r.net_seller_proceeds_cents).toBe(75000 - 2900); // 72100
  });

  test('marketing deduction is subtracted only when present', () => {
    const withNone = computeSettlementTotals({ buyerPaymentsCollectedCents: 50000 });
    expect(withNone.marketing_deduction_cents).toBe(0);
    expect(withNone.net_seller_proceeds_cents).toBe(50000);
    const withPkg = computeSettlementTotals({ buyerPaymentsCollectedCents: 50000, marketingDeductionCents: 9900 });
    expect(withPkg.net_seller_proceeds_cents).toBe(40100);
  });

  test('debit-only adjustment reduces proceeds; credit-only increases', () => {
    const debit = computeSettlementTotals({ buyerPaymentsCollectedCents: 10000, adjustments: [{ adjustment_type: 'debit', amount_cents: 1500 }] });
    expect(debit.net_seller_proceeds_cents).toBe(8500);
    const credit = computeSettlementTotals({ buyerPaymentsCollectedCents: 10000, adjustments: [{ adjustment_type: 'credit', amount_cents: 1500 }] });
    expect(credit.net_seller_proceeds_cents).toBe(11500);
  });

  test('cents-safe: integer output on messy/float input, never NaN', () => {
    const r = computeSettlementTotals({
      buyerPaymentsCollectedCents: 12345.99, refundsCents: '100', stripeFeeCents: null, marketingDeductionCents: undefined,
      adjustments: [{ adjustment_type: 'credit', amount_cents: 10.7 }],
    });
    Object.values(r).forEach(v => {
      if (typeof v === 'number') { expect(Number.isInteger(v)).toBe(true); expect(Number.isNaN(v)).toBe(false); }
    });
    // 12345 (trunc) - 100 refund + 10 credit(trunc) = 12255
    expect(r.net_seller_proceeds_cents).toBe(12255);
  });

  test('empty input yields an all-zero settlement (no throw)', () => {
    const r = computeSettlementTotals();
    expect(r.net_seller_proceeds_cents).toBe(0);
    expect(r.seller_platform_fee_cents).toBe(0);
    expect(r.outstanding_balance_cents).toBe(0);
  });
});
