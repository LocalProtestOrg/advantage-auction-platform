'use strict';
/**
 * Storefront buyers reach their shop purchases (owner 2026-11-12). Buyer Terms v4 Part B §10 tells buyers to report a
 * problem from My Purchases; the Report a problem button lives on /marketplace-purchases.html. The receipt email used to
 * link /app.html#purchases (auction invoices only), and the member Purchases panel had no way to reach shop orders.
 * The receipt also promised a shipment email that does not exist; it now points to the purchases page instead.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('the buyer receipt links the shop purchases page, not the auction purchases panel', () => {
  const src = read('src', 'services', 'marketplaceOrderNotifier.js');
  expect(src).toMatch(/\/marketplace-purchases\.html"[^>]*>View your purchases</);
  expect(src).not.toMatch(/app\.html#purchases/);
  expect(src).not.toMatch(/You will receive shipment details/);   // no shipped email exists
});

test('the member Purchases panel links shop purchases, including when there are no auction purchases', () => {
  const src = read('public', 'widgets', 'shared', 'member-shell.js');
  const fn = src.slice(src.indexOf('async function loadPurchases'), src.indexOf('async function enrichPickups'));
  expect(fn).toMatch(/href="\/marketplace-purchases\.html"/);
  expect(fn).toMatch(/host\.innerHTML = shopLink \+ emptyCard/);
  expect(fn).toMatch(/host\.innerHTML = shopLink \+ head/);
});

test('the shop purchases page has the Report a problem action the terms point to', () => {
  expect(read('public', 'marketplace-purchases.html')).toMatch(/Report a problem/);
});
