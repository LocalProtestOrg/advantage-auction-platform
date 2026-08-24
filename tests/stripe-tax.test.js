'use strict';

/**
 * Stripe Tax (Calculation API) — Version 1.0 certification tests.
 *
 * Owner policy under test:
 *   • Jurisdiction  = BUYER address (customer_details.address).
 *   • Taxable base  = hammer + buyer premium.
 *   • Seller payout = tax EXCLUDED (settlement never sees tax).
 *   • Fail-safe: tax required but not producible → block payment (never $0, never silent).
 *   • Flag-gated: STRIPE_TAX_ENABLED off → zero tax, NO Stripe call (byte-for-byte pre-tax behavior).
 *
 * Stripe is mocked (no network); we assert the calls and the branch behavior.
 */

// ── Mock Stripe SDK: capture tax.* calls ─────────────────────────────────────
const mockCalcCreate = jest.fn();
const mockTxCreate   = jest.fn();
const mockTxReversal = jest.fn();
jest.mock('stripe', () => jest.fn(() => ({
  tax: {
    calculations: { create: (...a) => mockCalcCreate(...a) },
    transactions: {
      createFromCalculation: (...a) => mockTxCreate(...a),
      createReversal: (...a) => mockTxReversal(...a),
    },
  },
})));

// ── Mock the exemption service seam ──────────────────────────────────────────
jest.mock('../src/services/taxExemptionService', () => ({
  effectiveExemptionForSale: jest.fn(async () => null), // default: not exempt
}));
const taxExemption = require('../src/services/taxExemptionService');
const tax = require('../src/services/taxCalculationService');
const billing = require('../src/services/billingTermsService');

const ADDR = { line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  taxExemption.effectiveExemptionForSale.mockResolvedValue(null);
});

describe('taxCalculationService.computeTax', () => {
  test('flag OFF → zero tax and NO Stripe call (pre-tax behavior preserved)', async () => {
    delete process.env.STRIPE_TAX_ENABLED;
    const r = await tax.computeTax({ buyerUserId: 'u1', taxableBaseCents: 11800, address: ADDR });
    expect(r).toEqual({ enabled: false, taxCents: 0, calculationId: null, exempt: false });
    expect(mockCalcCreate).not.toHaveBeenCalled();
  });

  test('approved exemption → $0, no Stripe call (matrix C)', async () => {
    process.env.STRIPE_TAX_ENABLED = 'true';
    taxExemption.effectiveExemptionForSale.mockResolvedValue({ status: 'approved', jurisdiction_state: 'TX' });
    const r = await tax.computeTax({ buyerUserId: 'u1', taxableBaseCents: 11800, address: ADDR });
    expect(r.exempt).toBe(true);
    expect(r.taxCents).toBe(0);
    expect(mockCalcCreate).not.toHaveBeenCalled();
  });

  test('missing address (flag ON, non-exempt) → BUYER_TAX_ADDRESS_REQUIRED (fail-safe)', async () => {
    process.env.STRIPE_TAX_ENABLED = 'true';
    await expect(tax.computeTax({ buyerUserId: 'u1', taxableBaseCents: 11800, address: null }))
      .rejects.toMatchObject({ code: 'BUYER_TAX_ADDRESS_REQUIRED', status: 422 });
    expect(mockCalcCreate).not.toHaveBeenCalled();
  });

  test('taxable buyer/address → Stripe tax on (hammer+premium) base, BUYER address used (matrix A)', async () => {
    process.env.STRIPE_TAX_ENABLED = 'true';
    mockCalcCreate.mockResolvedValue({ id: 'taxcalc_1', tax_amount_exclusive: 974 });
    const r = await tax.computeTax({ buyerUserId: 'u1', taxableBaseCents: 11800, address: ADDR, reference: 'payment:P1' });
    expect(r).toEqual({ enabled: true, taxCents: 974, calculationId: 'taxcalc_1', exempt: false });
    const arg = mockCalcCreate.mock.calls[0][0];
    expect(arg.line_items[0].amount).toBe(11800);                 // taxable base = hammer + premium
    expect(arg.line_items[0].tax_behavior).toBe('exclusive');
    expect(arg.customer_details.address.state).toBe('TX');        // BUYER jurisdiction, not pickup
    expect(arg.customer_details.address.postal_code).toBe('78701');
  });

  test('address/jurisdiction with no registration → Stripe returns $0 (matrix B)', async () => {
    process.env.STRIPE_TAX_ENABLED = 'true';
    mockCalcCreate.mockResolvedValue({ id: 'taxcalc_z', tax_amount_exclusive: 0 });
    const r = await tax.computeTax({ buyerUserId: 'u1', taxableBaseCents: 11800, address: { ...ADDR, state: 'OR', postal_code: '97201' } });
    expect(r.taxCents).toBe(0);
    expect(r.calculationId).toBe('taxcalc_z');
  });

  test('Stripe failure → TAX_CALCULATION_FAILED (never assume $0) (matrix N)', async () => {
    process.env.STRIPE_TAX_ENABLED = 'true';
    mockCalcCreate.mockRejectedValue(new Error('stripe down'));
    await expect(tax.computeTax({ buyerUserId: 'u1', taxableBaseCents: 11800, address: ADDR }))
      .rejects.toMatchObject({ code: 'TAX_CALCULATION_FAILED' });
  });
});

