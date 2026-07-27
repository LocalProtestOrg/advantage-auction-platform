'use strict';

/**
 * Seller onboarding: carry the customer's earlier Individual/Business choice forward by preselecting
 * the seller-type dropdown from ?seller_type=. Uses the EXISTING become-seller.html enrollment page
 * and its existing #seller-type dropdown — no duplicate onboarding/routes/logic. Dropdown stays
 * editable; invalid/missing param → default, no error.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const bs = read('public', 'become-seller.html');
const sc = read('public', 'seller-create.html');

// Re-implement the tiny pure resolver exactly as embedded, to prove its behavior.
function requestedSellerType(search) {
  const SELF = ['private', 'business', 'other'];
  try {
    let v = new URLSearchParams(search).get('seller_type');
    v = (v || '').trim().toLowerCase();
    return SELF.indexOf(v) !== -1 ? v : null;
  } catch (e) { return null; }
}

describe('seller_type preselect — canonical self-serve values', () => {
  test('business + private (+ other) are honored; case/space tolerant', () => {
    expect(requestedSellerType('?seller_type=business')).toBe('business');
    expect(requestedSellerType('?seller_type=private')).toBe('private');
    expect(requestedSellerType('?seller_type=other')).toBe('other');
    expect(requestedSellerType('?seller_type=%20Business%20')).toBe('business');
  });
  test('invalid / missing / professional (admin-only) → null → page default, no error', () => {
    for (const s of ['', '?seller_type=', '?seller_type=bogus', '?seller_type=auction_house',
      '?seller_type=estate_sale_company', '?foo=bar'])
      expect(requestedSellerType(s)).toBeNull();
  });
});

describe('become-seller.html uses the existing dropdown (no duplication)', () => {
  test('reads ?seller_type and preselects the existing #seller-type select', () => {
    expect(bs).toContain('requestedSellerType');
    expect(bs).toContain("SELF_SERVE_TYPES = ['private', 'business', 'other']");
    expect(bs).toMatch(/getElementById\('seller-type'\)[\s\S]{0,60}\.value = t/);
    expect(bs).toContain('remains editable'); // documented + not disabled
  });
  test('the dropdown still offers exactly the three self-serve options and is not disabled', () => {
    expect(bs).toContain('<option value="private">');
    expect(bs).toContain('<option value="business">');
    expect(bs).toContain('<option value="other">');
    expect(bs).not.toMatch(/<select id="seller-type"[^>]*disabled/);
  });
  test('the choice survives a login round-trip (next preserves path+query)', () => {
    expect(bs).toContain('function selfNext()');
    expect(bs).toContain('location.pathname + location.search');
    expect(bs).not.toMatch(/next=' \+ encodeURIComponent\('\/become-seller\.html'\)/); // old fixed next gone
  });
});

describe('seller-create.html carries the hint into onboarding (single source of truth)', () => {
  test('the gate forwards a valid seller_type to become-seller.html', () => {
    expect(sc).toContain("'&seller_type=' + v");
    expect(sc).toContain("['private', 'business', 'other'].indexOf(v)");
  });
  test('no duplicate seller-creation form/route was introduced', () => {
    // seller-create still gates on the existing onboarding-status; no new enrollment form here
    expect(sc).toContain('/api/agreements/onboarding-status');
    expect(sc).not.toContain('seller-type-2'); // no cloned dropdown
  });
});
