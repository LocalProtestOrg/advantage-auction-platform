'use strict';

/**
 * Owner decision 3 (2026-09-27): card verification and card types.
 *   - Saving a card is the verification; Advantage.Bid never charges to verify (no random under-$1 charge).
 *   - Debit and credit only: a card the network reports as 'prepaid' is refused and detached (never kept or
 *     charged). 'unknown' or missing funding is ALLOWED, so a legitimate card is never refused on uncertainty.
 *   - Public copy explains this without naming the payment provider (except where the customer must use it).
 */

process.env.STRIPE_SECRET_KEY = 'sk_test_unit_only';
const fs = require('fs');
const path = require('path');

const mockStripe = {
  customers: { retrieve: jest.fn(async () => ({ id: 'cus_1' })), create: jest.fn(async () => ({ id: 'cus_1' })), update: jest.fn(async () => ({})) },
  paymentMethods: { list: jest.fn(), detach: jest.fn(async () => ({})) },
};
jest.mock('stripe', () => () => mockStripe);
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));
const db = require('../src/db');
const { writeAuditLog } = require('../src/lib/auditLog');
const cardService = require('../src/services/cardService');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => {
    if (/SELECT email, stripe_customer_id, stripe_customer_livemode FROM users/.test(sql)) return { rows: [{ email: 'buyer@example.com', stripe_customer_id: 'cus_1', stripe_customer_livemode: false }] };
    if (/INSERT INTO card_verifications/.test(sql)) return { rows: [{ id: 'cv_1' }] };
    return { rows: [] };
  });
});
const withCard = (funding) => mockStripe.paymentMethods.list.mockResolvedValueOnce({ data: [{ id: 'pm_x', card: { brand: 'visa', last4: '4242', funding } }] });

describe('debit and credit only', () => {
  test.each(['credit', 'debit'])('a %s card is saved as the default, with $0 recorded and no charge', async (funding) => {
    withCard(funding);
    const out = await cardService.recordCardOnFile('u1');
    expect(out).toMatchObject({ saved: true, last4: '4242' });
    expect(mockStripe.customers.update).toHaveBeenCalledWith('cus_1', { invoice_settings: { default_payment_method: 'pm_x' } });
    const ins = db.query.mock.calls.find(([sql]) => /INSERT INTO card_verifications/.test(sql));
    expect(ins[0]).toMatch(/'verified', now\(\), 0, 'usd', \$3/);
    expect(ins[1][2]).toBe(false); // stamped TEST mode (sk_test_ key)
    expect(mockStripe.paymentMethods.detach).not.toHaveBeenCalled();
  });
  test('a prepaid card is refused, detached, audited, and never becomes the default or verified', async () => {
    withCard('prepaid');
    await expect(cardService.recordCardOnFile('u1')).rejects.toMatchObject({ code: 'PREPAID_NOT_ACCEPTED', message: cardService.PREPAID_MESSAGE });
    expect(mockStripe.paymentMethods.detach).toHaveBeenCalledWith('pm_x');
    expect(mockStripe.customers.update).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO card_verifications/.test(sql))).toBe(false);
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({ event_type: 'card.prepaid_rejected' });
  });
  test.each(['unknown', undefined, null, ''])('an uncertain classification (%p) is ALLOWED', async (funding) => {
    withCard(funding);
    await expect(cardService.recordCardOnFile('u1')).resolves.toMatchObject({ saved: true });
    expect(mockStripe.paymentMethods.detach).not.toHaveBeenCalled();
  });
  test('classification is case-insensitive and exact', () => {
    expect(cardService.isPrepaid({ card: { funding: 'PREPAID' } })).toBe(true);
    expect(cardService.isPrepaid({ card: { funding: 'prepaid_reloadable' } })).toBe(false);
    expect(cardService.isPrepaid({})).toBe(false);
  });
  test('the save route answers a prepaid card with a clear 422, not a server error', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'payments.js'), 'utf8');
    expect(src).toMatch(/err\.code === 'PREPAID_NOT_ACCEPTED'\) return res\.status\(422\)/);
  });
});

describe('public card wording', () => {
  const PUB = path.join(__dirname, '..', 'public');
  const copy = (f) => fs.readFileSync(path.join(PUB, f), 'utf8').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const PAGES = ['buyer-faq.html', 'how-to-buy.html', 'login.html', 'add-card.html', 'faq.html', 'billing.html', 'payment.html', 'lot.html'];
  test.each(PAGES)('%s makes no random under-$1 claim and names no payment provider', (f) => {
    const html = copy(f);
    expect(html).not.toMatch(/under \$1|random amount|less than \$1/i);
    expect(html).not.toMatch(/does not authorize any charge/i);
    expect(html).not.toMatch(/\bStripe\b/);
  });
  test('the buyer FAQ explains there is no verification charge and that prepaid cards are not accepted', () => {
    const html = copy('buyer-faq.html');
    expect(html).toMatch(/Advantage\.Bid does not charge you/);
    expect(html).toMatch(/temporary authorization[^.]*released/);
    expect(html).toMatch(/prepaid cards are not/i);
  });
  test('the add-card test-mode hint only appears on test keys', () => {
    const raw = fs.readFileSync(path.join(PUB, 'add-card.html'), 'utf8');
    expect(raw).toMatch(/id="test-mode-note" hidden/);
    expect(raw).toMatch(/getElementById\('test-mode-note'\)\.hidden = !\/\^pk_test_\/\.test\(/);
  });
});
