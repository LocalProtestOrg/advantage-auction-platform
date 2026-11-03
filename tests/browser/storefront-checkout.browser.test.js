'use strict';

/**
 * Fixed-price checkout end to end on the isolated full-stack environment (tests/fullstack): the real app and real
 * database, with the payment processor replaced by an in-memory stand-in (fakeStripePreload.js; no network, no keys,
 * nothing real is charged) and checkout switched on for this environment only. Never production.
 *   - Buyers racing for the last units over HTTP at the same moment: never oversold, never sold twice.
 *   - A real browser purchase that starts in the seller's website widget: quantity, review, pay, confirmation and the
 *     way back to the seller's own website.
 *   - Declined and prepaid cards; a seller who cannot be paid is never charged for.
 */

const http = require('http');
const crypto = require('crypto');
const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const sj = require('../fullstack/seedJourneys');

jest.setTimeout(240000);

let stack; let browser; let site; let siteUrl;
const shop = {}; const buyers = [];

// The card field library from the payment provider cannot load in an isolated test; this stand-in creates a payment
// method id the fake processor understands ("decline"/"prepaid" in the cardholder name choose those outcomes).
const STRIPE_JS_SHIM = `window.Stripe=function(){return{elements:function(){return{create:function(){return{mount:function(sel){var d=document.querySelector(sel);if(d){d.textContent='Test card field';}}};}};},
  createPaymentMethod:function(o){var n=((o&&o.billing_details&&o.billing_details.name)||'').toLowerCase();return Promise.resolve({paymentMethod:{id:'pm_test_'+(n.indexOf('decline')>=0?'decline':n.indexOf('prepaid')>=0?'prepaid':'ok')+'_'+Date.now()}});},
  handleCardAction:function(){return Promise.resolve({});}};};`;

async function makeReady(sellerProfileId, userId, website) {
  await seed.signedStorefrontAgreement(stack, sellerProfileId);   // a waiver alone no longer counts for storefront sales
  await stack.query(`UPDATE seller_profiles SET agreement_waived_at = now(), storefront = jsonb_set(coalesce(storefront, '{}'::jsonb), '{website}', to_jsonb($2::text)) WHERE id = $1`, [sellerProfileId, website]);
  await stack.query(`INSERT INTO seller_payout_preferences (seller_user_id, payout_method, stripe_account_id, stripe_account_livemode, connect_status,
                       connect_details_submitted, connect_transfers_active, connect_payouts_enabled)
                     VALUES ($1, 'ach', $2, false, 'ready', true, true, true)
                     ON CONFLICT (seller_user_id) DO UPDATE SET stripe_account_id = EXCLUDED.stripe_account_id, connect_transfers_active = true, connect_payouts_enabled = true`,
    [userId, 'acct_test_' + crypto.randomBytes(6).toString('hex')]);
}
async function item(title, quantity, priceCents, inv) {
  const id = await sj.publishedItem(stack, { sellerProfileId: shop.sellerProfileId, title, priceCents, inventoryNumber: inv });
  await stack.query('UPDATE marketplace_items SET quantity = $2 WHERE id = $1', [id, quantity]);
  return id;
}
async function api(token, method, p, body, headers = {}) {
  const r = await fetch(stack.baseUrl + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) { /* none */ }
  return { status: r.status, j };
}
const order = (b, itemId, quantity = 1) => api(b.token, 'POST', '/api/marketplace/orders', { item_id: itemId, quantity, policies_acknowledged: true },
  { 'Idempotency-Key': crypto.randomUUID() });
const pay = (b, orderId, pm = 'pm_test_ok') => api(b.token, 'POST', `/api/marketplace/orders/${orderId}/pay`, { payment_method_id: pm }, { 'Idempotency-Key': crypto.randomUUID() });
const stock = (id) => stack.query('SELECT status, quantity, quantity_sold FROM marketplace_items WHERE id = $1', [id]).then((r) => r.rows[0]);

beforeAll(async () => {
  stack = await startStack({ fakePayments: true });
  Object.assign(shop, await sj.publishedStorefront(stack, { email: 'pottery-owner@fullstack.test', slug: 'riverbend-pottery', name: 'Riverbend Pottery' }));
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Riverbend Pottery</title></head><body><h1>Riverbend Pottery</h1>
      <iframe src="${stack.baseUrl}/embed/storefront.html?seller=${shop.sellerProfileId}" title="Shop" style="border:0;width:100%;height:900px"></iframe></body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://localhost:${site.address().port}/`;
  await makeReady(shop.sellerProfileId, shop.userId, siteUrl);
  for (let i = 0; i < 12; i++) {
    const email = `buyer${i}@fullstack.test`;
    const id = await seed.user(stack, { email, role: 'buyer', fullName: 'Buyer ' + i });
    buyers.push({ id, email, token: await seed.apiLogin(stack, email) });
  }
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (site) site.close(); if (stack) await stack.stop(); });

