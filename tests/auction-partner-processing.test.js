'use strict';

/**
 * Auction Partner: 0% platform fee + ACTUAL Stripe processing pass-through (Owner policy 2026-10-05, migration 186).
 *
 * The seller's processing deduction must EQUAL the actual Stripe fee on the auction's buyer payments: no markup, no
 * subsidy, never a guessed percentage. These tests drive the REAL settlement engine (computeSettlement → assemble →
 * computeSettlementTotals → mark-paid / transfer guards) against an in-memory database and a mocked Stripe client.
 *
 * Fixtures are Stripe's actual pricing evidence (2.9% + 30c on the full charge, rounded to the cent):
 *   A  $100 hammer + 20% premium, no tax  → charge $120.00,   fee $3.78
 *   B  $100 hammer + 20% premium, 8.25%   → charge $129.90,   fee $4.07
 *   C  $1,000 hammer + 20% premium, 8.25% → charge $1,299.00, fee $37.97
 */

const mockState = { auctions: new Map(), invoices: [], payments: [], lots: [], stripe: { intents: new Map(), refunds: new Map(), fail: false }, updates: [] };

jest.mock('../src/db', () => {
  const handle = async (sql, p = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    const st = mockState;
    const rows = (r) => ({ rows: r, rowCount: r.length });
    if (/^SELECT COALESCE\(SUM\(winning_amount_cents\),0\)::bigint AS gross FROM lots/.test(s)) {
      return rows([{ gross: st.lots.filter((l) => l.auction_id === p[0]).reduce((a, l) => a + l.winning_amount_cents, 0) }]);
    }
    if (/AS snap_platform_bps, a\.processing_fee_bps, a\.pricing_model, a\.processing_fee_basis FROM auctions a/.test(s)) {
      const a = st.auctions.get(p[0]);
      return rows([{ seller_type: a.seller_type, seller_platform_bps: a.seller_platform_bps, snap_platform_bps: a.platform_fee_bps,
        processing_fee_bps: a.processing_fee_bps, pricing_model: a.pricing_model, processing_fee_basis: a.processing_fee_basis }]);
    }
    if (/FROM buyer_auction_invoices WHERE auction_id = \$1/.test(s)) {
      const inv = st.invoices.filter((i) => i.auction_id === p[0]); const paid = inv.filter((i) => ['paid', 'partially_refunded', 'refunded'].includes(i.status));
      const sum = (arr, k) => arr.reduce((a, i) => a + (i[k] || 0), 0);
      return rows([{ expected: sum(inv, 'total_cents'), collected: sum(paid, 'total_cents'), outstanding: sum(inv.filter((i) => !paid.includes(i)), 'total_cents'),
        paid_hammer: sum(paid, 'hammer_cents'), paid_premium: sum(paid, 'buyer_premium_cents'), paid_tax: sum(paid, 'sales_tax_cents'), paid_shipping: 0 }]);
    }
    if (/FROM payments WHERE auction_id = \$1/.test(s)) return rows(st.payments.filter((x) => x.auction_id === p[0]).map((x) => Object.assign({}, x)));
    if (/^UPDATE payments SET stripe_fee_cents = \$2/.test(s)) { const x = st.payments.find((y) => y.id === p[0]); x.stripe_fee_cents = p[1]; st.updates.push(s); return rows([]); }
    if (/^UPDATE payments SET stripe_refund_fee_cents = \$2/.test(s)) { const x = st.payments.find((y) => y.id === p[0]); x.stripe_refund_fee_cents = p[1]; x.stripe_refund_fee_refunded_cents = p[2]; st.updates.push(s); return rows([]); }
    if (/FROM settlement_adjustments/.test(s)) return rows([]);
    if (/FROM marketing_jobs/.test(s)) return rows([{ total: 0, job_id: null }]);
    return rows([]);
  };
  return { query: handle, connect: async () => ({ query: handle, release() {} }), pool: {} };
});
jest.mock('stripe', () => () => ({
  paymentIntents: { retrieve: async (id) => {
    if (mockState.stripe.fail) throw new Error('stripe unavailable');
    const fee = mockState.stripe.intents.get(id);
    return fee == null ? { latest_charge: null } : { latest_charge: { balance_transaction: { id: 'txn_' + id, fee } } };
  } },
  refunds: { list: async ({ payment_intent }) => {
    if (mockState.stripe.fail) throw new Error('stripe unavailable');
    return { data: mockState.stripe.refunds.get(payment_intent) || [], has_more: false };
  } },
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_fixture_not_a_real_key';
const engine = require('../src/services/settlementEngine');
const billing = require('../src/services/billingTermsService');
const actual = require('../src/services/actualProcessingService');
const marketplaceOrders = require('../src/services/marketplaceOrderService');
const { sellerSettlementDetailView } = require('../src/lib/sellerSettlementView');

let seq = 0;
function auction({ basis = 'actual_stripe', platformBps = 0, sellerType = 'estate_sale_company', processingBps = 300, model = 'v2_separated' } = {}) {
  seq += 1; const id = 'auc-' + seq;
  mockState.auctions.set(id, { seller_type: sellerType, seller_platform_bps: platformBps, platform_fee_bps: platformBps, processing_fee_bps: processingBps,
    pricing_model: model, processing_fee_basis: basis });
  return id;
}
/** One buyer: hammer, 20% premium, tax; a paid invoice and a paid payment. stripeFee = Stripe's actual fee (null = not yet known). */
function buyer(auctionId, { hammer, premiumBps = 2000, taxBps = 0, stripeFee, captured = true, refunded = 0, status = 'paid' }) {
  seq += 1;
  const premium = Math.floor(hammer * premiumBps / 10000 + 0.5);
  const tax = Math.round((hammer + premium) * taxBps / 10000);
  const total = hammer + premium + tax;
  mockState.lots.push({ auction_id: auctionId, winning_amount_cents: hammer });
  mockState.invoices.push({ auction_id: auctionId, status, hammer_cents: hammer, buyer_premium_cents: premium, sales_tax_cents: tax, total_cents: total });
  const pi = 'pi_' + seq;
  if (stripeFee != null) mockState.stripe.intents.set(pi, stripeFee);
  mockState.payments.push({ id: 'pay-' + seq, auction_id: auctionId, payment_intent_id: pi, status, amount_cents: total, refunded_amount_cents: refunded,
    stripe_fee_cents: captured ? (stripeFee == null ? null : stripeFee) : null, stripe_refund_fee_cents: null, stripe_refund_fee_refunded_cents: null });
  return { pi, total, premium, tax };
}
const paidGuard = (t) => engine.assertMarkPaidAllowed({ hasSettlementRow: true, settlementStatus: 'pending_review', openDisputes: 0,
  processingIncomplete: t.processing_fee_complete === false, processingIncompleteReason: t.processing_fee_incomplete_reason,
  netProceedsCents: t.net_seller_proceeds_cents, payoutPreferenceComplete: true },
{ paymentMethod: 'check', paymentReference: 'CHK-1', paidAt: '2026-10-08', confirmedCompleted: true, finalAmountCents: t.net_seller_proceeds_cents });
const transferGuard = (t) => engine.assertPaySellerAllowed({ hasSettlementRow: true, settlementStatus: 'pending_review', openDisputes: 0,
  processingIncomplete: t.processing_fee_complete === false, processingIncompleteReason: t.processing_fee_incomplete_reason,
  existingTransferId: null, payoutMethod: 'ach', connectReady: true, netProceedsCents: t.net_seller_proceeds_cents },
{ confirmedCompleted: true, finalAmountCents: t.net_seller_proceeds_cents });

beforeEach(() => {
  mockState.auctions = new Map(); mockState.invoices = []; mockState.payments = []; mockState.lots = []; mockState.updates = [];
  mockState.stripe = { intents: new Map(), refunds: new Map(), fail: false };
});

describe('Auction Partner settlement: actual Stripe processing, 0% platform fee', () => {
  test('A. $100 + 20% premium, no tax: seller keeps $120, actual $3.78 deducted, no platform fee, no 3%-of-hammer', async () => {
    const a = auction(); const b = buyer(a, { hammer: 10000, stripeFee: 378 });
    expect(b.total).toBe(12000);
    const t = await engine.computeSettlement(a);
    expect(t.seller_collected_cents).toBe(12000);                       // hammer + seller's own premium
    expect(t.seller_platform_fee_cents).toBe(0);
    expect(t.credit_card_processing_fee_cents).toBe(378);               // == Stripe's actual fee
    expect(t.credit_card_processing_fee_cents).not.toBe(300);           // not 3% of hammer
    expect(t.processing_fee_basis).toBe('actual_stripe');
    expect(t.processing_fee_complete).toBe(true);
    expect(t.net_seller_proceeds_cents).toBe(11622);
    expect(() => paidGuard(t)).not.toThrow();
  });

  test('B. with 8.25% tax: tax excluded from proceeds; the full $4.07 actual fee (charged on $129.90) is the deduction, so Advantage.Bid absorbs $0', async () => {
    const a = auction(); const b = buyer(a, { hammer: 10000, taxBps: 825, stripeFee: 407 });
    expect([b.tax, b.total]).toEqual([990, 12990]);
    const t = await engine.computeSettlement(a);
    expect(t.sales_tax_collected_cents).toBe(990);
    expect(t.seller_collected_cents).toBe(12000);                       // tax is never seller proceeds
    expect(t.credit_card_processing_fee_cents).toBe(407);
    const advantageNet = t.credit_card_processing_fee_cents + t.seller_platform_fee_cents - 407;   // what it keeps minus what Stripe charged it
    expect(advantageNet).toBe(0);                                        // no markup, no subsidy
    expect(t.net_seller_proceeds_cents).toBe(11593);
  });

  test('C. $1,000 + 20% premium + 8.25% tax: exact money flow', async () => {
    const a = auction(); const b = buyer(a, { hammer: 100000, taxBps: 825, stripeFee: 3797 });
    expect([b.premium, b.tax, b.total]).toEqual([20000, 9900, 129900]);
    const t = await engine.computeSettlement(a);
    expect(t.buyer_payments_collected_cents).toBe(129900);
    expect(t.sales_tax_collected_cents).toBe(9900);
    expect(t.seller_collected_cents).toBe(120000);
    expect(t.seller_platform_fee_cents).toBe(0);
    expect(t.credit_card_processing_fee_cents).toBe(3797);
    expect(t.net_seller_proceeds_cents).toBe(116203);
    expect(t.final_payout_cents).toBe(116203);
  });

  test('D. multiple buyers: each payment\'s actual fee aggregates into the one auction (captured from Stripe where not yet stored)', async () => {
    const a = auction();
    buyer(a, { hammer: 10000, taxBps: 825, stripeFee: 407 });
    buyer(a, { hammer: 100000, taxBps: 825, stripeFee: 3797, captured: false });   // not yet in our DB: read from Stripe
    buyer(a, { hammer: 10000, stripeFee: 378 });
    const t = await engine.computeSettlement(a);
    expect(t.credit_card_processing_fee_cents).toBe(407 + 3797 + 378);
    expect(t.seller_collected_cents).toBe(12000 + 120000 + 12000);
    expect(t.net_seller_proceeds_cents).toBe(144000 - 4582);
    expect(mockState.updates.some((u) => /SET stripe_fee_cents/.test(u))).toBe(true);   // the real fee was recorded
  });

  test('D2. a payment always belongs to exactly one auction (no charge is split between sellers)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'paymentService.js'), 'utf8');
    const inserts = src.match(/INSERT INTO payments \(auction_id, lot_id, buyer_user_id, amount_cents, status, payment_intent_id\)/g) || [];
    expect(inserts.length).toBe(3);                                       // per-lot, combined off-session, combined on-session
    expect(require('fs').readFileSync(require('path').join(__dirname, '..', 'db', 'migrations', '186_auction_partner_actual_processing.sql'), 'utf8')).toMatch(/processing_fee_basis/);
  });

  test('E. actual fee unavailable: settlement is INCOMPLETE, cannot be paid or transferred, and never falls back to 3% of hammer', async () => {
    const a = auction();
    buyer(a, { hammer: 10000, stripeFee: 378 });
    buyer(a, { hammer: 100000, taxBps: 825, stripeFee: null, captured: false });   // Stripe has no balance transaction yet
    const t = await engine.computeSettlement(a);
    expect(t.processing_fee_complete).toBe(false);
    expect(t.processing_fee_incomplete_reason).toMatch(/could not be verified for 1 buyer payment/);
    expect(t.credit_card_processing_fee_cents).toBe(378);                // only what is verified; never 3% of $1,100
    expect(t.credit_card_processing_fee_cents).not.toBe(3300);
    expect(() => paidGuard(t)).toThrow(/could not be verified/);
    expect(() => transferGuard(t)).toThrow(/could not be verified/);
    mockState.stripe.fail = true;                                         // Stripe unreachable: still incomplete, still blocked
    const t2 = await engine.computeSettlement(a);
    expect(t2.processing_fee_complete).toBe(false);
  });

  test('E2. the pure formula fails safe when a caller supplies no actual figures', () => {
    const t = engine.computeSettlementTotals({ grossSalesCents: 10000, sellerCollectedCents: 12000, buyerPaymentsCollectedCents: 12000,
      sellerType: 'estate_sale_company', sellerPlatformFeeBps: 0, pricingModel: 'v2_separated', processingFeeBps: 300, processingFeeBasis: 'actual_stripe' });
    expect(t.processing_fee_complete).toBe(false);
    expect(t.credit_card_processing_fee_cents).toBe(0);
    expect(() => paidGuard(t)).toThrow();
  });

  test('J. refund: Stripe kept the fee → the seller bears the actual fee; Stripe returned it → net actual; refund not verifiable → blocked', async () => {
    // Kept: full refund of payment B; Stripe's refund balance transaction carries no fee return.
    const a = auction();
    const b = buyer(a, { hammer: 10000, taxBps: 825, stripeFee: 407, refunded: 12990, status: 'refunded' });
    mockState.stripe.refunds.set(b.pi, [{ status: 'succeeded', amount: 12990, balance_transaction: { fee: 0 } }]);
    const t = await engine.computeSettlement(a);
    expect(t.processing_fee_complete).toBe(true);
    expect(t.credit_card_processing_fee_cents).toBe(407);
    expect(mockState.payments[0].stripe_refund_fee_refunded_cents).toBe(12990);
    // Returned: Stripe gave the fee back on the refund (negative fee on the refund transaction).
    const a2 = auction();
    const b2 = buyer(a2, { hammer: 10000, taxBps: 825, stripeFee: 407, refunded: 12990, status: 'refunded' });
    mockState.stripe.refunds.set(b2.pi, [{ status: 'succeeded', amount: 12990, balance_transaction: { fee: -407 } }]);
    expect((await engine.computeSettlement(a2)).credit_card_processing_fee_cents).toBe(0);
    // Not verifiable: refund totals disagree with our record → incomplete, not guessed.
    const a3 = auction();
    const b3 = buyer(a3, { hammer: 10000, stripeFee: 378, refunded: 5000, status: 'partially_refunded' });
    mockState.stripe.refunds.set(b3.pi, [{ status: 'succeeded', amount: 4000, balance_transaction: { fee: 0 } }]);
    const t3 = await engine.computeSettlement(a3);
    expect(t3.processing_fee_complete).toBe(false);
    expect(t3.processing_fee_incomplete_reason).toMatch(/after a refund/);
  });

  test('J2. a later refund invalidates an earlier refund-fee record', () => {
    const agg = actual.aggregate([{ id: 'p', status: 'partially_refunded', stripe_fee_cents: 378, refunded_amount_cents: 6000,
      stripe_refund_fee_cents: 0, stripe_refund_fee_refunded_cents: 3000 }]);
    expect(agg.complete).toBe(false);
  });
});

describe('everything else is unchanged', () => {
  test('F. ordinary Professional Seller: 4% platform + 3%-of-hammer policy processing (actual Stripe cost NOT deducted)', async () => {
    const a = auction({ basis: 'policy_rate', platformBps: 400 });
    buyer(a, { hammer: 100000, taxBps: 825, stripeFee: 3797 });
    const t = await engine.computeSettlement(a);
    expect(t.seller_platform_fee_cents).toBe(4000);
    expect(t.credit_card_processing_fee_cents).toBe(3000);
    expect(t.actual_stripe_cost_cents).toBe(3797);                       // reconciliation only
    expect(t.processing_fee_complete).toBe(true);
    expect(t.net_seller_proceeds_cents).toBe(120000 - 4000 - 3000);
    // NULL basis (every auction published before migration 186) behaves exactly the same.
    const a2 = auction({ basis: null, platformBps: 400 });
    buyer(a2, { hammer: 100000, taxBps: 825, stripeFee: 3797 });
    expect((await engine.computeSettlement(a2)).credit_card_processing_fee_cents).toBe(3000);
    // The close-time model too.
    const s = billing.settlement({ sellerType: 'estate_sale_company', hammerCents: 100000, buyerPremiumCents: 20000, platformFeeBps: 400, processingFeeBps: 300, pricingModel: 'v2_separated' });
    expect([s.platform_fee_cents, s.processing_fee_cents, s.seller_payout_cents]).toEqual([4000, 3000, 113000]);
    expect(s.processing_fee_basis).toBeUndefined();
  });

  test('F2. a 0% basis flag on a LEGACY auction is ignored (legacy economics untouched)', async () => {
    const a = auction({ basis: 'actual_stripe', model: 'legacy', platformBps: 400 });
    buyer(a, { hammer: 10000, stripeFee: 378 });
    const t = await engine.computeSettlement(a);
    expect(t.processing_fee_basis).toBe('legacy_actual');
    expect(t.processing_fee_complete).toBe(true);
  });

  test('G. Individual Seller: 0% platform, 3%-of-hammer processing, Advantage.Bid keeps the 18% premium', async () => {
    const a = auction({ basis: 'policy_rate', sellerType: 'private', platformBps: 400 });
    buyer(a, { hammer: 10000, premiumBps: 1800, stripeFee: 372 });
    const t = await engine.computeSettlement(a);
    expect(t.seller_platform_fee_cents).toBe(0);
    expect(t.advantage_premium_collected_cents).toBe(1800);
    expect(t.seller_collected_cents).toBe(10000);
    expect(t.credit_card_processing_fee_cents).toBe(300);
    const s = billing.settlement({ sellerType: 'private', hammerCents: 10000, buyerPremiumCents: 1800, platformFeeBps: 400, processingFeeBps: 300, pricingModel: 'v2_separated' });
    expect([s.platform_fee_cents, s.processing_fee_cents, s.seller_payout_cents]).toEqual([0, 300, 9700]);
  });

  test('H. Storefront stays a flat 11% (Auction Partner terms never reach it)', () => {
    expect(marketplaceOrders.STOREFRONT_FEE_BPS).toBe(1100);
    expect(marketplaceOrders.feeBpsForSeller({ platform_fee_bps: 0 })).toBe(1100);
    expect(marketplaceOrders.computeBreakdown({ itemPriceCents: 10000, shippingCents: 0, taxCents: 0, feeBps: 1100 }).platform_fee_cents).toBe(1100);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'marketplaceOrderService.js'), 'utf8');
    expect(src).not.toMatch(/processing_fee_basis|actualProcessing/);
  });

  test('close-time payout model: an Auction Partner auction records processing as PENDING (never 3%) until the actual fee is known', () => {
    const pending = billing.settlement({ sellerType: 'estate_sale_company', hammerCents: 100000, buyerPremiumCents: 20000, platformFeeBps: 0, processingFeeBps: 300,
      pricingModel: 'v2_separated', processingFeeBasis: 'actual_stripe' });
    expect([pending.platform_fee_cents, pending.processing_fee_cents, pending.processing_fee_pending]).toEqual([0, 0, true]);
    const known = billing.settlement({ sellerType: 'estate_sale_company', hammerCents: 100000, buyerPremiumCents: 20000, platformFeeBps: 0, processingFeeBps: 300,
      pricingModel: 'v2_separated', processingFeeBasis: 'actual_stripe', actualProcessingCents: 3797 });
    expect([known.processing_fee_cents, known.seller_payout_cents, known.processing_fee_pending]).toEqual([3797, 116203, false]);
  });

  test('seller statement labels the pass-through and shows it pending while unverified', () => {
    const v = sellerSettlementDetailView({ auctionId: 'a', auction: {}, sp: { settlement_status: 'pending_review' },
      totals: { processing_fee_basis: 'actual_stripe', processing_fee_complete: false, credit_card_processing_fee_cents: 378, gross_sales_cents: 10000 } });
    expect(v.payment_processing_label).toBe('Payment Processing (actual card-processing charges)');
    expect(v.payment_processing_pct).toBe('pending');
    expect(v.payment_processing_pending).toBe(true);
    const ordinary = sellerSettlementDetailView({ auctionId: 'a', auction: {}, sp: null, totals: { processing_fee_basis: 'policy_rate', credit_card_processing_fee_cents: 3000, gross_sales_cents: 100000 } });
    expect([ordinary.payment_processing_label, ordinary.payment_processing_pct]).toEqual(['Payment Processing', '3.00%']);
  });

  test('payout language: "processes eligible seller payouts every Thursday", never "deposited"', () => {
    const fs = require('fs'); const path = require('path');
    for (const f of ['docs/legal/auction-partner-program-addendum-v1.md', 'src/services/sasha/tools.js']) {
      const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(t).toMatch(/processes eligible seller payouts every Thursday/);
      expect(t).not.toMatch(/deposited every Thursday|automatically (paid|deposited)/i);
    }
    const addendum = fs.readFileSync(path.join(__dirname, '..', 'docs/legal/auction-partner-program-addendum-v1.md'), 'utf8');
    expect(addendum).not.toMatch(/2\.9%|completely free/i);
    expect(addendum).toMatch(/does \*\*not\*\* mark up/);
  });
});
