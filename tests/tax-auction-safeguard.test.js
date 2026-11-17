'use strict';
/**
 * Auction sales tax safeguard (owner 2026-11-16; services/tax/taxPolicy; the gap found in the 2026-11-16 audit: an
 * auction payment was charged $0 tax wherever the tax calculation was not collecting).
 *
 * Proves, for the decision itself and for the one place every auction payment calculates tax (_applyTaxToPayment):
 * a taxable sale is charged its tax and recorded as platform-remitted; an approved exemption and a non-taxable item are
 * $0 for the right recorded reason; a seller-responsible state collects nothing; a missing registration, a rule and
 * registration that disagree, and (with enforcement on) a state with no rule HOLD the payment with nothing charged and
 * an administrator alerted; report mode changes nothing about the charge but records what happened; an administrator
 * exception lets held buyers pay and is recorded; the retired 'seller' rule is treated as no rule.
 */

const mockQueries = [];
let mockRule = null; let mockMode = 'report'; let mockException = null; let mockCategoryRows = [];
jest.mock('../src/db', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (/FROM marketplace_tax_jurisdictions/.test(sql)) return { rows: mockRule ? [mockRule] : [] };
    if (/tax\.auction_enforcement/.test(sql)) return { rows: [{ value: mockMode }] };
    if (/FROM tax_payment_exceptions/.test(sql)) return { rows: mockException ? [mockException] : [] };
    if (/FROM tax_category_codes/.test(sql)) return { rows: mockCategoryRows };
    if (/INSERT INTO tax_alerts/.test(sql)) return { rows: [{ id: 1, created: true }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }),
  connect: jest.fn(),
}));
let mockTax = null;
jest.mock('../src/services/taxCalculationService', () => ({
  taxEnabled: () => mockTax !== 'off',
  computeTax: jest.fn(async () => {
    if (mockTax instanceof Error) throw mockTax;
    return mockTax;
  }),
  TaxCalculationError: class extends Error {},
  addressComplete: () => true,
}));
jest.mock('../src/services/ownerAlertService', () => ({ notifyAdminActionRequired: jest.fn(async () => ({})) }));
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn(async () => {}) }));

const taxPolicy = require('../src/services/tax/taxPolicy');
const taxService = require('../src/services/taxCalculationService');
const ownerAlert = require('../src/services/ownerAlertService');
const paymentService = require('../src/services/paymentService');

const TAXED = { enabled: true, taxCents: 782, calculationId: 'taxcalc_1', exempt: false, collecting: true, detail: { taxable_cents: 11800, jurisdictions: [{ name: 'New Jersey', level: 'state', amount_cents: 782 }] } };
const EXEMPT = { enabled: true, taxCents: 0, calculationId: null, exempt: true };
const NOT_TAXABLE = { enabled: true, taxCents: 0, calculationId: 'taxcalc_2', exempt: false, collecting: true };
const NOT_COLLECTING = { enabled: true, taxCents: 0, calculationId: 'taxcalc_3', exempt: false, collecting: false };
const OFF = { enabled: false, taxCents: 0, calculationId: null, exempt: false };
const PLATFORM = { state: 'NJ', remitter: 'platform' }; const DIRECT = { state: 'PA', remitter: 'seller_direct' }; const RETIRED = { state: 'TX', remitter: 'seller' };

