'use strict';
/**
 * Payout Profile launch blocker (owner 2026-11-12), as served by the real app in a real browser on the isolated
 * full-stack environment (tests/fullstack; never production; no Stripe call is made).
 * Production showed "Could not load your payout profile." with no way forward: the page was opened while signed in to an
 * administrator account, the API correctly refused it (403, payouts belong to the seller account), and the page turned
 * every refusal into that bare message. Covers:
 *  - a Professional Seller with NO payout record sees "Not Connected" and a "Set Up Payouts (Connect Bank Account)" action,
 *    wording that covers auction settlements and Storefront sales, and no bank-number fields;
 *  - the API returns connect_state and never a Stripe account id;
 *  - an administrator account is told which account it is and how to switch, with a Sign Out action (a buyer account is
 *    already sent to its dashboard by the page gate);
 *  - seller isolation: the API answers only for the signed-in seller.
 */
const { chromium } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(180000);
let stack; let browser;
const SELLER = 'payout-shop@fullstack.test';
const OTHER = 'payout-other@fullstack.test';
const ADMIN = 'payout-admin@fullstack.test';
const BUYER = 'payout-buyer@fullstack.test';

beforeAll(async () => {
  stack = await startStack({ env: { STRIPE_CONNECT_ENABLED: 'true' } });
  const uid = await seed.user(stack, { email: SELLER, role: 'seller', fullName: 'Pat Shop' });
  await seed.sellerProfile(stack, { userId: uid, sellerType: 'retail_gallery_studio', displayName: 'Timeless Test Shop' });
  const other = await seed.user(stack, { email: OTHER, role: 'seller', fullName: 'Other Seller' });
  await seed.sellerProfile(stack, { userId: other, sellerType: 'retail_gallery_studio', displayName: 'Other Shop' });
  await stack.query(`INSERT INTO seller_payout_preferences (seller_user_id, payout_method, stripe_account_id, connect_status, connect_details_submitted)
    VALUES ($1, 'ach', 'acct_isolated_other', 'restricted', true)`, [other]);
  await seed.user(stack, { email: ADMIN, role: 'admin', fullName: 'Ada Admin' });
  await seed.user(stack, { email: BUYER, role: 'buyer', fullName: 'Bea Buyer' });
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

async function open(email) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await seed.browserLogin(page, stack, email, seed.TEST_PASSWORD, '/payout-profile.html');
  await page.goto(stack.baseUrl + '/payout-profile.html');
  return { ctx, page, errors };
}

test('a seller with no payout record sees Not Connected and a Set Up Payouts action (no bank fields)', async () => {
  const { ctx, page, errors } = await open(SELLER);
  await page.waitForSelector('#app:not(.hide)');
  expect(await page.$eval('#status-badge', (e) => e.textContent)).toBe('Not Connected');
  expect(await page.$eval('#status-explain', (e) => e.textContent)).toMatch(/No bank account is connected yet/);
  expect(await page.isVisible('#ach-connect-btn')).toBe(true);
  expect(await page.$eval('#ach-connect-btn', (e) => e.textContent)).toBe('Set Up Payouts (Connect Bank Account)');
  const lede = await page.$eval('.lede', (e) => e.textContent);
  expect(lede).toMatch(/auction settlements/); expect(lede).toMatch(/Storefront sales/);
  expect(await page.$$('input[name*="routing" i], input[id*="routing" i], input[name*="account_number" i]')).toHaveLength(0);
  expect(await page.isVisible('#load-problem')).toBe(false);
  expect(await page.textContent('body')).not.toMatch(/Could not load your payout profile/);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('the API returns connect_state and never a Stripe account id; each seller sees only its own record', async () => {
  const mine = await seed.apiLogin(stack, SELLER);
  const r = await fetch(stack.baseUrl + '/api/payout-profile/me', { headers: { Authorization: 'Bearer ' + mine } });
  const j = await r.json();
  expect(r.status).toBe(200);
  expect(j.data.connect_state).toBe('not_connected');
  expect(JSON.stringify(j)).not.toMatch(/acct_/);
  const theirs = await seed.apiLogin(stack, OTHER);
  const r2 = await (await fetch(stack.baseUrl + '/api/payout-profile/me', { headers: { Authorization: 'Bearer ' + theirs } })).json();
  expect(r2.data.connect_state).toBe('verification_required');
  expect(JSON.stringify(r2)).not.toMatch(/acct_isolated_other/);
});

test('an administrator account is told it is the wrong account and how to switch (the production failure)', async () => {
  const { ctx, page, errors } = await open(ADMIN);
  await page.waitForSelector('#load-problem:not(.hide)');
  await page.waitForFunction(() => /administrator account/.test(document.getElementById('lp-text').textContent));
  const text = await page.$eval('#lp-text', (e) => e.textContent);
  expect(text).toMatch(/signed in as payout-admin@fullstack\.test/);
  expect(text).toMatch(/sign in with the seller account/);
  expect(await page.isVisible('#lp-action')).toBe(true);
  expect(await page.$eval('#lp-action', (a) => a.getAttribute('href'))).toBe('/logout');
  expect(await page.isVisible('#app')).toBe(false);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a buyer account never reaches a dead end: the page gate sends it to its dashboard', async () => {
  const { ctx, page } = await open(BUYER);
  expect(new URL(page.url()).pathname).toBe('/app.html');
  await ctx.close();
});
