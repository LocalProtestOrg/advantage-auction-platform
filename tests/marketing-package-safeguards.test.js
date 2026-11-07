'use strict';

/**
 * Seller advertising package checkout safeguards, the dedicated email setting name, and commercial email footers
 * (owner-authorized baseline corrections 2026-11-06).
 *
 * Real Postgres (PGlite) with the REAL launch package catalogue (migration 140's version rows) and the real purchase
 * service, deliverability rules, email templates and send gates. Stripe and the mail transport are stand-ins: no
 * checkout session is created at Stripe and no email is sent.
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}
function mockAdapter() {
  const query = async (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    const r = await global.__PG.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null && !/^\s*select/i.test(sql) ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}
jest.mock('../src/db', () => mockAdapter());
jest.mock('../src/db/index', () => mockAdapter());
const mockSessionCreate = jest.fn(async () => ({ id: 'cs_test_' + Math.random().toString(36).slice(2), url: 'https://checkout.example/session' }));
jest.mock('stripe', () => jest.fn(() => ({ checkout: { sessions: { create: (...a) => mockSessionCreate(...a) } } })));
jest.mock('../src/services/cardService', () => ({ ensureStripeCustomer: jest.fn(async () => 'cus_test_placeholder') }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'mail-1' })), isConfigured: () => true }));

const purchases = require('../src/services/marketingPackagePurchaseService');
const mail = require('../src/services/emailService');

jest.setTimeout(60000);
let pg; let SELLER_A; let SELLER_B; let ADMIN; let AUCTION_A; let AUCTION_B;
const q = async (sql, params) => (await pg.query(sql, params)).rows;
const ADDRESS = '2205 Ogden Hwy, Adrian, MI 49221';

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = 'test-placeholder-not-a-key';
  pg = startPg(); global.__PG = pg;
  await pg.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT, role TEXT, is_active BOOLEAN DEFAULT true);
    CREATE TABLE platform_config (key TEXT PRIMARY KEY, value JSONB NOT NULL, category TEXT NOT NULL DEFAULT 'general', description TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE seller_profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID);
    CREATE TABLE auctions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), seller_id UUID);
    CREATE TABLE audit_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_type TEXT, entity_type TEXT, entity_id UUID, auction_id UUID, lot_id UUID, payment_id UUID, actor_id UUID, metadata JSONB, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE marketing_package_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), package_key TEXT, version INT, effective_from TIMESTAMPTZ NOT NULL DEFAULT now() - interval '1 hour',
      effective_to TIMESTAMPTZ, is_active BOOLEAN NOT NULL DEFAULT true, seller_name TEXT, seller_description TEXT, seller_benefits JSONB, guaranteed_deliverables JSONB,
      discretionary_tools JSONB, price_cents INT, economic_policy_version TEXT, capacity_ref JSONB, created_by UUID, UNIQUE (package_key, version));
    CREATE TABLE marketing_package_purchases (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), seller_user_id UUID, auction_id UUID, package_key TEXT, package_version INT,
      amount_paid_cents INT, seller_copy JSONB, guaranteed_deliverables JSONB, discretionary_tools JSONB, economic_policy_version TEXT, direct_fulfillment_bps INT,
      internal_authority_cents INT, status TEXT, stripe_checkout_session_id TEXT UNIQUE, stripe_payment_intent_id TEXT, purchased_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE marketing_additional_promotions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), promotion_key TEXT, seller_user_id UUID, auction_id UUID, package_purchase_id UUID,
      amount_paid_cents INT, benefits JSONB, economic_policy_version TEXT, direct_fulfillment_bps INT, internal_authority_cents INT, status TEXT,
      stripe_checkout_session_id TEXT UNIQUE, stripe_payment_intent_id TEXT, purchased_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE marketing_production_creative (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE marketing_paid_campaigns (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), campaign_key TEXT UNIQUE);
    CREATE TABLE marketing_test_sends (campaign_class TEXT, event_kind TEXT, event_ref TEXT, subject TEXT, to_addresses TEXT[], sent_by UUID, provider_result JSONB);`);
  // The REAL launch catalogue rows, exactly as migration 140 seeds them.
  const m140 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '140_marketing_package_platform.sql'), 'utf8');
  const start = m140.indexOf('INSERT INTO marketing_package_versions');
  await pg.exec(m140.slice(start, m140.indexOf('ON CONFLICT (package_key, version) DO NOTHING;', start)) + ';');
  const mkSeller = async (email) => {
    const u = (await q(`INSERT INTO users (email, role) VALUES ($1, 'seller') RETURNING id, role`, [email]))[0];
    const sp = (await q(`INSERT INTO seller_profiles (user_id) VALUES ($1) RETURNING id`, [u.id]))[0];
    const a = (await q(`INSERT INTO auctions (seller_id) VALUES ($1) RETURNING id`, [sp.id]))[0];
    return { user: u, auctionId: a.id };
  };
  const a = await mkSeller('a@seller.test'); const b = await mkSeller('b@seller.test');
  SELLER_A = a.user; AUCTION_A = a.auctionId; SELLER_B = b.user; AUCTION_B = b.auctionId;
  ADMIN = (await q(`INSERT INTO users (email, role) VALUES ('admin@x.test', 'admin') RETURNING id, role`))[0];
  await q(`INSERT INTO platform_config (key, value) VALUES ('marketing.pkg.addl.boost.price_cents', '4900'), ('marketing.pkg.addl.reach.price_cents', '9900'),
           ('marketing.pkg.addl.spotlight.price_cents', '19900')`);
});
afterAll(async () => { if (pg) await pg.close(); delete process.env.STRIPE_SECRET_KEY; });
beforeEach(() => { mockSessionCreate.mockClear(); mail.sendEmail.mockClear(); });

describe('catalogue deliverability (decided from the catalogue data)', () => {
  const version = async (k) => require('../src/services/packageRegistryService').activeVersion(k);
  test('Featured has no paid component and can be bought', async () => {
    expect(purchases.packageDeliverability(await version('featured'))).toMatchObject({ purchasable: true });
  });
  test('Premium and Signature include paid advertising (discretionary) and cannot be bought until paid fulfillment works', async () => {
    const p = purchases.packageDeliverability(await version('premium'));
    expect(p).toMatchObject({ purchasable: false, blocked: ['Paid local boost when appropriate'] });
    const s = purchases.packageDeliverability(await version('signature'));
    expect(s.purchasable).toBe(false);
    expect(s.blocked).toEqual(expect.arrayContaining(['Paid local/regional/national', 'Lot-level paid promotion']));
  });
  test('BOOST is deliverable; REACH, SPOTLIGHT (paid promotion) and CUSTOM (no online composition) are not', () => {
    expect(purchases.promotionDeliverability('boost').purchasable).toBe(true);
    expect(purchases.promotionDeliverability('reach')).toMatchObject({ purchasable: false, blocked: ['paid_local_promotion'] });
    expect(purchases.promotionDeliverability('spotlight').blocked).toEqual(['paid_local_promotion', 'lot_level_promotion']);
    expect(purchases.promotionDeliverability('custom')).toMatchObject({ purchasable: false, reason: expect.stringMatching(/arranged with Advantage\.Bid/) });
  });
  test('a new package version without paid components becomes purchasable with no code change', () => {
    expect(purchases.packageDeliverability({ guaranteed_deliverables: [{ key: 'homepage_module', channel: 'homepage' }], discretionary_tools: [{ key: 'organic_facebook', channel: 'social' }] }).purchasable).toBe(true);
  });
});

describe('package checkout', () => {
  test('a seller can buy Featured for their own auction', async () => {
    const out = await purchases.createPackageCheckout(SELLER_A.id, { packageKey: 'featured', auctionId: AUCTION_A, actor: SELLER_A });
    expect(out.url).toBe('https://checkout.example/session');
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    expect((await q(`SELECT auction_id, seller_user_id, status FROM marketing_package_purchases WHERE stripe_checkout_session_id = $1`, [out.id]))[0])
      .toMatchObject({ auction_id: AUCTION_A, seller_user_id: SELLER_A.id, status: 'pending' });
  });
  test('a seller cannot buy for another seller\'s auction (no checkout is created)', async () => {
    await expect(purchases.createPackageCheckout(SELLER_A.id, { packageKey: 'featured', auctionId: AUCTION_B, actor: SELLER_A }))
      .rejects.toMatchObject({ status: 403, code: 'NOT_YOUR_AUCTION' });
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
  test('a seller must name the auction; an unknown auction is not found', async () => {
    await expect(purchases.createPackageCheckout(SELLER_A.id, { packageKey: 'featured', actor: SELLER_A })).rejects.toMatchObject({ status: 400, code: 'AUCTION_REQUIRED' });
    await expect(purchases.createPackageCheckout(SELLER_A.id, { packageKey: 'featured', auctionId: '00000000-0000-4000-8000-00000000dead', actor: SELLER_A }))
      .rejects.toMatchObject({ status: 404 });
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
  test('an admin may buy for any auction (override), and the override is audited', async () => {
    await purchases.createPackageCheckout(ADMIN.id, { packageKey: 'featured', auctionId: AUCTION_B, actor: ADMIN });
    const audit = await q(`SELECT * FROM audit_log WHERE event_type = 'marketing_package.admin_override_purchase'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: ADMIN.id, auction_id: AUCTION_B, entity_type: 'auction' });
  });
  test('Premium and Signature are refused server-side with a clear message', async () => {
    for (const k of ['premium', 'signature']) {
      await expect(purchases.createPackageCheckout(SELLER_A.id, { packageKey: k, auctionId: AUCTION_A, actor: SELLER_A }))
        .rejects.toMatchObject({ status: 409, code: 'NOT_AVAILABLE', message: expect.stringMatching(/paid advertising, which is not available yet/) });
    }
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
});

describe('additional promotion checkout', () => {
  test('BOOST uses the admin-configured price; a buyer-entered amount is ignored', async () => {
    const out = await purchases.createAdditionalPromotionCheckout(SELLER_A.id, { promotionKey: 'boost', auctionId: AUCTION_A, customAmountCents: 1, actor: SELLER_A });
    expect(mockSessionCreate.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(4900);
    expect((await q(`SELECT amount_paid_cents FROM marketing_additional_promotions WHERE stripe_checkout_session_id = $1`, [out.id]))[0].amount_paid_cents).toBe(4900);
  });
  test('CUSTOM with any amount is refused; REACH and SPOTLIGHT are refused', async () => {
    for (const k of ['custom', 'reach', 'spotlight']) {
      await expect(purchases.createAdditionalPromotionCheckout(SELLER_A.id, { promotionKey: k, auctionId: AUCTION_A, customAmountCents: 100000, actor: SELLER_A }))
        .rejects.toMatchObject({ status: 409, code: 'NOT_AVAILABLE' });
    }
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
  test('ownership: another seller\'s auction or package purchase is refused', async () => {
    await expect(purchases.createAdditionalPromotionCheckout(SELLER_A.id, { promotionKey: 'boost', auctionId: AUCTION_B, actor: SELLER_A })).rejects.toMatchObject({ status: 403 });
    const other = (await q(`INSERT INTO marketing_package_purchases (seller_user_id, auction_id, package_key, package_version, amount_paid_cents, status)
                            VALUES ($1, $2, 'featured', 1, 9900, 'paid') RETURNING id`, [SELLER_B.id, AUCTION_B]))[0];
    await expect(purchases.createAdditionalPromotionCheckout(SELLER_A.id, { promotionKey: 'boost', auctionId: AUCTION_A, packagePurchaseId: other.id, actor: SELLER_A }))
      .rejects.toMatchObject({ status: 404 });
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
  test('the seller route no longer forwards a custom amount, and the catalogue reports availability', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'marketingPackages.js'), 'utf8');
    expect(route).not.toMatch(/custom_amount_cents/);
    expect(route).toMatch(/actor: req\.user/);
    expect(route).toMatch(/additional_promotion_availability/);
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'seller', 'marketing.html'), 'utf8');
    expect(page).toMatch(/Not Available Yet/);
    expect(page).not.toMatch(/[–—]/);
  });
});

describe('dedicated email settings use the admin-editable names', () => {
  test('the executor reads exactly the keys the admin Capacity screen edits', async () => {
    const exec = require('../src/services/dedicatedEmailExecutor');
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminMarketingPackages.js'), 'utf8');
    for (const key of Object.values(exec.CONFIG_KEYS)) expect(route).toContain("'" + key + "'");
    expect(fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'dedicatedEmailExecutor.js'), 'utf8')).not.toMatch(/'marketing\.dedicated\./);
    await q(`INSERT INTO platform_config (key, value) VALUES ('marketing.pkg.dedicated_email.audience_floor', '250'), ('marketing.pkg.dedicated_email.global_max_per_day', '5')`);
    expect(await exec.cfg()).toMatchObject({ floor: 250, maxPerDay: 5, maxPerMarketWeek: 2, spacingHours: 48 });
  });
  test('migration 223 copies a value held under a retired name only where the new key is absent', async () => {
    await q(`INSERT INTO platform_config (key, value) VALUES ('marketing.dedicated.audience_floor', '999'), ('marketing.dedicated.spacing_hours', '72')`);
    await pg.exec(`CREATE TABLE IF NOT EXISTS marketing_paid_markets (market_key TEXT PRIMARY KEY);`);
    await pg.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_owner BOOLEAN NOT NULL DEFAULT false;`);
    await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '223_paid_campaign_authorizations.sql'), 'utf8'));
    const v = async (k) => ((await q('SELECT value FROM platform_config WHERE key = $1', [k]))[0] || {}).value;
    expect(await v('marketing.pkg.dedicated_email.audience_floor')).toBe(250);       // existing admin value kept
    expect(await v('marketing.pkg.dedicated_email.overlap_spacing_hours')).toBe(72); // retired value carried over
  });
});

describe('commercial email footers carry the business postal address (fail closed without one)', () => {
  const tmpl = require('../src/services/marketingEmailTemplate');
  const sender = require('../src/services/marketingSendService');
  const commercial = require('../src/lib/commercialEmail');
  const event = { kind: 'estate_sale', title: 'Spring Estate Sale', city: 'Adrian', state: 'MI', date_line: 'May 3', url: 'https://bid.advantage.bid/event.html?id=1' };
  const opts = { unsubscribeUrl: 'https://bid.advantage.bid/api/public/marketing/unsubscribe?t=abc', preferencesUrl: 'https://bid.advantage.bid/account.html' };

  test('the consumer template renders the address in HTML and text; unsubscribe and headers are intact', () => {
    const r = tmpl.buildLocalEventAlert(event, { ...opts, postalAddress: ADDRESS });
    expect(r.html).toContain('Advantage.Bid, ' + ADDRESS);
    expect(r.text).toContain('Advantage.Bid, ' + ADDRESS);
    expect(r.html).toContain('>Unsubscribe</a>');
    expect(r.headers).toEqual({ 'List-Unsubscribe': '<' + opts.unsubscribeUrl + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    const d = tmpl.buildLocalEventDigest([event, event], { ...opts, postalAddress: ADDRESS });
    expect(d.text).toContain(ADDRESS);
  });
  test('without the stored address the test send and the live send refuse', async () => {
    const rendered = tmpl.buildLocalEventAlert(event, opts);
    expect(await sender.testSend({ rendered, toAddresses: ['team@advantage.bid'] })).toMatchObject({ ok: false, reason: 'postal_address_missing' });
    await q(`INSERT INTO platform_config (key, value) VALUES ('marketing.a7_send_enabled', 'true') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    await expect(sender.sendCampaignLive({ campaignId: '00000000-0000-4000-8000-000000000001', rendered })).rejects.toMatchObject({ code: 'POSTAL_ADDRESS_MISSING' });
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
  test('with the stored address a message rendered without it gets it added before it is sent', async () => {
    await q(`INSERT INTO platform_config (key, value) VALUES ('company.postal_address', $1::jsonb)`, [JSON.stringify(ADDRESS)]);
    const rendered = tmpl.buildLocalEventAlert(event, opts);
    const out = await sender.testSend({ rendered, toAddresses: ['team@advantage.bid'] });
    expect(out.ok).toBe(true);
    const sent = mail.sendEmail.mock.calls[0][0];
    expect(sent.html).toContain(ADDRESS);
    expect(sent.html.indexOf(ADDRESS)).toBeLessThan(sent.html.toLowerCase().lastIndexOf('</body>'));
    expect(sent.text).toContain(ADDRESS);
    expect(sent.headers['List-Unsubscribe']).toContain('unsubscribe');
    expect(commercial.withPostalAddress({ html: '<p>x</p>', text: 'x' }, ADDRESS).html).toContain(ADDRESS);
  });
  test('follower announcements carry the address and keep both unsubscribe links', () => {
    const m = require('../src/services/followerEmails').buildFollowerEventEmail({ company_name: 'Harbor', event_title: 'Sale', event_url: 'https://bid.advantage.bid/e' },
      { toAddress: 'f@x.test', unsubscribeUrl: 'https://bid.advantage.bid/api/public/follower-emails/unsubscribe?token=t', postalAddress: ADDRESS });
    expect(m.html).toContain('Advantage.Bid, ' + ADDRESS);
    expect(m.text).toContain('Advantage.Bid, ' + ADDRESS);
    expect(m.html).toMatch(/Unsubscribe from this company's updates/);
    expect(m.html).toMatch(/Stop all follower emails/);
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
  test('the follower worker and the Event Partner invitation refuse without the address; the rep email requires it', () => {
    const worker = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'notificationWorker.js'), 'utf8');
    const block = worker.slice(worker.indexOf("if (row.type === 'FOLLOWER_EVENT')"), worker.indexOf('// ── Non-lot types'));
    expect(block.indexOf('requirePostalAddress')).toBeGreaterThan(-1);
    expect(block.indexOf('requirePostalAddress')).toBeLessThan(block.indexOf('sendEmail('));
    const ep = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'eventPartners', 'outreachSendService.js'), 'utf8');
    expect(ep.indexOf("skipped = 'POSTAL_ADDRESS_MISSING'")).toBeLessThan(ep.indexOf('emailService.sendEmail('));
    expect(ep).toMatch(/withPostalAddress\(render\(tpl/);
  });
});