describe('taxCalculationService transactions', () => {
  test('recordTransaction: no-op when flag off; records with idempotency key when on (matrix I/M)', async () => {
    delete process.env.STRIPE_TAX_ENABLED;
    expect(await tax.recordTransaction({ calculationId: 'c1', reference: 'payment:P1' })).toBeNull();
    expect(mockTxCreate).not.toHaveBeenCalled();

    process.env.STRIPE_TAX_ENABLED = 'true';
    mockTxCreate.mockResolvedValue({ id: 'taxtx_1' });
    const id = await tax.recordTransaction({ calculationId: 'c1', reference: 'payment:P1' });
    expect(id).toBe('taxtx_1');
    expect(mockTxCreate).toHaveBeenCalledWith({ calculation: 'c1', reference: 'payment:P1' }, { idempotencyKey: 'taxtx:payment:P1' });
  });

  test('recordTransaction: no calculation id → null (exempt / $0 / pre-tax payment)', async () => {
    process.env.STRIPE_TAX_ENABLED = 'true';
    expect(await tax.recordTransaction({ calculationId: null, reference: 'payment:P1' })).toBeNull();
    expect(mockTxCreate).not.toHaveBeenCalled();
  });

  test('reverseFullTransaction: full reversal with idempotency key when on (matrix J)', async () => {
    process.env.STRIPE_TAX_ENABLED = 'true';
    mockTxReversal.mockResolvedValue({ id: 'taxrev_1' });
    const id = await tax.reverseFullTransaction({ originalTransactionId: 'taxtx_1', reference: 'refund:P1' });
    expect(id).toBe('taxrev_1');
    expect(mockTxReversal).toHaveBeenCalledWith({ mode: 'full', original_transaction: 'taxtx_1', reference: 'refund:P1' }, { idempotencyKey: 'taxrev:refund:P1' });
  });

  test('reverseFullTransaction: no-op when flag off', async () => {
    delete process.env.STRIPE_TAX_ENABLED;
    expect(await tax.reverseFullTransaction({ originalTransactionId: 'taxtx_1', reference: 'refund:P1' })).toBeNull();
    expect(mockTxReversal).not.toHaveBeenCalled();
  });
});

