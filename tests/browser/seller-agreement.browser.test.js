'use strict';

/**
 * Browser regression: the Professional Seller agreement journey in a real browser (Chromium), against the real app on
 * the real schema (tests/fullstack). Nothing here touches a real database, payment processor or email provider.
 *
 * Pins the 2026-10-30 defect: the signing link opened sign-agreement.html, but the page showed raw JavaScript instead
 * of the agreement, because a middleware tag was inserted inside the page's script. These tests fail if the agreement
 * is not legible, if script text is visible, or if signing is possible without the agreement having been displayed.
 */

const crypto = require('crypto');
const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const health = require('../../src/services/watchdog/pageHealth');

jest.setTimeout(180000);

let stack; let browser; let admin; let sellerUser; let sellerProfileId; let adminToken;
const SELLER_EMAIL = 'pro-seller@fullstack.test';

async function sendAgreement() {
  const r = await fetch(stack.baseUrl + '/api/admin/agreements/agreements', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ sellerProfileId, overrides: { legal_name: 'Pat Professional', signatory_name: 'Pat Professional', seller_type: 'auction_house', effective_date: '2026-10-30' } }),
  });
  const j = await r.json();
  if (!j.success) throw new Error('send failed: ' + JSON.stringify(j));
  return j.data;
}

beforeAll(async () => {
  stack = await startStack();
  await seed.sellerAgreementTemplate(stack);
  admin = await seed.user(stack, { email: 'admin@fullstack.test', role: 'admin', fullName: 'Ada Admin' });
  sellerUser = await seed.user(stack, { email: SELLER_EMAIL, role: 'seller', fullName: 'Pat Professional' });
  sellerProfileId = await seed.sellerProfile(stack, { userId: sellerUser, sellerType: 'auction_house', displayName: 'Pat Auctions' });
  adminToken = await seed.apiLogin(stack, 'admin@fullstack.test');
  browser = await chromium.launch();
});

afterAll(async () => {
  if (browser) await browser.close();
  if (stack) await stack.stop();
});

