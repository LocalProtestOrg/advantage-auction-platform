'use strict';

// Owner decision: online Storefronts are for Professional Sellers only. Individual Sellers (private /
// business / other / untyped) must not see Storefront actions (My Storefront / Add Item / Store Orders)
// they cannot use. /api/auth/me returns a server-computed storefront_eligible flag from the canonical
// isProfessional rule (src/services/sellerTypeRules.js); the member nav gates those items on it.

const fs = require('fs');
const path = require('path');
const Nav = require('../public/widgets/shared/member-nav-config');
const { isProfessional } = require('../src/services/sellerTypeRules');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const STOREFRONT_IDS = ['storefront', 'addItem', 'mpOrders'];
const ids = (ctx) => Nav.visibleNavFor(ctx).map((i) => i.id);

describe('member nav — Storefront items for Professional Sellers only', () => {
  const base = { role: 'seller', mode: 'buying', isSeller: true, sellerReady: true };

  test('Individual Seller (storefront_eligible false) sees auction tools but NO Storefront items', () => {
    const v = ids(Object.assign({ storefrontEligible: false }, base));
    expect(v).toContain('createAuction');
    expect(v).toContain('sell');
    STOREFRONT_IDS.forEach((id) => expect(v).not.toContain(id));
  });

  test('flag absent (older /me, unknown) fails closed — no Storefront items', () => {
    STOREFRONT_IDS.forEach((id) => expect(ids(base)).not.toContain(id));
  });

  test('Professional Seller (storefront_eligible true) sees My Storefront, Add Item, Store Orders', () => {
    const v = ids(Object.assign({ storefrontEligible: true }, base));
    STOREFRONT_IDS.forEach((id) => expect(v).toContain(id));
    expect(v.indexOf('storefront')).toBeLessThan(v.indexOf('createAuction'));
  });

  test('eligibility alone never shows seller tools before Marketplace setup is complete', () => {
    const v = ids({ role: 'seller', mode: 'buying', isSeller: true, sellerReady: false, storefrontEligible: true });
    STOREFRONT_IDS.concat(['createAuction']).forEach((id) => expect(v).not.toContain(id));
  });

  test('admin experience never gains Storefront management items', () => {
    const v = ids({ role: 'admin', mode: 'admin', storefrontEligible: true, sellerReady: true });
    STOREFRONT_IDS.forEach((id) => expect(v).not.toContain(id));
  });
});

describe('canonical rule used for storefront_eligible', () => {
  test('professional types are eligible; individual types and null are not', () => {
    ['auction_house', 'estate_sale_company', 'professional_liquidator'].forEach((t) => expect(isProfessional(t)).toBe(true));
    ['private', 'business', 'other', null, undefined].forEach((t) => expect(isProfessional(t)).toBe(false));
  });

  test('/me computes storefront_eligible server-side with isProfessional on the seller profile', () => {
    const auth = read('src', 'routes', 'auth.js');
    expect(auth).toMatch(/require\('\.\.\/services\/sellerTypeRules'\)/);
    expect(auth).toMatch(/SELECT id, seller_type FROM seller_profiles WHERE user_id = \$1/);
    expect(auth).toMatch(/storefrontEligible = isProfessional\(sp\.seller_type\)/);
    expect(auth).toMatch(/storefront_eligible: storefrontEligible/);
  });

  test('member shell and standalone chrome pass the server flag into the nav context', () => {
    const shell = read('public', 'widgets', 'shared', 'member-shell.js');
    const chrome = read('public', 'widgets', 'shared', 'member-chrome.js');
    expect(shell).toContain('me.body.data.storefront_eligible === true');
    expect(shell).toMatch(/storefrontEligible:\s*state\.storefrontEligible/);
    expect(chrome).toContain('d.storefront_eligible === true');
    expect(chrome).toMatch(/storefrontEligible:\s*ctx\.storefrontEligible/);
  });
});
