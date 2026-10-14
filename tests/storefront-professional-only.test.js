'use strict';

/**
 * Storefronts are a Professional Seller feature (owner decision 2026-10-12). Eligibility must use the canonical
 * seller-type rule (auction_house, estate_sale_company, professional_liquidator), never the buyer-branding list, which
 * also contains the self-serve 'business' Individual Seller type. Item edits and relisting are gated too, not just
 * ownership-checked.
 */

const fs = require('fs');
const path = require('path');
const sellerTypeRules = require('../src/services/sellerTypeRules');
const branding = require('../src/lib/sellerBranding');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');

describe('storefront eligibility: Professional Sellers only', () => {
  test('the canonical rule treats business, private, other and untyped sellers as Individual Sellers', () => {
    for (const t of ['auction_house', 'estate_sale_company', 'professional_liquidator']) expect(sellerTypeRules.isProfessional(t)).toBe(true);
    for (const t of ['business', 'private', 'other', null, undefined, '']) expect(sellerTypeRules.isProfessional(t)).toBe(false);
    expect(branding.isProfessional('business')).toBe(true);   // why the branding list must never gate storefronts
  });
  test.each(['storefrontService.js', 'marketplaceItemService.js', 'marketplaceOrderService.js'])('%s gates storefront actions with the canonical seller-type rule', (f) => {
    const s = src(f);
    expect(s).toMatch(/const \{ isProfessional \} = require\('\.\/sellerTypeRules'\);/);
    expect(s).not.toMatch(/\{[^}]*\bisProfessional\b[^}]*\} = require\('\.\.\/lib\/sellerBranding'\)/);
  });
  test('editing a listing and relisting an item require a Professional Seller, not only ownership', () => {
    const items = src('marketplaceItemService.js');
    const update = items.slice(items.indexOf('async function updateItem'), items.indexOf('async function updateItem') + 900);
    expect(update).toMatch(/if \(!isProfessional\(seller\.seller_type\)\) throw err\(403, 'NOT_PROFESSIONAL'/);
    const orders = src('marketplaceOrderService.js');
    const relist = orders.slice(orders.indexOf('async function relistItem'), orders.indexOf('async function relistItem') + 900);
    expect(relist).toMatch(/SELECT id, seller_type FROM seller_profiles/);
    expect(relist).toMatch(/if \(!isProfessional\(seller\.seller_type\)\) throw err\(403, 'NOT_PROFESSIONAL'/);
  });
});
