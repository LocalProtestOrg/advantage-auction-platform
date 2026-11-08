'use strict';

/**
 * Current Seller Agreement version (owner decisions 2026-11-07), on the real app and database (isolated full-stack
 * environment, never production):
 *   - publishing a new version sends nothing to existing sellers (no email, SMS or reminder);
 *   - signing in, the dashboard and existing listings are never blocked;
 *   - a seller who signed an earlier version is asked to accept the current one when a NEW listing would go public
 *     (auction submission, a storefront item going live), and nothing is published until they do; drafts are kept;
 *   - the in-app "Review and Accept" issues the current version without any email; once signed, listing proceeds and
 *     the seller is not asked again for that version; earlier signed agreements stay on record unchanged.
 */

const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(240000);
let stack; let v3; const S = {};

const api = (method, p, token, body) => fetch(stack.baseUrl + p, {
  method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const emailsSkipped = () => (stack.logs().match(/\[email\] SMTP\/SES not configured - skipping delivery/g) || []).length;

beforeAll(async () => {
  stack = await startStack();
  v3 = await seed.sellerAgreementTemplate(stack, { version: 3 });
  const mk = async (key, sellerType, extra = {}) => {
    const email = key + '@fullstack.test';
    const userId = await seed.user(stack, { email, role: 'seller', fullName: key });
    const profileId = await seed.sellerProfile(stack, { userId, sellerType, displayName: key + ' Co', extra });
    const signedV3 = (await stack.query(`INSERT INTO agreements (template_version_id, seller_profile_id, status, signed_at)
      VALUES ($1, $2, 'signed', now() - interval '30 days') RETURNING id`, [v3.versionId, profileId])).rows[0].id;
    S[key] = { email, userId, profileId, signedV3, token: await seed.apiLogin(stack, email) };
  };
  await mk('indy', 'private');
  await mk('esme', 'estate_sale_company', { storefront_slug: 'esme-co', storefront_published: true,
    default_pickup_address_line1: '100 Main St', default_pickup_city: 'Houston', default_pickup_state: 'TX', default_pickup_postal_code: '77002',
    default_pickup_country: 'US', default_pickup_confirmed_at: new Date() });
  // An existing auction already submitted under the earlier version: never touched by the new version.
  S.indy.oldAuction = (await stack.query(`INSERT INTO auctions (seller_id, title, state, city, address_state, zip, street_address, end_time)
    VALUES ($1, 'Earlier Auction', 'submitted', 'Houston', 'TX', '77002', '1 Old St', now() + interval '5 days') RETURNING id`, [S.indy.profileId])).rows[0].id;
  S.emailsBefore = emailsSkipped();
  // Version 4 is published (the template's current version moves); nothing is sent to anyone.
  await seed.sellerAgreementTemplate(stack, { version: 4 });
});
afterAll(async () => { if (stack) await stack.stop(); });

test('publishing the new version sent nothing, and signing in and the dashboard still work', async () => {
  await new Promise((r) => setTimeout(r, 500));
  expect(emailsSkipped()).toBe(S.emailsBefore);
  const onb = await api('GET', '/api/agreements/onboarding-status', S.indy.token);
  expect(onb.status).toBe(200);
  expect(onb.body.data.dashboard_access).toBe(true);
  const st = await api('GET', '/api/agreements/current-status', S.indy.token);
  expect(st.body.data).toMatchObject({ is_seller: true, ok: false, reason: 'agreement_update_required', current_version: 4, signed_version: 3 });
  // the earlier auction is untouched
  expect((await stack.query('SELECT state FROM auctions WHERE id = $1', [S.indy.oldAuction])).rows[0].state).toBe('submitted');
});

test('submitting a NEW auction waits for the current agreement; the draft is kept', async () => {
  S.indy.draft = (await stack.query(`INSERT INTO auctions (seller_id, title, state, city, address_state, zip, street_address, end_time)
    VALUES ($1, 'New Auction', 'draft', 'Houston', 'TX', '77002', '2 New St', now() + interval '7 days') RETURNING id`, [S.indy.profileId])).rows[0].id;
  const r = await api('POST', '/api/auctions/' + S.indy.draft + '/submit', S.indy.token);
  expect(r.status).toBe(409);
  expect(r.body).toMatchObject({ code: 'AGREEMENT_REQUIRED', agreement_reason: 'agreement_update_required' });
  expect(r.body.message).toMatch(/review and accept the current Seller Agreement/);
  expect((await stack.query('SELECT state FROM auctions WHERE id = $1', [S.indy.draft])).rows[0].state).toBe('draft');
});

test('a storefront item can be drafted, but a NEW item cannot go live until the current agreement is accepted', async () => {
  const draft = await api('POST', '/api/seller-storefront/items', S.esme.token, { title: 'Walnut Sideboard', price_cents: 45000, quantity: 1, status: 'draft' });
  expect(draft.status).toBe(201);
  S.esme.itemId = draft.body.data.id;
  const live = await api('PATCH', '/api/seller-storefront/items/' + S.esme.itemId, S.esme.token, { status: 'active' });
  expect(live.status).toBe(409);
  expect(live.body).toMatchObject({ code: 'AGREEMENT_REQUIRED' });
  expect((await stack.query('SELECT status FROM marketplace_items WHERE id = $1', [S.esme.itemId])).rows[0].status).toBe('draft');
  const direct = await api('POST', '/api/seller-storefront/items', S.esme.token, { title: 'Brass Lamp', price_cents: 9000, quantity: 1, status: 'active' });
  expect(direct.status).toBe(409);
});

test('"Review and Accept" issues the current version in the app with no email; earlier signatures are unchanged', async () => {
  const before = emailsSkipped();
  const r = await api('POST', '/api/agreements/current/issue', S.indy.token);
  expect(r.status).toBe(200);
  expect(r.body.data).toMatchObject({ status: 'issued' });
  S.indy.current = r.body.data.agreement_id;
  const again = await api('POST', '/api/agreements/current/issue', S.indy.token);
  expect(again.body.data).toMatchObject({ status: 'exists', agreement_id: S.indy.current });   // never a second copy
  await new Promise((res) => setTimeout(res, 500));
  expect(emailsSkipped()).toBe(before);
  const row = (await stack.query(`SELECT a.status, v.version_int FROM agreements a JOIN agreement_template_versions v ON v.id = a.template_version_id WHERE a.id = $1`, [S.indy.current])).rows[0];
  expect(row.version_int).toBe(4);
  expect((await stack.query('SELECT status, signed_at IS NOT NULL AS signed FROM agreements WHERE id = $1', [S.indy.signedV3])).rows[0]).toEqual({ status: 'signed', signed: true });
  expect((await stack.query(`SELECT count(*)::int n FROM audit_log WHERE event_type = 'seller_agreement_issued_in_app' AND entity_id = $1`, [S.indy.current])).rows[0].n).toBe(1);
});

test('once the current version is signed, the new listing proceeds and the seller is not asked again', async () => {
  // signing (the signing page records the signature; the record is what the gate reads)
  await stack.query(`UPDATE agreements SET status = 'signed', signed_at = now() WHERE id = $1`, [S.indy.current]);
  const st = await api('GET', '/api/agreements/current-status', S.indy.token);
  expect(st.body.data).toMatchObject({ ok: true, reason: 'signed_current' });
  // The agreement no longer stops it: the submission reaches the auction's own content checks (this test auction has no
  // lots, so the minimum-lot rule answers), which come after the agreement check.
  const r = await api('POST', '/api/auctions/' + S.indy.draft + '/submit', S.indy.token);
  expect(r.body.code).not.toBe('AGREEMENT_REQUIRED');
  expect([r.status, r.body.code]).toEqual([422, 'MINIMUM_LOTS_NOT_MET']);
  // the Professional Seller signs too; the drafted item goes live
  const issued = await api('POST', '/api/agreements/current/issue', S.esme.token);
  await stack.query(`UPDATE agreements SET status = 'signed', signed_at = now() WHERE id = $1`, [issued.body.data.agreement_id]);
  const live = await api('PATCH', '/api/seller-storefront/items/' + S.esme.itemId, S.esme.token, { status: 'active' });
  expect(live.status).toBe(200);
  // pausing and re-publishing an existing listing is managing it, not a new listing: allowed for that version, never re-asked
  expect((await api('PATCH', '/api/seller-storefront/items/' + S.esme.itemId, S.esme.token, { status: 'paused' })).status).toBe(200);
  expect((await api('PATCH', '/api/seller-storefront/items/' + S.esme.itemId, S.esme.token, { status: 'active' })).status).toBe(200);
});
