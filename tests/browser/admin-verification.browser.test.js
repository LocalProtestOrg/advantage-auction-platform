'use strict';
/**
 * Admin Seller Verification (owner 2026-11-12), as served by the real app in a real browser on the isolated full-stack
 * environment (tests/fullstack; never production). The page used to need a typed seller id, offered no way to see who
 * was waiting, and its settings form opened on "verification required: No", so saving notes silently exempted a seller.
 * Covers: the awaiting and exempt lists; the plain-language status; the settings form showing the seller's real values;
 * exempting needs a confirmation; a submitted request is approved with "Approve business verification" and the seller
 * leaves the awaiting list. Nothing is approved without a submitted request.
 */
const { chromium } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const health = require('../../src/services/watchdog/pageHealth');

jest.setTimeout(180000);
let stack; let browser; let page; const dialogs = [];
const ADMIN = 'verify-admin@fullstack.test';
const ids = {};

async function proSeller(email, name, { required = true, sellerType = 'retail_gallery_studio' } = {}) {
  const uid = await seed.user(stack, { email, role: 'seller', fullName: name });
  return seed.sellerProfile(stack, { userId: uid, sellerType, displayName: name, extra: { verification_required_before_publication: required } });
}

beforeAll(async () => {
  stack = await startStack();
  await seed.user(stack, { email: ADMIN, role: 'admin', fullName: 'Vera Verifier' });
  await stack.query(`UPDATE users SET staff_role = 'super_admin' WHERE email = $1`, [ADMIN]);
  ids.waiting = await proSeller('waiting@fullstack.test', 'Waiting Gallery');                       // required, nothing submitted
  ids.submitted = await proSeller('submitted@fullstack.test', 'Submitted Studio');                   // required, documents in
  ids.exempt = await proSeller('exempt@fullstack.test', 'Exempt Antiques', { required: false });    // switched off, never verified
  const req = (await stack.query(`INSERT INTO verification_requests (seller_profile_id, status, message) VALUES ($1, 'submitted', 'Professional Seller business verification') RETURNING id`, [ids.submitted])).rows[0];
  await stack.query(`INSERT INTO verification_documents (request_id, seller_profile_id, category, storage_public_id, original_filename, content_type, byte_size, status)
    VALUES ($1, $2, 'business_license', 'isolated/license', 'license.pdf', 'application/pdf', 1000, 'submitted')`, [req.id, ids.submitted]);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await seed.browserLogin(page, stack, ADMIN, seed.TEST_PASSWORD, '/admin/verification.html');
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

const flags = async (id) => (await stack.query('SELECT verification_required_before_publication AS r FROM seller_profiles WHERE id = $1', [id])).rows[0].r;

test('the page lists who is waiting (with status and what is needed) and who is exempt; no typed id needed', async () => {
  const probe = health.attach(page, { origin: stack.baseUrl });
  await page.goto(stack.baseUrl + '/admin/verification.html');
  await page.waitForSelector('#queueAwait table');
  const awaiting = await page.$eval('#queueAwait', (e) => e.innerText);
  expect(awaiting).toMatch(/Waiting Gallery[\s\S]*Awaiting Seller Action[\s\S]*Verification not started/);
  expect(awaiting).toMatch(/Submitted Studio[\s\S]*Awaiting Admin Review/);
  expect(awaiting).not.toMatch(/Exempt Antiques/);
  expect(await page.$eval('#queueExempt', (e) => e.innerText)).toMatch(/Exempt Antiques[\s\S]*Not required \(exempt\)/);
  expect(health.critical(await health.inspect(page, probe, {}))).toEqual([]);
});

test('opening a seller shows its status in plain words, and the settings form shows its REAL values', async () => {
  await page.click(`button[data-open="${ids.waiting}"]`);
  await page.waitForSelector('#statusBox b');
  expect(await page.$eval('#statusBox', (e) => e.innerText)).toMatch(/Awaiting Seller Action[\s\S]*blocked until business verification is approved/);
  expect(await page.$eval('#nextSteps', (e) => e.innerText)).toMatch(/verify-documents\.html/);
  expect(await page.$eval('#vreq', (e) => e.value)).toBe('true');   // used to open on "No"
  expect(await page.$eval('#reqs', (e) => e.innerText)).toMatch(/No verification requests yet/);
  expect(await page.$$('button[data-act="approved"]')).toHaveLength(0);   // nothing submitted: nothing to approve
  // And an exempt seller opens on its real value ("No"), with its status saying so.
  await page.click(`button[data-open="${ids.exempt}"]`);
  await page.waitForFunction(() => /Not required \(exempt\)/.test(document.getElementById('statusBox').innerText));
  expect(await page.$eval('#vreq', (e) => e.value)).toBe('false');
  await page.click(`button[data-open="${ids.waiting}"]`);
  await page.waitForFunction(() => /Awaiting Seller Action/.test(document.getElementById('statusBox').innerText));
});

test('saving notes keeps verification required (the old form silently exempted the seller)', async () => {
  await page.fill('#rnotes', 'Called the owner; documents expected this week.');
  await page.click('#saveRisk');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('riskMsg').textContent));
  expect(await flags(ids.waiting)).toBe(true);
});

test('exempting a seller asks for confirmation first', async () => {
  dialogs.length = 0;
  page.removeAllListeners('dialog');
  page.once('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });   // the admin cancels
  await page.selectOption('#vreq', 'false');
  await page.click('#saveRisk');
  expect(dialogs[0]).toMatch(/Exempt this seller from business verification/);
  expect(await flags(ids.waiting)).toBe(true);
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.selectOption('#vreq', 'true');
});

test('a submitted request is approved with "Approve business verification"; the seller is then verified and leaves the list', async () => {
  await page.click(`button[data-open="${ids.submitted}"]`);
  await page.waitForFunction(() => /Awaiting Admin Review/.test(document.getElementById('statusBox').innerText));
  await page.waitForSelector('button[data-act="approved"]');
  expect(await page.$eval('button[data-act="approved"]', (b) => b.textContent)).toBe('Approve business verification');
  await page.click('button[data-act="approved"]');
  await page.waitForFunction(() => /^Verified/.test(document.getElementById('statusBox').innerText));
  expect(await page.$eval('#statusBox', (e) => e.innerText)).toMatch(/Purchases: not blocked by verification/);
  const approved = (await stack.query(`SELECT count(*)::int n FROM verification_requests WHERE seller_profile_id = $1 AND status = 'approved'`, [ids.submitted])).rows[0].n;
  expect(approved).toBe(1);
  await page.waitForFunction(() => !/Submitted Studio/.test(document.getElementById('queueAwait').innerText));
});