describe('the decision (pure)', () => {
  const d = (rule, tax, mode = 'report', exception = null) => taxPolicy.decideAuction({ rule, tax, mode, exception });
  test('Advantage.Bid collects: taxable, exempt, non-taxable, and not collecting', () => {
    expect(d(PLATFORM, TAXED)).toEqual({ action: 'charge', taxCents: 782, remitter: 'platform', basis: 'taxed', keepCalculation: true });
    expect(d(PLATFORM, EXEMPT)).toMatchObject({ action: 'charge', taxCents: 0, remitter: 'none', basis: 'exempt' });
    expect(d(PLATFORM, NOT_TAXABLE)).toMatchObject({ action: 'charge', taxCents: 0, remitter: 'none', basis: 'not_taxable' });
    expect(d(PLATFORM, NOT_COLLECTING)).toEqual({ action: 'hold', code: 'TAX_NOT_COLLECTING' });
    expect(d(PLATFORM, NOT_COLLECTING, 'enforce')).toEqual({ action: 'hold', code: 'TAX_NOT_COLLECTING' });   // held in either mode: the rule is explicit
  });
  test('the seller is responsible: nothing is collected, and a calculation that disagrees is held', () => {
    expect(d(DIRECT, NOT_COLLECTING)).toEqual({ action: 'charge', taxCents: 0, remitter: 'seller_direct', basis: 'seller_direct', keepCalculation: false });
    expect(d(DIRECT, EXEMPT)).toMatchObject({ action: 'charge', taxCents: 0, remitter: 'seller_direct' });
    expect(d(DIRECT, TAXED)).toEqual({ action: 'hold', code: 'TAX_CONFIGURATION_CONFLICT' });
  });
  test('no rule is never permission to collect nothing: enforced it holds, in report mode it is recorded as unconfigured', () => {
    expect(d(null, NOT_COLLECTING, 'enforce')).toEqual({ action: 'hold', code: 'TAX_CONFIGURATION_REQUIRED' });
    expect(d(null, TAXED, 'enforce')).toEqual({ action: 'hold', code: 'TAX_CONFIGURATION_REQUIRED' });
    expect(d(null, NOT_COLLECTING, 'report')).toMatchObject({ action: 'charge', taxCents: 0, remitter: 'unconfigured', basis: 'unconfigured' });
    expect(d(null, TAXED, 'report')).toMatchObject({ action: 'charge', taxCents: 782, remitter: 'platform', basis: 'taxed' });
  });
  test("the retired 'seller' rule is treated as no rule", () => {
    expect(d(RETIRED, TAXED, 'enforce')).toEqual({ action: 'hold', code: 'TAX_CONFIGURATION_REQUIRED' });
    expect(d(RETIRED, NOT_COLLECTING, 'report')).toMatchObject({ remitter: 'unconfigured' });
  });
  test('an administrator exception lets held buyers pay and is recorded as an exception', () => {
    const ex = { id: 'e1', decision: 'proceed_tax_not_collected' };
    expect(d(null, NOT_COLLECTING, 'enforce', ex)).toMatchObject({ action: 'charge', taxCents: 0, remitter: 'exception', basis: 'exception' });
    expect(d(PLATFORM, NOT_COLLECTING, 'enforce', ex)).toMatchObject({ action: 'charge', taxCents: 0, remitter: 'exception' });
    expect(d(DIRECT, TAXED, 'enforce', ex)).toEqual({ action: 'hold', code: 'TAX_CONFIGURATION_CONFLICT' });   // a conflict is fixed, not excepted
  });
  test('tax calculation switched off entirely: nothing changes', () => {
    expect(d(null, OFF, 'enforce')).toMatchObject({ action: 'charge', taxCents: 0, remitter: null, basis: 'tax_off' });
  });
  test('the hold message tells the buyer nothing internal', () => {
    const e = new taxPolicy.TaxHoldError('TAX_NOT_COLLECTING', { state: 'NJ' });
    expect(e).toMatchObject({ status: 409, code: 'TAX_NOT_COLLECTING', taxHold: true });
    expect(e.message).toMatch(/Nothing has been charged/);
    expect(e.message).not.toMatch(/registration|NJ|rule|Stripe/i);
  });
});