describe('payment at the same moment, and card outcomes (real server, real database)', () => {
  // Many buyers at the same moment: the isolated in-memory test database cannot serve many simultaneous connections
  // reliably, so large races run against a real disposable Postgres with scripts/checkout-race-test.js (an activation
  // step). The rules themselves (row lock + guarded decrement, released once, sold once) are covered statement by statement
  // in tests/storefront-multi-quantity.test.js.
  test('the same payment sent twice at once is one sale', async () => {
    const id = await item('Bud Vase', 3, 1800, 'RP-3');
    const b = buyers[11];
    const o = await order(b, id, 2);
    const [p1, p2] = await Promise.all([pay(b, o.j.data.order.id), pay(b, o.j.data.order.id)]);
    expect([p1.j && p1.j.data && p1.j.data.status, p2.j && p2.j.data && p2.j.data.status]).toContain('succeeded');
    expect(await stock(id)).toMatchObject({ quantity: 1, quantity_sold: 2, status: 'active' });
    const sold = (await stack.query(`SELECT count(*)::int n FROM marketplace_stock_events WHERE item_id = $1 AND reason = 'sold'`, [id])).rows[0].n;
    expect(sold).toBe(1);
  });

  test('a declined card leaves the units held for a retry with another card; a prepaid card is refused before any charge', async () => {
    const id = await item('Pitcher', 2, 4200, 'RP-4');
    const b = buyers[10];
    const o = await order(b, id, 1);
    const declined = await pay(b, o.j.data.order.id, 'pm_test_decline_1');
    expect([declined.status, declined.j.code]).toEqual([402, 'CARD_DECLINED']);
    expect(await stock(id)).toMatchObject({ quantity: 1 });
    const prepaid = await pay(b, o.j.data.order.id, 'pm_test_prepaid_1');
    expect([prepaid.status, prepaid.j.code]).toEqual([422, 'PREPAID_NOT_ACCEPTED']);
    expect((await pay(b, o.j.data.order.id)).j.data.status).toBe('succeeded');
    expect(await stock(id)).toMatchObject({ quantity: 1, quantity_sold: 1 });
  });
});

describe('a purchase that starts on the seller\'s own website', () => {
  test.each([['desktop', {}], ['phone', devices['iPhone 13']]])('%s: widget item, quantity 2, review, pay, confirmation, and back to the seller\'s website', async (label, ctxOpts) => {
    const id = await item('Serving Platter ' + label, 3, 2500, 'RP-PL-' + label);
    const b = buyers[label === 'desktop' ? 8 : 9];
    const ctx = await browser.newContext(ctxOpts);
    await ctx.route('https://js.stripe.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: STRIPE_JS_SHIM }));
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await seed.browserLogin(page, stack, b.email);
    await page.goto(siteUrl, { waitUntil: 'networkidle' });
    const frame = page.frame({ url: /embed\/storefront\.html/ });
    await frame.click(`a.sw-card:has-text("Serving Platter ${label}")`);
    await frame.waitForSelector('.sw-buy a.sw-btn');
    expect(await frame.textContent('.sw-buy a.sw-btn')).toBe('Buy Now');
    const [checkout] = await Promise.all([ctx.waitForEvent('page'), frame.click('.sw-buy a.sw-btn')]);   // secure checkout in a new tab
    checkout.on('pageerror', (e) => errors.push(e.message));
    expect(page.url()).toBe(siteUrl);                                                                      // the seller's site stays open
    await checkout.waitForLoadState('networkidle');
    expect(checkout.url()).toMatch(/ref=widget/);
    await checkout.click('#buyNow');
    await checkout.selectOption('#qty', '2');
    await checkout.fill('#a_name', 'Buyer Person'); await checkout.fill('#a_line1', '5 Oak St'); await checkout.fill('#a_city', 'Houston');
    await checkout.fill('#a_state', 'TX'); await checkout.fill('#a_zip', '77002');
    await checkout.click('#toReview');
    await checkout.waitForSelector('#payBtn');
    expect(await checkout.textContent('.lines')).toMatch(/Item \(2 × \$25(\.00)?\)/);
    expect(await checkout.textContent('#payBtn')).toMatch(/\$50/);
    await checkout.check('#ackPol');
    await checkout.click('#payBtn');
    await checkout.waitForSelector('h3.ok', { timeout: 30000 });
    expect(await checkout.textContent('.modal, body')).toMatch(/× 2/);
    const back = await checkout.$('#backToSeller');
    expect(back).not.toBeNull();
    expect(await back.getAttribute('href')).toBe(siteUrl);
    expect(await back.textContent()).toBe("Return to Riverbend Pottery's website");
    const o = (await stack.query(`SELECT quantity, unit_price_cents, item_price_cents, payment_status, seller_id FROM marketplace_orders
                                    WHERE marketplace_item_id = $1`, [id])).rows;
    expect(o).toEqual([expect.objectContaining({ quantity: 2, unit_price_cents: 2500, item_price_cents: 5000, payment_status: 'paid', seller_id: shop.sellerProfileId })]);
    expect(await stock(id)).toMatchObject({ quantity: 1, quantity_sold: 2, status: 'active' });
    // the widget on the seller's site and the marketplace show the same remaining stock
    const feed = await (await fetch(stack.baseUrl + '/api/public/storefront/widget/' + shop.sellerProfileId)).json();
    expect(feed.data.items.some((x) => x.id === id)).toBe(true);
    const pub = await (await fetch(stack.baseUrl + '/api/public/storefront/item/' + id)).json();
    expect(pub.data.quantity).toBe(1);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});

test('a seller who cannot be paid (payout account not ready) gets no orders: the buyer sees a neutral message, nothing is charged', async () => {
  const id = await item('Teapot', 2, 3000, 'RP-5');
  await stack.query('UPDATE seller_payout_preferences SET connect_payouts_enabled = false WHERE seller_user_id = $1', [shop.userId]);
  try {
    const r = await order(buyers[7], id, 1);
    expect([r.status, r.j.code, r.j.message]).toEqual([409, 'SELLER_NOT_ACCEPTING_ORDERS', 'This seller is not accepting orders right now.']);
    expect(await stock(id)).toMatchObject({ quantity: 2 });
  } finally {
    await stack.query('UPDATE seller_payout_preferences SET connect_payouts_enabled = true WHERE seller_user_id = $1', [shop.userId]);
  }
});
