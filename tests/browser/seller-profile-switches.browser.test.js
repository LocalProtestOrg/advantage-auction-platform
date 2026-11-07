'use strict';

/**
 * The Professional branding visibility switch and the admin follower-email permission switch save on production's
 * schema (they returned 500 until 2026-11-06 by writing seller_profiles.updated_at, which does not exist). Real app and
 * database on the isolated full-stack environment (never production).
 */

const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(240000);
let stack; const T = {};

beforeAll(async () => {
  stack = await startStack();
  const mk = async (key, role, sellerType) => {
    const email = key + '@fullstack.test';
    const userId = await seed.user(stack, { email, role, fullName: key });
    const profileId = sellerType ? await seed.sellerProfile(stack, { userId, sellerType, displayName: key + ' Co' }) : null;
    T[key] = { userId, profileId, token: await seed.apiLogin(stack, email) };
  };
  await mk('pro', 'seller', 'estate_sale_company');
  await mk('individual', 'seller', 'private');
  await mk('admin', 'admin', null);
});
afterAll(async () => { if (stack) await stack.stop(); });

const call = (method, p, token, body) => fetch(stack.baseUrl + p, {
  method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body),
});
const profile = async (id) => (await stack.query('SELECT show_branding_to_buyers, follower_email_enabled FROM seller_profiles WHERE id = $1', [id])).rows[0];

test('a Professional Seller turns branding on and off', async () => {
  for (const on of [true, false]) {
    const r = await call('PATCH', '/api/sellers/me/branding', T.pro.token, { show_branding_to_buyers: on });
    expect([on, r.status]).toEqual([on, 200]);
    expect((await r.json()).data.show_branding_to_buyers).toBe(on);
    expect((await profile(T.pro.profileId)).show_branding_to_buyers).toBe(on);
  }
});

test('an Individual Seller is still refused (403), and nothing changes', async () => {
  const before = await profile(T.individual.profileId);
  const r = await call('PATCH', '/api/sellers/me/branding', T.individual.token, { show_branding_to_buyers: true });
  expect(r.status).toBe(403);
  expect(await profile(T.individual.profileId)).toEqual(before);
});

test('an administrator turns a seller\'s follower-email permission off and on; a seller cannot', async () => {
  for (const enabled of [false, true]) {
    const r = await call('POST', '/api/admin/follower-emails/sellers/' + T.pro.profileId + '/privilege', T.admin.token, { enabled });
    expect([enabled, r.status]).toEqual([enabled, 200]);
    expect((await profile(T.pro.profileId)).follower_email_enabled).toBe(enabled);
  }
  const denied = await call('POST', '/api/admin/follower-emails/sellers/' + T.pro.profileId + '/privilege', T.pro.token, { enabled: false });
  expect(denied.status).toBe(403);
  expect((await profile(T.pro.profileId)).follower_email_enabled).toBe(true);
});

// Campaign attribution (baseline audit 2026-11-06): a Professional registration made after a campaign visit is credited
// to that campaign. The form sends the visitor id; the seller_inquiry and seller_registered conversions carry it.
test('Professional registration keeps the visitor id and the campaign (UTM) of the visit that brought the seller', async () => {
  const visitorId = 'vid-pro-' + Date.now();
  const touch = await fetch(stack.baseUrl + '/api/analytics/touch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId, landing_url: stack.baseUrl + '/seller-demo?utm_source=meta&utm_medium=paid_social&utm_campaign=2026-11-pro-houston' }) });
  expect(touch.status).toBe(202);
  const email = 'utmpro@fullstack.test';
  const userId = await seed.user(stack, { email, role: 'buyer', fullName: 'Utm Pro' });
  const token = await seed.apiLogin(stack, email);
  const r = await call('POST', '/api/sellers/apply-professional', token,
    { seller_type: 'auction_house', company_name: 'Utm Auctions', legal_name: 'Utm Pro', phone: '7135550101', state: 'TX', visitor_id: visitorId });
  expect(r.status).toBe(201);
  let rows = [];
  for (let i = 0; i < 40 && rows.length < 2; i++) {
    rows = (await stack.query(`SELECT conversion_key, visitor_id, attribution FROM marketing_conversion_events WHERE user_id = $1 AND conversion_key IN ('seller_inquiry','seller_registered') ORDER BY conversion_key`, [userId])).rows;
    if (rows.length < 2) await new Promise((res) => setTimeout(res, 250));
  }
  expect(rows.map((x) => [x.conversion_key, x.visitor_id])).toEqual([['seller_inquiry', visitorId], ['seller_registered', visitorId]]);
  for (const x of rows) expect(JSON.stringify(x.attribution)).toMatch(/2026-11-pro-houston/);
  // the visitor's campaign touch now belongs to the seller's account
  for (let i = 0; i < 20; i++) { if ((await stack.query('SELECT 1 FROM marketing_attribution_touches WHERE visitor_id = $1 AND user_id = $2', [visitorId, userId])).rows.length) break; await new Promise((res) => setTimeout(res, 250)); }
  expect((await stack.query('SELECT user_id FROM marketing_attribution_touches WHERE visitor_id = $1', [visitorId])).rows.map((x) => x.user_id)).toEqual([userId]);
});

test('both registration forms send the visitor id', () => {
  const fs = require('fs'); const path = require('path');
  for (const page of ['become-professional-seller.html', 'become-seller.html']) {
    expect([page, /visitor_id: \(function \(\) \{ try \{ return localStorage\.getItem\('aap_visitor_id'\)/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8'))]).toEqual([page, true]);
  }
});
