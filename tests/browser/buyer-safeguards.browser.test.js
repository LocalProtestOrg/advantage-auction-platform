'use strict';

/**
 * Buyer safeguards in a real browser (owner direction 2026-11-06), on the isolated full-stack environment (in-memory
 * database; never production): the registration acceptance box, both terms pages rendering the current version
 * safely, the member-area "Our terms have been updated" notice and the re-acceptance round trip.
 */

const { chromium } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(240000);
let stack; let browser; let versionId;

const FULL_TERMS = [
  '# Advantage.Bid Terms of Service - General and Buyers',
  '',
  '**Last Updated: November 6, 2026**',
  '',
  'These terms apply to everyone who uses Advantage.Bid. <img src=x onerror="window.__xss=1"> stays text.',
  '',
  '## 1. Eligibility', 'You must be at least eighteen (18) years old.', '',
  '## 2. Bidding', '1. Every bid is binding.', '2. Maximum bids are placed for you.', '',
  '## 3. Buyer Premium and Payment', '| Fee | Amount |', '| --- | --- |', '| Buyer premium | As shown on the auction page |', '',
  '## 4. Pickup', 'Collect your items in the pickup window. See [Section 1](#1-eligibility) and [support](mailto:info@advantage.bid).', '',
  '## 5. Text Messages (SMS)', 'Message frequency varies. Reply STOP to cancel, HELP for help.',
].join('\n');

beforeAll(async () => {
  stack = await startStack();
  await stack.query(`UPDATE terms_versions SET is_current = false WHERE kind = 'buyer_terms' AND is_current`);
  versionId = (await stack.query(`INSERT INTO terms_versions (kind, version_int, title, body_markdown, is_current)
    VALUES ('buyer_terms', 90, 'Terms of Service - General and Buyers', $1, true) RETURNING id`, [FULL_TERMS])).rows[0].id;
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

async function open(ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === stack.baseUrl ? route.continue() : route.abort()));
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

test('registration: the box starts unchecked and is required; with it, the account and its acceptance of the current version are recorded', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 360, height: 740 } });
  await page.goto(stack.baseUrl + '/login.html?tab=register', { waitUntil: 'networkidle' });
  expect(await page.isChecked('#reg-terms')).toBe(false);
  expect(await page.getAttribute('#reg-terms + span a[href="/terms.html"]', 'target')).toBe('_blank');
  await page.fill('#reg-email', 'terms-buyer@fullstack.test');
  await page.fill('#reg-password', seed.TEST_PASSWORD);
  await page.fill('#reg-confirm', seed.TEST_PASSWORD);
  await page.click('#register-btn');
  await expect(page.textContent('#register-error')).resolves.toMatch(/Please agree to the Terms of Service and Buyer Terms/);
  expect((await stack.query(`SELECT count(*)::int n FROM users WHERE email = 'terms-buyer@fullstack.test'`)).rows[0].n).toBe(0);
  // no horizontal scrolling at phone width
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.check('#reg-terms');
  await Promise.all([page.waitForURL((u) => !/login\.html/.test(String(u)), { timeout: 20000 }), page.click('#register-btn')]);
  const rows = (await stack.query(`SELECT tv.version_int, ta.user_agent FROM terms_acceptances ta JOIN terms_versions tv ON tv.id = ta.terms_version_id
    JOIN users u ON u.id = ta.user_id WHERE u.email = 'terms-buyer@fullstack.test'`)).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].version_int).toBe(90);
  expect(rows[0].user_agent).toMatch(/Chrome|HeadlessChrome/);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('/terms.html and /buyer-terms.html render the same current version with contents and anchors; raw HTML stays text', async () => {
  for (const p of ['/terms.html', '/buyer-terms.html']) {
    const { ctx, page, errors } = await open({ viewport: { width: 375, height: 800 } });
    await page.goto(stack.baseUrl + p, { waitUntil: 'networkidle' });
    await page.waitForSelector('h2[id="1-eligibility"]');
    const info = await page.evaluate(() => ({
      h1: document.querySelector('.doc h1') && document.querySelector('.doc h1').textContent,
      toc: [...document.querySelectorAll('.md-toc a')].map((a) => a.getAttribute('href')),
      meta: document.getElementById('doc-meta').textContent,
      img: document.querySelectorAll('.doc img').length,
      xss: window.__xss || 0,
      table: !!document.querySelector('.doc table td'),
      sms: /Reply STOP/.test(document.body.textContent),
      noHScroll: document.documentElement.scrollWidth <= window.innerWidth,
    }));
    expect([p, info.h1]).toEqual([p, 'Advantage.Bid Terms of Service - General and Buyers']);
    expect(info.toc).toEqual(['#1-eligibility', '#2-bidding', '#3-buyer-premium-and-payment', '#4-pickup', '#5-text-messages-sms']);
    expect(info.meta).toMatch(/^Version 90/);
    expect([info.img, info.xss, info.table, info.sms, info.noHScroll]).toEqual([0, 0, true, true, true]);
    expect([p, errors]).toEqual([p, []]);
    await ctx.close();
  }
});

test('member area: an account that has not accepted the current version sees a non-blocking notice and can accept and return', async () => {
  const email = 'older-acceptance@fullstack.test';
  await seed.user(stack, { email, role: 'buyer', fullName: 'Old Acceptance' });
  const { ctx, page, errors } = await open({ viewport: { width: 1200, height: 900 } });
  await seed.browserLogin(page, stack, email);
  await page.goto(stack.baseUrl + '/app.html', { waitUntil: 'load' });
  await page.waitForSelector('[data-notice="terms"]', { timeout: 20000 });
  expect(await page.textContent('[data-notice="terms"]')).toMatch(/Our terms have been updated\./);
  await page.waitForSelector('#adv-main', { timeout: 20000 });   // the dashboard still renders (never blocked)
  await Promise.all([page.waitForURL(/buyer-terms\.html/), page.click('[data-notice="terms"] a.act')]);
  await page.waitForSelector('#accept-action button');
  await Promise.all([page.waitForURL(/\/app\.html/, { timeout: 20000 }), page.click('#accept-action button')]);
  const n = (await stack.query(`SELECT count(*)::int n FROM terms_acceptances ta JOIN users u ON u.id = ta.user_id
    WHERE u.email = $1 AND ta.terms_version_id = $2`, [email, versionId])).rows[0].n;
  expect(n).toBe(1);
  await page.waitForSelector('#adv-main', { timeout: 20000 });
  await page.waitForTimeout(800);
  expect(await page.$('[data-notice="terms"]')).toBeNull();
  expect(errors).toEqual([]);
  await ctx.close();
});
