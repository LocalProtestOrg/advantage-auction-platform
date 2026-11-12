'use strict';

/**
 * Store policy publishing status on My Storefront (Store tab), owner 2026-11-12. Real app and database on the isolated
 * full-stack environment (never production):
 *   - before publication: RED "Not Published." with what buyers cannot do, for each policy, with a link that moves focus to
 *     that policy's editor;
 *   - after publishing through the real page: GREEN "Published." with version and date, read back from the server (a
 *     publish the server refuses leaves it red); a reload keeps it; a saved draft that differs shows "Unpublished changes";
 *   - not color alone (icon + bold word), role="status", and no horizontal scroll at 360px.
 */

const { chromium } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(240000);

let stack; let browser; const T = { email: 'policy-status@fullstack.test' };
const one = async (sql, p) => (await stack.query(sql, p || [])).rows[0];
const status = (page, k) => page.$eval('#pol-st-' + k, (e) => ({ state: e.getAttribute('data-state'), text: e.textContent.replace(/\s+/g, ' ').trim(),
  role: e.getAttribute('role'), live: e.getAttribute('aria-live'), color: getComputedStyle(e).color, bold: (e.querySelector('b') || {}).textContent || '',
  icon: (e.querySelector('.pol-ic') || {}).textContent || '', link: (e.querySelector('a') || {}).getAttribute ? e.querySelector('a').getAttribute('href') : null }));
const waitState = (page, k, state) => page.waitForSelector(`#pol-st-${k}[data-state="${state}"]`, { timeout: 20000 });
const TERMS = 'All sales are final. Items are sold as described; please ask questions before buying.';
const SHIP = 'Pickup by appointment at our gallery within 7 days. We ship small items by USPS within 3 business days.';

beforeAll(async () => {
  stack = await startStack();
  T.userId = await seed.user(stack, { email: T.email, role: 'seller', fullName: 'Gail Gallery' });
  T.profileId = await seed.sellerProfile(stack, { userId: T.userId, sellerType: 'retail_gallery_studio', displayName: 'Policy Status Gallery' });
  await seed.signedStorefrontAgreement(stack, T.profileId);
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

describe('store policy publishing status (from the server\'s saved state)', () => {
  let ctx; let page; const errors = [];
  beforeAll(async () => {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());   // "Publish this policy?" confirmation
    await seed.browserLogin(page, stack, T.email, seed.TEST_PASSWORD, '/seller-storefront.html?tab=store');
  });
  afterAll(async () => { if (ctx) await ctx.close(); });

  test('not published: red "Not Published." for each policy, as a status message, with a link to its editor', async () => {
    await waitState(page, 'store_terms', 'not_published');
    const t = await status(page, 'store_terms');
    expect(t.text).toContain('Not Published. Buyers cannot purchase until you publish your terms.');
    expect([t.bold, t.icon, t.role, t.live, t.link]).toEqual(['Not Published.', '✖', 'status', 'polite', '#pt-store_terms']);
    expect(t.color).toBe('rgb(153, 27, 27)');   // red text (#991b1b) on a light red background
    const s = await status(page, 'shipping_pickup');
    expect(s.text).toContain('Not Published. Buyers cannot purchase until you publish your Shipping & Pickup Policy.');
    expect([s.state, s.bold, s.link]).toEqual(['not_published', 'Not Published.', '#pt-shipping_pickup']);
    // the link moves focus to that policy's editor
    await page.click('#pol-st-shipping_pickup a');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'pt-shipping_pickup');
  });

  test('a publish the server refuses (too short) stays "Not Published."', async () => {
    await page.fill('#pt-store_terms', 'Too short');
    await page.click('#pp-store_terms');
    await page.waitForFunction(() => /Write your policy before publishing it/.test(document.getElementById('msg').textContent));
    await page.waitForTimeout(300);
    expect((await status(page, 'store_terms')).state).toBe('not_published');
    expect(await one(`SELECT count(*)::int n FROM seller_policy_versions WHERE seller_id = $1 AND status = 'published'`, [T.profileId])).toEqual({ n: 0 });
  });

  test('publishing through the page turns it green from the server\'s saved state, with version and date', async () => {
    await page.fill('#pt-store_terms', TERMS);
    await page.click('#pp-store_terms');
    await waitState(page, 'store_terms', 'published');
    const row = await one(`SELECT version, published_at FROM seller_policy_versions WHERE seller_id = $1 AND kind = 'store_terms' AND status = 'published'`, [T.profileId]);
    expect(row.version).toBe(1);
    const t = await status(page, 'store_terms');
    const date = new Date(row.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    expect(t.text).toContain('Published. Your terms are available to buyers.');
    expect(t.text).toContain('Version 1, published ' + date + '.');
    expect([t.bold, t.icon, t.role, t.link]).toEqual(['Published.', '✔', 'status', null]);
    expect(t.color).toBe('rgb(20, 83, 45)');   // green text (#14532d)
    // the other policy is still not published
    expect((await status(page, 'shipping_pickup')).state).toBe('not_published');

    await page.fill('#pt-shipping_pickup', SHIP);
    await page.click('#pp-shipping_pickup');
    await waitState(page, 'shipping_pickup', 'published');
    expect((await status(page, 'shipping_pickup')).text).toContain('Published. Your Shipping & Pickup Policy is available to buyers.');
  });

  test('a reload keeps the published status', async () => {
    await page.reload();
    await waitState(page, 'store_terms', 'published');
    await waitState(page, 'shipping_pickup', 'published');
  });

  test('a saved draft that differs from the published version shows "Unpublished changes" with a link to review it', async () => {
    await page.fill('#pt-store_terms', TERMS + ' Gift cards are not refundable.');
    await page.click('#pol-store_terms button:has-text("Save draft")');
    await waitState(page, 'store_terms', 'changed');
    const t = await status(page, 'store_terms');
    expect(t.text).toContain('Published. Your terms are available to buyers.');
    expect(t.text).toContain('Unpublished changes. Buyers still see version 1 until you publish your changes.');
    expect(t.link).toBe('#pt-store_terms');
    expect(errors).toEqual([]);
  });
});

test('phone width (360px): statuses readable, no horizontal scroll', async () => {
  // a second seller with nothing published, so the longer red messages are shown
  const email = 'policy-status-phone@fullstack.test';
  const userId = await seed.user(stack, { email, role: 'seller', fullName: 'Phil Phone' });
  const profileId = await seed.sellerProfile(stack, { userId, sellerType: 'retail_gallery_studio', displayName: 'Phone Width Gallery' });
  await seed.signedStorefrontAgreement(stack, profileId);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  try {
    await seed.browserLogin(page, stack, email, seed.TEST_PASSWORD, '/seller-storefront.html?tab=store');
    await waitState(page, 'store_terms', 'not_published');
    await waitState(page, 'shipping_pickup', 'not_published');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await page.$eval('#pol-st-shipping_pickup', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(360);
  } finally { await ctx.close(); }
});
