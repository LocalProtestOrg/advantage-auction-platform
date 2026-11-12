'use strict';

/**
 * Mobile launch fixes (owner 2026-11-12), in a real browser at phone width on the ISOLATED full-stack environment
 * (tests/fullstack: in-memory database; never production):
 *   1. Sasha's Help button never covers a control (buyer, seller and administrator pages): it sits above fixed bottom
 *      bars, is compact on phones, and the page reserves room so its last controls can scroll clear of it.
 *   2. Sasha's open chat fits the phone: no sideways page drag, the panel inside the viewport, a 16px message box (no
 *      iOS focus zoom), the close control reachable.
 *   3. Log Out is visible in the phone navigation for a buyer, a seller and an administrator, and really signs out.
 *
 * Sasha is switched on for these pages by answering its public on/off endpoint; the chat itself is answered locally
 * (no outside service). Requests to other sites are blocked.
 */

const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const health = require('../../src/services/watchdog/pageHealth');

jest.setTimeout(300000);

let stack; let browser;
const P = {
  buyer: 'phone-buyer@fullstack.test',
  seller: 'phone-seller@fullstack.test',
  admin: 'phone-admin@fullstack.test',
};

const PHONES = {
  'iPhone 13': { ...devices['iPhone 13'] },
  '360px': { ...devices['iPhone 13'], viewport: { width: 360, height: 740 }, screen: { width: 360, height: 740 } },
};

async function open(context) {
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== stack.baseUrl) return route.abort();
    if (u.pathname === '/api/public/sasha/config') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ enabled: true }) });
    if (u.pathname.indexOf('/api/sasha/chat/') === 0) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { token: 'phone-test',
        messages: [{ id: 'g1', author: 'sasha', text: "Hi! I'm Sasha. How can I help you today?" }] } }) });
    }
    return route.continue();
  });
  return page;
}

// Interactive elements whose box overlaps the Sasha button (optionally only those inside a fixed or sticky container).
function overlaps(page, fixedOnly) {
  return page.evaluate((onlyFixed) => {
    const btn = document.querySelector('.sasha-btn');
    const b = btn.getBoundingClientRect();
    const sel = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[tabindex]:not([tabindex="-1"])';
    function pinned(el) {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') return true;
      }
      return false;
    }
    return [...document.querySelectorAll(sel)].filter((el) => {
      if (el === btn || btn.contains(el) || el.closest('.sasha-frame')) return false;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || el.closest('[hidden]')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
      if (onlyFixed && !pinned(el)) return false;
      return r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
    }).map((el) => (el.id ? '#' + el.id : el.tagName.toLowerCase()) + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30) + '"');
  }, !!fixedOnly);
}
const pageWidth = (page) => page.evaluate(() => ({ scrollWidth: document.scrollingElement.scrollWidth, innerWidth: window.innerWidth }));

async function signedIn(phone, email, path, ready) {
  const ctx = await browser.newContext(PHONES[phone]);
  const page = await open(ctx);
  await seed.browserLogin(page, stack, email, seed.TEST_PASSWORD, path);
  if (ready) await page.waitForSelector(ready, { state: 'visible', timeout: 20000 });
  return { ctx, page };
}