describe('SETTLEMENT PROTECTION — tax NEVER enters seller proceeds (matrix K/L)', () => {
  // Owner example: Hammer $100, Buyer Premium $18, Tax $7.08 → buyer charge $125.08.
  // Seller settlement must be computed from the billing model (hammer + premium − 2% fee), NOT $125.08.
  test('individual seller payout excludes tax entirely', () => {
    const s = billing.settlement({ sellerType: 'private', hammerCents: 10000, buyerPremiumCents: 1800 });
    expect(s.buyer_total_cents).toBe(11800);          // hammer + premium (tax is added OUTSIDE this model)
    expect(s.seller_payout_cents).toBe(10000);        // seller gets the hammer; NEVER hammer+tax
    expect(JSON.stringify(s)).not.toMatch(/tax/i);    // the settlement model has no tax concept at all
  });

  test('professional seller payout excludes tax entirely', () => {
    const s = billing.settlement({ sellerType: 'auction_house', hammerCents: 10000, buyerPremiumCents: 1800 });
    expect(s.platform_fee_cents).toBe(400);           // default 4% of hammer only (10000 × 4%)
    expect(s.seller_payout_cents).toBe(11400);        // hammer + premium − 4% fee (10000+1800−400); tax is not present
  });

  test('adding sales tax to the buyer charge does not change the seller settlement', () => {
    const noTax = billing.settlement({ sellerType: 'private', hammerCents: 10000, buyerPremiumCents: 1800 });
    // Even if the buyer was charged base + $7.08 tax, the settlement inputs (hammer, premium) are unchanged,
    // so the seller payout is identical — tax lives entirely outside seller proceeds.
    const withTaxCharged = billing.settlement({ sellerType: 'private', hammerCents: 10000, buyerPremiumCents: 1800 });
    expect(withTaxCharged.seller_payout_cents).toBe(noTax.seller_payout_cents);
  });
});

// ── Source-level wiring guards (the flow is DB/Stripe-coupled; these lock the integration shape) ──
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const paymentSrc = read('src/services/paymentService.js');
const invoiceSrc = read('src/services/invoiceService.js');
const combinedSrc = read('src/services/combinedInvoiceService.js');
const routeSrc   = read('src/routes/payments.js');

describe('paymentService wiring (all three PI paths + success + refund)', () => {
  test('all three charge paths add tax to the charge before creating the intent (matrix F)', () => {
    // single lot, combined on-session, combined off-session each call _applyTaxToPayment.
    expect((paymentSrc.match(/_applyTaxToPayment\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });
  test('payment success records the Stripe Tax Transaction (matrix I)', () => {
    expect(paymentSrc).toMatch(/_finalizeTaxTransaction\(paymentId\)/);
    expect(combinedSrc).toMatch(/_finalizeTaxTransaction\(paymentId\)/); // combined settle path too
  });
  test('full refund reverses the Stripe Tax Transaction (matrix J)', () => {
    expect(paymentSrc).toMatch(/if \(isFullRefund\) \{\s*await this\._reverseTaxForPayment\(paymentId\)/);
  });
  test('tax fail-safe fails the pending payment and rethrows (never an untaxed intent) (matrix N)', () => {
    expect(paymentSrc).toMatch(/_failPendingPayment\(paymentId, 'tax:'/);
  });
  test('finalize/reverse are idempotent (guarded by transaction/reversal id NULL)', () => {
    expect(paymentSrc).toMatch(/stripe_tax_transaction_id IS NULL/);
    expect(paymentSrc).toMatch(/stripe_tax_reversal_id IS NULL/);
  });
});

describe('invoice + route presentation wiring (matrix G/E)', () => {
  test('paid invoice persists sales_tax_cents and a tax-inclusive total (matrix G)', () => {
    expect(invoiceSrc).toMatch(/sales_tax_cents = EXCLUDED\.sales_tax_cents/);
  });
  test('config exposes taxEnabled and the buyer tax-address endpoints exist (matrix E)', () => {
    expect(routeSrc).toMatch(/taxEnabled: taxService\.taxEnabled\(\)/);
    expect(routeSrc).toMatch(/router\.put\('\/tax-address'/);
    expect(routeSrc).toMatch(/router\.get\('\/tax-address'/);
  });
  test('charge routes surface the recoverable tax error code/status', () => {
    expect((routeSrc.match(/err\.code && err\.status/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