describe('the signing link shows a legible, complete agreement (never raw script)', () => {
  test('desktop: formatted agreement, labelled terms, no script text, token removed from the address bar', async () => {
    const sent = await sendAgreement();
    const page = await browser.newPage();
    // The emailed link, opened signed out: the sign-in gate sends the seller through login, then back to the agreement.
    await page.goto(sent.signing_link);
    expect(page.url()).toMatch(/\/login\.html\?next=/);
    const probe = health.attach(page, { origin: stack.baseUrl });
    await page.fill('#login-email', SELLER_EMAIL);
    await page.fill('#login-password', seed.TEST_PASSWORD);
    await Promise.all([page.waitForURL(/sign-agreement\.html/), page.click('#login-btn')]);
    await page.waitForSelector('#doc-body h2');
    const issues = await health.inspect(page, probe, { expectText: ['Advantage.Bid Seller Consignment and Auction Services Agreement', 'Fees, Commission, and Buyer Premium'] });
    expect(health.critical(issues)).toEqual([]);
    // Formatted, not raw markdown.
    const doc = await page.$eval('#doc-body', (el) => ({ h: el.querySelectorAll('h2,h3,h4').length, strong: el.querySelectorAll('strong').length, text: el.innerText }));
    expect(doc.h).toBeGreaterThan(8);
    expect(doc.strong).toBeGreaterThan(5);
    expect(doc.text).not.toMatch(/\*\*|^#{1,4}\s/m);
    // Seller-specific terms, version and effective date, with readable labels.
    const terms = await page.$eval('#terms', (el) => el.innerText);
    expect(terms).toMatch(/Seller\s+Pat Professional/);
    expect(terms).toMatch(/Effective date\s+2026-10-30/);
    expect(terms).toMatch(/Seller type\s+Auction house/);
    expect(terms).toMatch(/\(v3\)/);
    // Fee information comes from the agreement itself (fixed prose).
    expect(doc.text).toMatch(/platform\/software fee of 4% of the hammer price/);
    expect(doc.text).toMatch(/5% of the item selling price for a sale that originates on the Seller's own website/);
    expect(doc.text).toMatch(/9% of the item selling price for every other sale/);
    // The private token is not left in the address bar.
    expect(page.url()).not.toMatch(/token=/);
    // Signed in as the agreement's seller: the signing form is offered once the document is confirmed.
    expect(await page.isVisible('#sign-form')).toBe(true);
    await page.close();
  });

  test('mobile: readable without sideways scrolling, signature pad usable', async () => {
    const sent = await sendAgreement();
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript(() => {});
    const page = await ctx.newPage();
    const probe = health.attach(page, { origin: stack.baseUrl });
    // Sign in first so the signing form renders.
    await seed.browserLogin(page, stack, SELLER_EMAIL);
    await page.goto(stack.baseUrl + '/sign-agreement.html?id=' + sent.id);
    await page.waitForSelector('#sign-form', { state: 'visible' });
    const issues = await health.inspect(page, probe, { expectText: ['Fees, Commission, and Buyer Premium'] });
    expect(issues.filter((i) => i.severity === 'critical' || i.code === 'HORIZONTAL_OVERFLOW')).toEqual([]);
    const box = await page.$eval('#sig-canvas', (c) => ({ w: c.getBoundingClientRect().width, px: c.width }));
    expect(box.w).toBeGreaterThan(250);
    expect(box.px).toBeGreaterThanOrEqual(Math.round(box.w * 2));   // sharp on a high-density screen
    await ctx.close();
  });
});

describe('complete signing: acknowledgments, typed and drawn signature, records, downloads, printing', () => {
  test('seller signs; the signature records the hash of the exact displayed text', async () => {
    const sent = await sendAgreement();
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    const probe = health.attach(page, { origin: stack.baseUrl });
    await seed.browserLogin(page, stack, SELLER_EMAIL);
    await page.goto(stack.baseUrl + '/sign-agreement.html?id=' + sent.id);
    await page.waitForSelector('#sign-form', { state: 'visible' });

    // Unsigned PDF download works before signing.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dl-unsigned')]);
    const pdfPath = await download.path();
    expect(require('fs').readFileSync(pdfPath).slice(0, 5).toString()).toBe('%PDF-');

    // Print opens a clean review copy (stamp + the full formatted text).
    const [printWin] = await Promise.all([ctx.waitForEvent('page'), page.click('#print-agreement')]);
    await printWin.evaluate(() => { window.print = () => {}; });
    await printWin.waitForFunction(() => document.querySelectorAll('h2,h3').length > 5);
    const printed = await printWin.evaluate(() => document.body.innerText);
    expect(printed).toMatch(/Review Copy/);
    expect(printed).toMatch(/Agreement version: v3/);
    expect(printed).toMatch(/Fees, Commission, and Buyer Premium/);
    expect(printed).not.toMatch(/function|getElementById/);
    await printWin.close();

    // Acknowledgments are enforced in the page.
    await page.fill('#typed-name', 'Pat Professional');
    await page.click('#sign-btn');
    await expect(page.textContent('#sign-err')).resolves.toMatch(/read and reviewed/);
    // Draw a signature.
    const c = await page.$('#sig-canvas'); const b = await c.boundingBox();
    await page.mouse.move(b.x + 20, b.y + 40); await page.mouse.down();
    await page.mouse.move(b.x + 120, b.y + 90, { steps: 8 }); await page.mouse.move(b.x + 220, b.y + 30, { steps: 8 }); await page.mouse.up();
    for (const id of ['#reviewed', '#consent', '#intent']) await page.check(id);
    await page.click('#sign-btn');
    await page.waitForSelector('#signed-card', { state: 'visible' });
    expect(health.critical(await health.inspect(page, probe, { allowRequests: [/\/pdf$/] }))).toEqual([]);

    const a = (await stack.query('SELECT status, rendered_body, pdf_status FROM agreements WHERE id = $1', [sent.id])).rows[0];
    const sig = (await stack.query('SELECT typed_name, content_sha256, reviewed_acknowledged, consent_acknowledged, ip_address, user_agent FROM agreement_signatures WHERE agreement_id = $1', [sent.id])).rows;
    expect(a.status).toBe('signed');
    expect(sig).toHaveLength(1);
    expect(sig[0]).toMatchObject({ typed_name: 'Pat Professional', reviewed_acknowledged: true, consent_acknowledged: true });
    expect(sig[0].content_sha256).toBe(crypto.createHash('sha256').update(a.rendered_body).digest('hex'));
    expect(sig[0].user_agent).toBeTruthy();
    // PDF storage is not configured in the isolated environment: signing still completes (the PDF never blocks it).
    expect(['failed', 'stored']).toContain(a.pdf_status);
    const audit = (await stack.query("SELECT event_type FROM audit_log WHERE entity_id = $1 ORDER BY created_at", [sent.id])).rows.map((r) => r.event_type);
    expect(audit).toEqual(expect.arrayContaining(['agreement_sent', 'agreement_signed']));
    await ctx.close();
  });

  test('an agreement that was not displayed correctly cannot be signed (page refuses, server refuses)', async () => {
    const sent = await sendAgreement();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await seed.browserLogin(page, stack, SELLER_EMAIL);
    // Simulate a truncated/altered document reaching the browser.
    await page.route('**/api/agreements/' + sent.id, async (route) => {
      const res = await route.fetch(); const j = await res.json();
      j.data.rendered_body = j.data.rendered_body.slice(0, 400);
      await route.fulfill({ response: res, json: j });
    });
    await page.goto(stack.baseUrl + '/sign-agreement.html?id=' + sent.id);
    await page.waitForFunction(() => /cannot be signed here/.test(document.getElementById('meta').innerText));
    expect(await page.isVisible('#sign-card')).toBe(false);
    await ctx.close();
    // The server independently refuses a signature without the displayed text's hash, or with a different one.
    const token = await seed.apiLogin(stack, SELLER_EMAIL);
    const body = { typed_name: 'Pat Professional', reviewed_acknowledged: true, consent_acknowledged: true, intent_acknowledged: true };
    for (const extra of [{}, { displayed_sha256: 'f'.repeat(64) }]) {
      const r = await fetch(stack.baseUrl + '/api/agreements/' + sent.id + '/sign', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ ...body, ...extra }) });
      expect(r.status).toBe(409);
      expect((await r.json()).code).toBe('DISPLAY_NOT_CONFIRMED');
    }
    expect((await stack.query('SELECT count(*)::int n FROM agreement_signatures WHERE agreement_id = $1', [sent.id])).rows[0].n).toBe(0);
  });
});