describe('every auction payment path (_applyTaxToPayment)', () => {
  const apply = () => paymentService._applyTaxToPayment({ paymentId: 'pay-1', buyerUserId: 'buyer-1', taxableBaseCents: 11800 });
  const paymentUpdate = () => mockQueries.find((x) => /UPDATE payments\s+SET amount_cents/.test(x.sql));
  const alertInserts = () => mockQueries.filter((x) => /INSERT INTO tax_alerts/.test(x.sql));
  beforeEach(() => {
    mockQueries.length = 0; mockRule = null; mockMode = 'report'; mockException = null; mockCategoryRows = []; mockTax = TAXED;
    taxPolicy.clearCache(); require('../src/services/tax/taxCategoryService').clearCache();
    taxService.computeTax.mockClear(); ownerAlert.notifyAdminActionRequired.mockClear();
    jest.spyOn(paymentService, '_loadSaleLocation').mockResolvedValue({ auctionId: 'auc-1', missing: [],
      address: { line1: '1 Main St', city: 'Jersey City', state: 'NJ', postal_code: '07302', country: 'US' } });
  });
  afterEach(() => jest.restoreAllMocks());

  test('taxable sale under a platform rule: tax added, and the remitter, state, reason and detail are recorded', async () => {
    mockRule = PLATFORM;
    await expect(apply()).resolves.toBe(11800 + 782);
    const u = paymentUpdate();
    expect(u.params).toEqual([12582, 11800, 782, 'taxcalc_1', 'pay-1', 'platform', 'NJ', 'taxed', JSON.stringify(TAXED.detail)]);
    expect(alertInserts()).toHaveLength(0);
  });
  test('platform rule but tax is not being collected: held, nothing charged, administrator alerted once', async () => {
    mockRule = PLATFORM; mockTax = NOT_COLLECTING;
    await expect(apply()).rejects.toMatchObject({ taxHold: true, code: 'TAX_NOT_COLLECTING', status: 409 });
    expect(paymentUpdate()).toBeUndefined();                       // the amount was never changed
    expect(alertInserts()).toHaveLength(1);
    expect(alertInserts()[0].params[1]).toBe('payment_hold');
    expect(ownerAlert.notifyAdminActionRequired).toHaveBeenCalledTimes(1);
  });
  test('enforcement on and no rule: held', async () => {
    mockMode = 'enforce'; mockTax = NOT_COLLECTING;
    await expect(apply()).rejects.toMatchObject({ code: 'TAX_CONFIGURATION_REQUIRED' });
    expect(paymentUpdate()).toBeUndefined();
  });
  test('report mode and no rule: the charge is exactly as before, recorded as unconfigured, and reported', async () => {
    mockTax = NOT_COLLECTING;
    await expect(apply()).resolves.toBe(11800);
    expect(paymentUpdate().params.slice(0, 8)).toEqual([11800, 11800, 0, 'taxcalc_3', 'pay-1', 'unconfigured', 'NJ', 'unconfigured']);
    expect(alertInserts()[0].params[1]).toBe('auction_untaxed');
  });
  test('seller-responsible state: no tax, no tax transaction kept, recorded as seller_direct', async () => {
    mockRule = DIRECT; mockTax = NOT_COLLECTING;
    await expect(apply()).resolves.toBe(11800);
    expect(paymentUpdate().params.slice(2, 8)).toEqual([0, null, 'pay-1', 'seller_direct', 'NJ', 'seller_direct']);
  });
  test('approved exemption under a platform rule: $0, recorded as exempt', async () => {
    mockRule = PLATFORM; mockTax = EXEMPT;
    await expect(apply()).resolves.toBe(11800);
    expect(paymentUpdate().params.slice(5, 8)).toEqual(['none', 'NJ', 'exempt']);
  });
  test('an exception recorded by an administrator releases the hold and is recorded', async () => {
    mockRule = PLATFORM; mockTax = NOT_COLLECTING; mockException = { id: 'e1', decision: 'proceed_tax_not_collected', reason: 'r' };
    await expect(apply()).resolves.toBe(11800);
    expect(paymentUpdate().params.slice(5, 8)).toEqual(['exception', 'NJ', 'exception']);
    expect(alertInserts()[0].params[1]).toBe('auction_untaxed');
  });
  test('a tax calculation failure still fails safe (no charge, no policy decision)', async () => {
    mockRule = PLATFORM; mockTax = Object.assign(new Error('Sales tax could not be calculated right now.'), { code: 'TAX_CALCULATION_FAILED', status: 502 });
    await expect(apply()).rejects.toMatchObject({ code: 'TAX_CALCULATION_FAILED' });
    expect(paymentUpdate()).toBeUndefined();
  });
  test('tax switched off: no calculation, no rule lookup, the amount is returned unchanged', async () => {
    mockTax = 'off';
    await expect(apply()).resolves.toBe(11800);
    expect(taxService.computeTax).not.toHaveBeenCalled();
    expect(mockQueries).toHaveLength(0);
  });
});

describe('wiring', () => {
  const fs = require('fs'); const path = require('path');
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');
  test('a held combined charge is not a payment request to the buyer', () => {
    expect(src('paymentService.js')).toMatch(/if \(taxErr\.taxHold\) return \{ status: 'tax_hold'/);
    expect(src('auctionService.js')).toMatch(/r\.status === 'tax_hold'/);
  });
  test('publication checks the pickup state through the same policy', () => {
    expect(src('auctionService.js')).toMatch(/auctionPublicationCheck\(current\.rows\[0\]\.address_state, client\)/);
  });
  test('both seller payout paths check the tax reserve before creating a transfer', () => {
    for (const f of ['settlementEngine.js', 'storefrontSettlementService.js']) {
      const s = src(f);
      expect(s.indexOf('assertTransferLeavesReserve')).toBeGreaterThan(-1);
      expect(s.indexOf('assertTransferLeavesReserve')).toBeLessThan(s.indexOf('transfers.create('));
    }
  });
});

describe('publication check', () => {
  beforeEach(() => { mockRule = null; mockMode = 'report'; taxPolicy.clearCache(); });
  test('report mode never refuses; enforcement refuses a state with no usable rule; a rule allows it', async () => {
    await expect(taxPolicy.auctionPublicationCheck('tx')).resolves.toMatchObject({ allowed: true, code: 'TAX_CONFIGURATION_REQUIRED', state: 'TX' });
    mockMode = 'enforce'; taxPolicy.clearCache();
    await expect(taxPolicy.auctionPublicationCheck('TX')).resolves.toMatchObject({ allowed: false, code: 'TAX_CONFIGURATION_REQUIRED' });
    mockRule = RETIRED;
    await expect(taxPolicy.auctionPublicationCheck('TX')).resolves.toMatchObject({ allowed: false });
    mockRule = DIRECT;
    await expect(taxPolicy.auctionPublicationCheck('PA')).resolves.toMatchObject({ allowed: true, code: 'RULE_PRESENT' });
    await expect(taxPolicy.auctionPublicationCheck('')).resolves.toMatchObject({ allowed: true, code: 'STATE_UNKNOWN' });
  });
  test('an unreadable enforcement setting never starts blocking', async () => {
    mockMode = 'something-else'; taxPolicy.clearCache();
    await expect(taxPolicy.auctionEnforcement()).resolves.toBe('report');
  });
});
