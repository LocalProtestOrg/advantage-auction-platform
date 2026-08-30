'use strict';

/**
 * Professional Storefront retail-seller UX (antique-store readiness). Verifies the seller can list
 * fixed-price items with real PHOTOS (upload, not URL-paste), in plain retail language, add many items
 * quickly, and that the public storefront reads as a shop (empty sections hidden, shop-first hero).
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const editor = read('public/seller-storefront.html');
const storefront = read('public/storefront.html');
const nav = read('public/widgets/shared/member-nav-config.js');

describe('seller storefront editor — add an item (antique dealer)', () => {
  test('retail language, not auction jargon', () => {
    expect(editor).toContain('>Items for Sale<');          // tab (was "Marketplace Items")
    expect(editor).toContain('Add an Item');               // section (was "Add a Marketplace item")
    expect(editor).toMatch(/>Add Item<\/button>|onclick="addItem\(this\)">Add Item/); // button (was "List Item")
    expect(editor).not.toContain('List Item');
    expect(editor).not.toContain('Add a Marketplace item');
  });
  test('real PHOTO upload (file → /api/uploads/image), not URL-paste only', () => {
    expect(editor).toContain('type="file"');
    expect(editor).toContain('function uploadPhotos');
    expect(editor).toContain("/api/uploads/image");
    expect(editor).not.toContain('Image URLs (comma separated, optional)'); // old URL-only field removed
  });
  test('collects category + flat shipping price (fields the service already supports)', () => {
    expect(editor).toContain('id="m-cat"');
    expect(editor).toContain('id="m-shipcost"');
  });
  test('add-another keeps location/shipping defaults, clears only item-specific fields', () => {
    // clears title/price/category/condition/description; does NOT clear city/state/shipping.
    const clearList = editor.match(/\[('m-[a-z]+',?)+\]\.forEach\(function\(i\)\{document\.getElementById\(i\)\.value=''/);
    expect(clearList).toBeTruthy();
    expect(clearList[0]).toContain("'m-title'");
    expect(clearList[0]).not.toContain("'m-city'");   // location kept for the next item
    expect(clearList[0]).not.toContain("'m-state'");
    expect(editor).toContain('added this session');
  });
  test('deep-link to the add-item tab (from the "Add Item" nav)', () => {
    expect(editor).toContain("URLSearchParams(location.search).get('tab')");
    expect(editor).toContain('View My Storefront');
  });
});

describe('seller navigation — retail entry points', () => {
  test('"Add Item" nav item deep-links to the item tab; "Store Orders" not "Marketplace Orders"', () => {
    expect(nav).toMatch(/id: 'addItem'[^}]*\/seller-storefront\.html\?tab=market/);
    expect(nav).toContain("label: 'Store Orders'");
  });
});

describe('public storefront — reads like a shop', () => {
  test('empty Shop section is hidden (no "check back soon" placeholder)', () => {
    expect(storefront).toMatch(/vis\.marketplace!==false && d\.marketplace\.length/);
    expect(storefront).not.toContain('No items listed right now');
  });
  test('Shop is the PRIMARY hero action for a retail-first seller (items, no auctions)', () => {
    expect(storefront).toContain('var shopPrimary=(!d.auctions.length && d.marketplace.length)');
    expect(storefront).toContain('Shop Now');
  });
  test('contact copy is generic, not estate-only', () => {
    expect(storefront).toContain('Get in touch');
    expect(storefront).not.toContain('Need help with an estate?');
  });
});

describe('storefront shows the full shop (many items)', () => {
  test('public item limit raised to 100 (a dealer may stock 75+)', () => {
    expect(read('src/services/storefrontService.js')).toMatch(/listPublicForSeller\(sp\.id, 100\)/);
  });
});