describe('signing links: revocation, replacement and expiry', () => {
  const call = (method, p, body) => fetch(stack.baseUrl + '/api/admin/agreements' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken, 'Idempotency-Key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json().then((j) => ({ status: r.status, j })));
  const byToken = (link) => fetch(stack.baseUrl + '/api/agreements/by-token/' + new URL(link).searchParams.get('token'));

  test('revoking the link stops it at once; a replacement link works; the agreement itself stays signable', async () => {
    const sent = await sendAgreement();
    expect((await byToken(sent.signing_link)).status).toBe(200);
    const list = await call('GET', '/agreements?email=' + encodeURIComponent(SELLER_EMAIL));
    const row = list.j.data.find((x) => x.id === sent.id);
    expect(row.link_active).toBe(true);
    expect(row.access_token_hash).toBeUndefined();   // the hash never leaves the server
    expect((await call('POST', '/agreements/' + sent.id + '/revoke-link', { reason: 'exposed' })).status).toBe(200);
    expect((await byToken(sent.signing_link)).status).toBe(404);
    const again = await call('GET', '/agreements?email=' + encodeURIComponent(SELLER_EMAIL));
    expect(again.j.data.find((x) => x.id === sent.id).link_active).toBe(false);
    const fresh = await call('POST', '/agreements/' + sent.id + '/resend');
    expect(fresh.status).toBe(200);
    expect((await byToken(fresh.j.data.signing_link)).status).toBe(200);
    const audit = (await stack.query("SELECT event_type FROM audit_log WHERE entity_id = $1", [sent.id])).rows.map((r) => r.event_type);
    expect(audit).toEqual(expect.arrayContaining(['agreement_link_revoked', 'agreement_resent']));
  });

  test('an expired link no longer opens the agreement', async () => {
    const sent = await sendAgreement();
    await stack.query("UPDATE agreements SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [sent.id]);
    expect((await byToken(sent.signing_link)).status).toBe(404);
  });
});

describe('the watchdog detector recognises the original defect', () => {
  test('the pre-fix page, served with the old injection, is reported as raw script text (critical)', async () => {
    const fs = require('fs'); const path = require('path');
    const before = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sign-agreement-before-fix-2026-10-29.html'), 'utf8');
    const at = before.search(/<\/body>/i);
    const broken = before.slice(0, at) + '\n<script src="/widgets/sasha-loader.js" async></script>\n' + before.slice(at);
    const page = await browser.newPage();
    const probe = health.attach(page, {});
    await page.route('**/*', (route) => route.request().url().startsWith('https://agreement.test/')
      ? route.fulfill({ contentType: 'text/html', body: broken }) : route.fulfill({ status: 204, body: '' }));
    await page.goto('https://agreement.test/sign-agreement.html?token=x');
    const codes = (await health.inspect(page, probe, { expectText: ['Fees, Commission, and Buyer Premium'] })).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['RAW_SCRIPT_TEXT', 'PAGE_ERROR', 'MISSING_CONTENT']));
    await page.close();
  });
});
