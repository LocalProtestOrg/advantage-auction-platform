'use strict';
/**
 * Seller and admin navigation (owner 2026-11-12), as served by the real app in a real browser on the isolated full-stack
 * environment (tests/fullstack, in-memory database and photo/document storage; never production):
 *   - Business Verification (/verify-documents.html) sits inside the seller dashboard frame, with clear Return to
 *     Dashboard and My Storefront links that work on a desktop and on a 360px phone (no sideways scrolling);
 *   - after a document is submitted the seller sees a confirmation and "Under Review"; a later visit shows the status;
 *     once approved, a clear verified state;
 *   - admin: the Seller Verification status panel opens the owner's Member Detail, Member Detail opens that seller in
 *     Seller Verification, and User Management finds the seller by business name, showing the business and the owner.
 */
const { chromium } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(300000);
let stack; let browser;
const SELLER = 'nav-verify@fullstack.test';
const ADMIN = 'nav-verify-admin@fullstack.test';
const S = {};
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n')]);
const one = async (sql, p) => (await stack.query(sql, p || [])).rows[0];
const width = (page) => page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: window.innerWidth }));

beforeAll(async () => {
  stack = await startStack({ fakeStorage: true });
  S.userId = await seed.user(stack, { email: SELLER, role: 'seller', fullName: 'Pat Owner' });
  S.profileId = await seed.sellerProfile(stack, { userId: S.userId, sellerType: 'retail_gallery_studio', displayName: 'Timeless Treasures',
    extra: { verification_required_before_publication: true } });
  await seed.signedStorefrontAgreement(stack, S.profileId);
  await seed.user(stack, { email: ADMIN, role: 'admin', fullName: 'Vera Verifier' });
  await stack.query(`UPDATE users SET staff_role = 'super_admin' WHERE email = $1`, [ADMIN]);
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

describe('seller: Business Verification page', () => {
  test('desktop: framed, Return to Dashboard and My Storefront work; submitting shows a confirmation and Under Review', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await seed.browserLogin(page, stack, SELLER, seed.TEST_PASSWORD, '/verify-documents.html');
    await page.waitForSelector('.adv-rail', { state: 'visible' });                 // the seller dashboard frame
    await page.waitForSelector('#vd-status:not([hidden])');
    expect(await page.textContent('#vd-status')).toMatch(/Verification status: Documents Needed/);
    expect(await page.isVisible('#vd-dashboard')).toBe(true);
    expect(await page.isVisible('#vd-storefront')).toBe(true);
    expect(await page.getAttribute('#vd-dashboard', 'href')).toBe('/app.html#home');
    expect(await page.getAttribute('#vd-storefront', 'href')).toBe('/seller-storefront.html?tab=store');
    expect(await page.$$eval('#adv-main #vd-nav', (n) => n.length)).toBe(1);        // the page's content is inside the frame
    const w = await width(page); expect(w.sw).toBeLessThanOrEqual(w.iw);

    // Submit through the page's real upload control.
    await page.fill('#bz-legal', 'Timeless Treasures LLC');
    await page.selectOption('#bz-cat', 'business_license');
    await page.setInputFiles('#bz-file', { name: 'license.pdf', mimeType: 'application/pdf', buffer: PDF });
    await page.click('#bz-up');
    await page.waitForSelector('#vd-thanks:not([hidden])');
    expect(await page.textContent('#vd-thanks')).toBe('Thank you. Your documents were submitted. Status: Under review. Advantage.Bid will review them, and you can check your status on this page at any time.');
    expect(await page.textContent('#vd-status-label')).toBe('Verification status: Under Review');
    expect((await one(`SELECT count(*)::int n FROM verification_documents WHERE seller_profile_id = $1`, [S.profileId])).n).toBe(1);
    // The way back is still there after submitting.
    expect(await page.isVisible('#vd-dashboard')).toBe(true);

    // A later visit shows the status (no confirmation repeated).
    await page.reload();
    await page.waitForSelector('#vd-status:not([hidden])');
    expect(await page.textContent('#vd-status-label')).toBe('Verification status: Under Review');
    expect(await page.isHidden('#vd-thanks')).toBe(true);

    await Promise.all([page.waitForURL(/\/seller-storefront\.html\?tab=store/), page.click('#vd-storefront')]);
    await page.waitForSelector('.adv-rail a[aria-current="page"]');
    await page.waitForLoadState('networkidle');
    await page.goto(stack.baseUrl + '/verify-documents.html');
    await page.waitForSelector('#vd-dashboard', { state: 'visible' });
    await Promise.all([page.waitForURL(/\/app\.html/), page.click('#vd-dashboard')]);
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test('360px phone: both links reachable inside the screen, no sideways scrolling, Return to Dashboard works', async () => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await seed.browserLogin(page, stack, SELLER, seed.TEST_PASSWORD, '/verify-documents.html');
    await page.waitForSelector('#vd-status:not([hidden])');
    await page.waitForSelector('#adv-main #vd-nav');
    const w = await width(page); expect(w.sw).toBeLessThanOrEqual(w.iw);
    for (const id of ['#vd-dashboard', '#vd-storefront']) {
      const b = await page.$eval(id, (a) => { const r = a.getBoundingClientRect(); return { x: r.x, r: r.right, h: r.height }; });
      expect([id, b.x >= 0, b.r <= 360, b.h >= 40]).toEqual([id, true, true, true]);
    }
    await Promise.all([page.waitForURL(/\/app\.html/), page.tap('#vd-dashboard')]);
    await page.waitForLoadState('networkidle');
    await ctx.close();
  });
});

describe('admin: Seller Verification, Member Detail and User Management link to each other', () => {
  let page; let ctx;
  beforeAll(async () => {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());
    await seed.browserLogin(page, stack, ADMIN, seed.TEST_PASSWORD, '/admin/verification.html?seller=' + S.profileId);
  });
  afterAll(async () => { if (ctx) await ctx.close(); });

  test('the verification status panel opens the owner\'s Member Detail, which opens the seller back in Seller Verification', async () => {
    await page.goto(stack.baseUrl + '/admin/verification.html?seller=' + S.profileId);
    await page.waitForSelector('#memberLink', { state: 'visible' });
    expect(await page.getAttribute('#memberLink', 'href')).toBe('/admin/member.html?id=' + S.userId);
    await Promise.all([page.waitForURL(/\/admin\/member\.html\?id=/), page.click('#memberLink')]);
    await page.waitForSelector('#m-open-verification');
    expect(await page.textContent('#m-open-verification')).toBe('Open in Seller Verification');
    expect(await page.getAttribute('#m-open-verification', 'href')).toBe('/admin/verification.html?seller=' + S.profileId);
    await Promise.all([page.waitForURL(/\/admin\/verification\.html\?seller=/), page.click('#m-open-verification')]);
    await page.waitForFunction(() => /Timeless Treasures/.test(document.getElementById('sellerTitle').textContent));
  });

  test('User Management finds the seller by business name; the row shows the business and the owner', async () => {
    await page.goto(stack.baseUrl + '/admin/users.html');
    await page.waitForSelector('#q');
    await page.fill('#q', 'timeless treas');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1 && /Timeless Treasures/.test(document.getElementById('rows').innerText));
    const row = await page.$eval('#rows tr', (tr) => [...tr.children].map((td) => td.innerText.trim()));
    expect(row.slice(0, 3)).toEqual(['Pat Owner', 'Timeless Treasures', SELLER]);
    await Promise.all([page.waitForURL(/\/admin\/member\.html\?id=/), page.click('#rows tr a')]);
    expect(page.url()).toContain(S.userId);
    await page.waitForSelector('#m-open-verification');   // let Member Detail finish loading before moving on
  });

  test('once approved, the seller sees a clear verified state', async () => {
    await page.goto(stack.baseUrl + '/admin/verification.html?seller=' + S.profileId);
    await page.waitForSelector('button[data-act="approved"]');
    await page.click('button[data-act="approved"]');
    await page.waitForFunction(() => /^Verified/.test(document.getElementById('statusBox').innerText));
    const sctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const sp = await sctx.newPage();
    await seed.browserLogin(sp, stack, SELLER, seed.TEST_PASSWORD, '/verify-documents.html');
    await sp.waitForSelector('#vd-status.s-approved');
    expect(await sp.textContent('#vd-status-label')).toBe('Verified: business verification approved');
    expect(await sp.$('#bz-up')).toBeNull();      // nothing more to submit
    expect(await sp.isVisible('#vd-dashboard')).toBe(true);
    await sctx.close();
  });
});