beforeAll(async () => {
  stack = await startStack();
  await seed.user(stack, { email: P.buyer, role: 'buyer', fullName: 'Phoebe Phone' });
  await seed.user(stack, { email: P.admin, role: 'admin', fullName: 'Ada Admin' });
  const sellerId = await seed.user(stack, { email: P.seller, role: 'seller', fullName: 'Sam Seller' });
  const profileId = await seed.sellerProfile(stack, { userId: sellerId, sellerType: 'retail_gallery_studio', displayName: 'Phone Gallery',
    extra: { verification_required_before_publication: true } });
  await seed.signedStorefrontAgreement(stack, profileId);
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

// Representative pages: the buyer's dashboard, a framed seller page (its Menu button is the bottom-right control) and the
// administrator's dashboard (Admin mode of the member shell; /admin/* tools carry no Help button).
const PAGES = [
  ['buyer', P.buyer, '/app.html', '.adv-bottomnav'],
  ['seller', P.seller, '/seller-inventory.html', '#adv-more-btn'],
  ['admin', P.admin, '/app.html', '.adv-bottomnav'],
];

describe('1. the Sasha Help button never covers a control on a phone', () => {
  for (const phone of Object.keys(PHONES)) {
    for (const [who, email, path, ready] of PAGES) {
      test(`${who} page ${path} at ${phone}`, async () => {
        const { ctx, page } = await signedIn(phone, email, path, ready);
        await page.waitForSelector('.sasha-btn', { state: 'visible' });
        await page.waitForTimeout(800);   // late-rendered bars (the dashboard draws after sign-in checks)
        // fixed bars (bottom navigation, Menu) at the top of the page
        expect([who, await overlaps(page, true)]).toEqual([who, []]);
        // the bottom-right of the page: everything, once scrolled to the end
        await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
        await page.waitForTimeout(300);
        expect([who, await overlaps(page, false)]).toEqual([who, []]);
        // still visible, inside the viewport and big enough to tap, and the page does not scroll sideways
        const box = await page.$eval('.sasha-btn', (b) => { const r = b.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, vw: innerWidth, vh: innerHeight }; });
        expect(box.l).toBeGreaterThanOrEqual(0); expect(box.r).toBeLessThanOrEqual(box.vw);
        expect(box.t).toBeGreaterThanOrEqual(0); expect(box.b).toBeLessThanOrEqual(box.vh);
        expect(box.w).toBeGreaterThanOrEqual(40);
        const w = await pageWidth(page);
        expect(w.scrollWidth).toBeLessThanOrEqual(w.innerWidth);
        // the controls underneath really work: the seller's Menu opens by touch
        if (who === 'seller') { await page.tap('#adv-more-btn'); await page.waitForSelector('#adv-more', { state: 'visible' }); }
        await ctx.close();
      });
    }
  }
});

describe('2. the open Sasha chat fits a 360px phone', () => {
  for (const [who, email, path, ready] of PAGES.slice(0, 2)) {
    test(`${who} page ${path}`, async () => {
      const { ctx, page } = await signedIn('360px', email, path, ready);
      await page.tap('.sasha-btn');
      await page.waitForSelector('.sasha-frame.open', { state: 'visible' });
      const frameEl = await page.$('.sasha-frame');
      const chat = await frameEl.contentFrame();
      await chat.waitForSelector('#t');
      await chat.waitForFunction(() => /Sasha/.test(document.getElementById('log').textContent));
      const f = await page.$eval('.sasha-frame', (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, vw: innerWidth, vh: innerHeight }; });
      expect(f.l).toBeGreaterThanOrEqual(0); expect(f.r).toBeLessThanOrEqual(f.vw);
      expect(f.t).toBeGreaterThanOrEqual(0); expect(f.b).toBeLessThanOrEqual(f.vh);
      // the page behind cannot be dragged sideways (nor scrolled) while the chat is open
      const w = await pageWidth(page);
      expect(w.scrollWidth).toBeLessThanOrEqual(w.innerWidth);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowX)).toBe('hidden');
      // inside the chat: nothing wider than the panel; the message box is 16px (phones zoom into anything smaller, which
      // is what made the page drag sideways); the close control and "Talk to a person" are inside the panel
      const inner = await chat.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        return { sw: document.scrollingElement.scrollWidth, iw: innerWidth, ih: innerHeight, font: parseFloat(getComputedStyle(document.getElementById('t')).fontSize),
          close: r('close'), human: r('human'), send: r('send') };
      });
      expect(inner.sw).toBeLessThanOrEqual(inner.iw);
      expect(inner.font).toBeGreaterThanOrEqual(16);
      for (const k of ['close', 'human', 'send']) {
        expect([k, inner[k].left >= 0 && inner[k].right <= inner.iw && inner[k].top >= 0 && inner[k].bottom <= inner.ih]).toEqual([k, true]);
      }
      // typing works and the close control closes it
      await chat.fill('#t', 'Where is my invoice?');
      expect(await chat.inputValue('#t')).toBe('Where is my invoice?');
      await chat.tap('#close');
      await page.waitForSelector('.sasha-frame.open', { state: 'detached' });
      await page.waitForSelector('.sasha-btn', { state: 'visible' });
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowX)).not.toBe('hidden');
      await ctx.close();
    });
  }
});

describe('3. Log Out is in the phone navigation and really signs out', () => {
  for (const [who, email, path, ready] of PAGES) {
    test(`${who} on ${path}`, async () => {
      const { ctx, page } = await signedIn('360px', email, path, ready);
      const logout = page.locator('header.adv-header').getByRole('link', { name: /^log out$/i });
      await logout.waitFor({ state: 'visible' });
      const box = await logout.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(360);
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(health.critical(await health.inspect(page, health.attach(page, { origin: stack.baseUrl }), { allowConsoleErrors: [/net::ERR_FAILED/] }))).toEqual([]);
      await Promise.all([page.waitForURL(/\/login\.html/, { timeout: 20000 }), logout.tap()]);
      expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
      expect((await ctx.cookies()).filter((c) => /session|token|auth/i.test(c.name) && c.value)).toEqual([]);
      await page.goto(stack.baseUrl + path);
      await page.waitForURL(/\/login\.html/, { timeout: 20000 });
      expect(new URL(page.url()).pathname).toBe('/login.html');
      await ctx.close();
    });
  }

  test('admin tools (/admin/): Log out is in the phone bar beside Menu, not only at the end of the Menu', async () => {
    const { ctx, page } = await signedIn('360px', P.admin, '/admin/', '#admin-nav .an-menubtn');
    const logout = page.locator('#admin-nav .an-auth').getByRole('button', { name: /^log out$/i });
    await logout.waitFor({ state: 'visible' });
    for (const el of [logout, page.locator('#admin-nav .an-menubtn')]) {
      const b = await el.boundingBox();
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(360); expect(b.height).toBeGreaterThanOrEqual(32);
    }
    const w = await pageWidth(page);
    expect(w.scrollWidth).toBeLessThanOrEqual(w.innerWidth);
    await Promise.all([page.waitForURL(/\/login\.html/, { timeout: 20000 }), logout.tap()]);
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
    await page.goto(stack.baseUrl + '/admin/');
    await page.waitForURL(/\/login\.html/, { timeout: 20000 });
    await ctx.close();
  });
});
