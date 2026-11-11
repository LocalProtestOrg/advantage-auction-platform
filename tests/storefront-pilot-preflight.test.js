'use strict';
// The storefront pilot pre-flight (scripts/storefront-pilot-preflight.js) must stay read-only and private: it is run against
// production. These checks pin the guarantees in its source.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'storefront-pilot-preflight.js'), 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // comments removed

describe('storefront pilot pre-flight: read-only and private', () => {
  test('the session is made read-only and verified before anything else runs', () => {
    const ro = code.indexOf("SET default_transaction_read_only = on");
    const verify = code.indexOf('SHOW default_transaction_read_only');
    const firstService = code.indexOf("svc('");
    expect(ro).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(ro);
    expect(firstService).toBeGreaterThan(verify);
  });
  test('the application database module is replaced by the read-only connection before any service loads', () => {
    expect(code).toMatch(/require\.cache\[dbPath\] = \{[^}]*exports: runner/);
    expect(code.indexOf('require.cache[dbPath]')).toBeLessThan(code.indexOf("svc('"));
  });
  test('no writes, no messages, no payment calls in its own code', () => {
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\s/);   // SQL keywords (the script writes SQL in capitals)
    expect(code).not.toMatch(/\b(insert into|update \w+ set|delete from)\b/i);
    expect(code).not.toMatch(/sendEmail|sendSMS|\.(paymentIntents|refunds|transfers|charges|payouts|setupIntents)\.|require\(['"]stripe['"]\)|stripeService/);
    expect(code).not.toMatch(/process\.env\.[A-Z_]+\s*=/);   // never changes the environment (pilot lists stay as they are)
  });
  test('never prints credentials, bank or card identifiers, or buyer contact details', () => {
    expect(code).not.toMatch(/stripe_account_id\s*[},]|\$\{pref\.stripe_account_id\}|bank_last4|connect_bank|email\}|default_pickup_address_line1\}/);
    expect(code).not.toMatch(/console\.log\([^)]*(STRIPE_|SECRET|PASSWORD|DATABASE_URL)/);
  });
  test('uses the server checks checkout uses, not a copy of their rules', () => {
    for (const fn of ['publicationGate', 'storefrontAgreementStatus', 'payoutReady', 'assertSellerCanSell', 'snapshotFor', 'loadItemForPurchase', 'taxRuleFor', 'marketplaceCheckoutAllowed']) {
      expect(code).toContain(fn);
    }
    expect(code).not.toContain('saleStateFor');   // it can send a missing-location alert; the pure saleLocation.forItem is used
  });
  test('reports the four owner statuses', () => {
    for (const s of ["'PASS'", "'BLOCKED'", "'NEEDS OWNER ACTION'", "'UNVERIFIED'"]) expect(SRC).toContain(s);
  });
});
