'use strict';

/**
 * The Sales Tax administration API (/api/admin/tax, /api/admin/tax-jurisdictions; migration 231) as served by the real
 * app on the isolated full-stack environment (tests/fullstack: every real migration, in-memory database, never
 * production). Real sign-in, real authorization, real audit writes.
 *
 * Covers: unauthenticated 401 and non-administrator 403 on every endpoint; the retired "seller" rule is refused; a rule
 * under which Advantage.Bid collects needs a recorded ACTIVE registration; rule source fields, verification and history;
 * the two safeguard settings are owner-only; turning enforcement on is refused, with the list, while a published auction
 * sits in a state without a usable rule, unless acknowledged; registrations, filings and payments; tax codes; nexus
 * thresholds; exceptions (written reason); alerts; the reserve transfer and ledger corrections; CSV downloads; every
 * write is audited with before and after.
 */

const { startStack } = require('./fullstack/stack');
const seed = require('./fullstack/seed');

jest.setTimeout(60000);

let stack;
const T = {}; const ID = {};
const q = async (sql, p) => (await stack.query(sql, p)).rows;

async function call(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = 'Bearer ' + T[who];
  const r = await fetch(stack.baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, body: json, text, headers: r.headers };
}
const audits = async (event) => q('SELECT actor_id, metadata FROM audit_log WHERE event_type = $1 ORDER BY created_at', [event]);

const READS = ['/api/admin/tax/overview', '/api/admin/tax/ledger', '/api/admin/tax/ledger.csv', '/api/admin/tax/state-summary.csv',
  '/api/admin/tax/filing-export.csv?state=TX&from=2026-10-01&to=2026-10-31', '/api/admin/tax/auction-audit', '/api/admin/tax/registrations', '/api/admin/tax/filings',
  '/api/admin/tax/category-codes', '/api/admin/tax/nexus/thresholds', '/api/admin/tax/nexus/status', '/api/admin/tax/exceptions', '/api/admin/tax/alerts',
  '/api/admin/tax/reconciliation', '/api/admin/tax/reserve', '/api/admin/tax/settings', '/api/admin/tax/seller-reporting', '/api/admin/tax/seller-reporting.csv',
  '/api/admin/tax-jurisdictions', '/api/admin/tax-jurisdictions/TX/history'];
const WRITES = [['POST', '/api/admin/tax/registrations'], ['PUT', '/api/admin/tax/registrations/00000000-0000-4000-8000-000000000000'], ['POST', '/api/admin/tax/filings'],
  ['POST', '/api/admin/tax/filings/ensure-current'], ['PUT', '/api/admin/tax/filings/00000000-0000-4000-8000-000000000000'],
  ['POST', '/api/admin/tax/filings/00000000-0000-4000-8000-000000000000/payment'], ['PUT', '/api/admin/tax/category-codes/furniture'],
  ['DELETE', '/api/admin/tax/category-codes/furniture'], ['PUT', '/api/admin/tax/nexus/thresholds/TX'], ['DELETE', '/api/admin/tax/nexus/thresholds/TX'],
  ['POST', '/api/admin/tax/exceptions'], ['POST', '/api/admin/tax/exceptions/00000000-0000-4000-8000-000000000000/revoke'], ['POST', '/api/admin/tax/alerts/1/resolve'],
  ['POST', '/api/admin/tax/reconciliation/run'], ['POST', '/api/admin/tax/reserve/transfers'], ['POST', '/api/admin/tax/adjustments'], ['PUT', '/api/admin/tax/settings'],
  ['PUT', '/api/admin/tax-jurisdictions/TX'], ['POST', '/api/admin/tax-jurisdictions/TX/verify'], ['DELETE', '/api/admin/tax-jurisdictions/TX']];

beforeAll(async () => {
  stack = await startStack();
  ID.admin = await seed.user(stack, { email: 'taxapi-admin@fullstack.test', role: 'admin', fullName: 'Ada Admin' });
  ID.owner = await seed.user(stack, { email: 'taxapi-owner@fullstack.test', role: 'admin', fullName: 'Owen Owner' });
  await stack.query('UPDATE users SET is_platform_owner = true WHERE id = $1', [ID.owner]);
  ID.sellerUser = await seed.user(stack, { email: 'taxapi-seller@fullstack.test', role: 'seller', fullName: 'Sam Seller' });
  ID.seller = await seed.sellerProfile(stack, { userId: ID.sellerUser, sellerType: 'auction_house', displayName: 'Gamma Auctions' });
  ID.buyer = await seed.user(stack, { email: 'taxapi-buyer@fullstack.test', role: 'buyer', fullName: 'Bea Buyer' });
  for (const [k, email] of [['admin', 'taxapi-admin@fullstack.test'], ['owner', 'taxapi-owner@fullstack.test'], ['seller', 'taxapi-seller@fullstack.test'], ['buyer', 'taxapi-buyer@fullstack.test']]) {
    T[k] = await seed.apiLogin(stack, email);
  }
  ID.auction = (await q(`INSERT INTO auctions (seller_id, title, state, address_state, start_time, end_time)
    VALUES ($1, 'Published Texas auction', 'published', 'TX', now(), now() + interval '5 days') RETURNING id`, [ID.seller]))[0].id;
}, 240000);
afterAll(async () => { if (stack) await stack.stop(); }, 30000);

describe('authorization', () => {
  test('no session: 401 on every read and write', async () => {
    for (const p of READS) expect([p, (await call(null, 'GET', p)).status]).toEqual([p, 401]);
    for (const [m, p] of WRITES) expect([m, p, (await call(null, m, p, {})).status]).toEqual([m, p, 401]);
  });
  test('a seller and a buyer: 403 on every read and write, and no data', async () => {
    for (const who of ['seller', 'buyer']) {
      for (const p of READS) { const r = await call(who, 'GET', p); expect([who, p, r.status]).toEqual([who, p, 403]); expect(r.text).not.toMatch(/"data"/); }
      for (const [m, p] of WRITES) expect([who, m, p, (await call(who, m, p, { state: 'TX', remitter: 'seller_direct', legal_basis: 'Not an administrator' })).status]).toEqual([who, m, p, 403]);
    }
    expect(await q('SELECT count(*)::int AS n FROM marketplace_tax_jurisdictions')).toEqual([{ n: 0 }]);
    expect(await q('SELECT count(*)::int AS n FROM tax_registrations')).toEqual([{ n: 0 }]);
  });
  test('an administrator can read; responses are never cached', async () => {
    const r = await call('admin', 'GET', '/api/admin/tax/overview');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body.data).toMatchObject({ enforcement: 'report', reserve_guard: true, states: [] });
  });
});

describe('sales tax rules', () => {
  const basis = { legal_basis: 'TEST ONLY: advice recorded for this suite' };
  test('the retired "seller" option is refused for a new rule', async () => {
    const r = await call('admin', 'PUT', '/api/admin/tax-jurisdictions/TX', { remitter: 'seller', ...basis });
    expect([r.status, r.body.code]).toEqual([422, 'REMITTER_RETIRED']);
    expect(r.body.message).toMatch(/retired/);
    expect((await call('admin', 'PUT', '/api/admin/tax-jurisdictions/TX', { remitter: 'none', ...basis })).body.code).toBe('REMITTER_INVALID');
    expect(await q('SELECT count(*)::int AS n FROM marketplace_tax_jurisdictions')).toEqual([{ n: 0 }]);
  });
  test('a "platform" rule needs a recorded ACTIVE registration for the state', async () => {
    let r = await call('admin', 'PUT', '/api/admin/tax-jurisdictions/TX', { remitter: 'platform', ...basis });
    expect([r.status, r.body.code]).toEqual([409, 'REGISTRATION_REQUIRED']);
    expect(r.body.message).toMatch(/Record the active sales tax registration for TX first/);
    // A pending registration is not enough.
    const reg = await call('admin', 'POST', '/api/admin/tax/registrations', { state: 'TX', status: 'pending', filing_frequency: 'monthly', registration_last4: '4321' });
    expect(reg.status).toBe(200);
    ID.regTX = reg.body.data.id;
    expect((await call('admin', 'PUT', '/api/admin/tax-jurisdictions/TX', { remitter: 'platform', ...basis })).body.code).toBe('REGISTRATION_REQUIRED');
    // A registration that starts in the future is not active yet.
    await call('admin', 'PUT', '/api/admin/tax/registrations/' + ID.regTX, { status: 'active', effective_from: '2999-01-01' });
    expect((await call('admin', 'PUT', '/api/admin/tax-jurisdictions/TX', { remitter: 'platform', ...basis })).body.code).toBe('REGISTRATION_REQUIRED');
    await call('admin', 'PUT', '/api/admin/tax/registrations/' + ID.regTX, { effective_from: '2026-01-01' });
    r = await call('admin', 'PUT', '/api/admin/tax-jurisdictions/tx', { remitter: 'platform', ...basis, source_reference: 'TEST statute 151.0242', local_jurisdiction: 'Houston MTA', notes: 'n' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ state: 'TX', remitter: 'platform', source_reference: 'TEST statute 151.0242', local_jurisdiction: 'Houston MTA', last_verified_at: null, updated_by: ID.admin });
  });
  test('a "seller_direct" rule needs no registration; a changed rule cannot become "seller"', async () => {
    const r = await call('admin', 'PUT', '/api/admin/tax-jurisdictions/OH', { remitter: 'seller_direct', ...basis });
    expect(r.body.data).toMatchObject({ state: 'OH', remitter: 'seller_direct' });
    expect((await call('admin', 'PUT', '/api/admin/tax-jurisdictions/OH', { remitter: 'seller', ...basis })).body.code).toBe('REMITTER_RETIRED');
    expect((await q(`SELECT remitter FROM marketplace_tax_jurisdictions WHERE state = 'OH'`))[0].remitter).toBe('seller_direct');
  });
  test('a historical "seller" rule is still shown, marked retired, and can only be replaced', async () => {
    await q(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis, effective_from) VALUES ('NM', 'seller', 'TEST ONLY historical rule', DATE '2020-01-01')`);
    const list = (await call('admin', 'GET', '/api/admin/tax-jurisdictions')).body.data;
    expect(list.remitters).toEqual(['platform', 'seller_direct']);
    expect(list.registered_states).toEqual(['TX']);
    expect(list.rules.map((x) => [x.state, x.remitter, x.retired])).toEqual([['NM', 'seller', true], ['OH', 'seller_direct', false], ['TX', 'platform', false]]);
    expect(list.rules.find((x) => x.state === 'TX')).toMatchObject({ effective_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), source_reference: 'TEST statute 151.0242' });
  });
  test('verify stamps the date and the administrator; history keeps every change', async () => {
    expect((await call('admin', 'POST', '/api/admin/tax-jurisdictions/WY/verify')).status).toBe(404);
    const v = await call('admin', 'POST', '/api/admin/tax-jurisdictions/TX/verify');
    expect(v.body.data).toMatchObject({ state: 'TX', last_verified_by: ID.admin, last_verified_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    await call('admin', 'PUT', '/api/admin/tax-jurisdictions/OH', { remitter: 'seller_direct', legal_basis: 'TEST ONLY: second advice letter' });
    expect((await call('admin', 'DELETE', '/api/admin/tax-jurisdictions/OH')).body.data.removed).toBe(true);
    expect((await call('admin', 'DELETE', '/api/admin/tax-jurisdictions/OH')).body.data.removed).toBe(false);
    const tx = (await call('admin', 'GET', '/api/admin/tax-jurisdictions/TX/history')).body.data;
    expect(tx.map((h) => h.action)).toEqual(['verified', 'set']);
    expect(tx[1]).toMatchObject({ before_value: null, actor_name: 'Ada Admin' });
    expect(tx[1].after_value).toMatchObject({ remitter: 'platform', source_reference: 'TEST statute 151.0242' });
    const oh = (await call('admin', 'GET', '/api/admin/tax-jurisdictions/OH/history')).body.data;
    expect(oh.map((h) => h.action)).toEqual(['removed', 'set', 'set']);
    expect(oh[0]).toMatchObject({ after_value: null });
    expect(oh[0].before_value).toMatchObject({ legal_basis: 'TEST ONLY: second advice letter' });
    expect(oh[1].before_value).toMatchObject({ legal_basis: basis.legal_basis });
    expect((await audits('tax_jurisdiction_rule_set')).length).toBe(3);
    expect((await audits('tax_jurisdiction_rule_verified'))[0]).toMatchObject({ actor_id: ID.admin });
    expect((await audits('tax_jurisdiction_rule_removed'))[0].metadata).toMatchObject({ state: 'OH' });
  });
});

describe('safeguard settings (platform owner only)', () => {
  const mode = async () => (await q(`SELECT value FROM platform_config WHERE key = 'tax.auction_enforcement'`))[0].value;
  test('an administrator who is not the owner cannot change either setting', async () => {
    expect((await call('admin', 'GET', '/api/admin/tax/settings')).body.data).toEqual({ auction_enforcement: 'report', reserve_guard: true, is_owner: false });
    for (const body of [{ auction_enforcement: 'enforce', acknowledge_unconfigured: true }, { reserve_guard: false }, { auction_enforcement: 'report' }]) {
      const r = await call('admin', 'PUT', '/api/admin/tax/settings', body);
      expect([r.status, r.body.code]).toEqual([403, 'PLATFORM_OWNER_REQUIRED']);
      expect(r.body.data).toBeUndefined();   // not even the audit list
    }
    expect(await mode()).toBe('report');
    expect((await q(`SELECT value FROM platform_config WHERE key = 'tax.reserve_guard'`))[0].value).toBe(true);
  });
  test('input is validated', async () => {
    expect((await call('owner', 'PUT', '/api/admin/tax/settings', {})).body.code).toBe('NOTHING_TO_CHANGE');
    expect((await call('owner', 'PUT', '/api/admin/tax/settings', { auction_enforcement: 'on' })).body.code).toBe('MODE_INVALID');
    expect((await call('owner', 'PUT', '/api/admin/tax/settings', { reserve_guard: 'no' })).body.code).toBe('GUARD_INVALID');
  });
  test('turning enforcement on is refused, with the list, while a published auction is in a state without a usable rule', async () => {
    // Texas has a usable rule now; move the published auction to Georgia, which has none.
    await q(`UPDATE auctions SET address_state = 'GA' WHERE id = $1`, [ID.auction]);
    const audit = (await call('owner', 'GET', '/api/admin/tax/auction-audit')).body.data;
    expect(audit.blocking.map((a) => [a.id, a.pickup_state])).toEqual([[ID.auction, 'GA']]);
    const r = await call('owner', 'PUT', '/api/admin/tax/settings', { auction_enforcement: 'enforce' });
    expect([r.status, r.body.success, r.body.code]).toEqual([409, false, 'UNCONFIGURED_AUCTIONS']);
    expect(r.body.data.blocking).toEqual([expect.objectContaining({ id: ID.auction, title: 'Published Texas auction', pickup_state: 'GA', rule_usable: false })]);
    expect(r.body.data.states_without_rule).toEqual(['GA']);
    expect(await mode()).toBe('report');
    // acknowledge_unconfigured must be exactly true.
    expect((await call('owner', 'PUT', '/api/admin/tax/settings', { auction_enforcement: 'enforce', acknowledge_unconfigured: 'yes' })).status).toBe(409);
    expect(await mode()).toBe('report');
  });
  test('the owner can turn it on by acknowledging the list, or once every live auction has a rule; every change is audited', async () => {
    const ack = await call('owner', 'PUT', '/api/admin/tax/settings', { auction_enforcement: 'enforce', acknowledge_unconfigured: true });
    expect([ack.status, ack.body.data]).toEqual([200, { auction_enforcement: 'enforce', reserve_guard: true }]);
    expect(await mode()).toBe('enforce');
    expect((await call('owner', 'GET', '/api/admin/tax/settings')).body.data).toEqual({ auction_enforcement: 'enforce', reserve_guard: true, is_owner: true });
    expect((await call('owner', 'PUT', '/api/admin/tax/settings', { auction_enforcement: 'report' })).body.data.auction_enforcement).toBe('report');
    // With the rule in place there is nothing to acknowledge.
    await call('admin', 'PUT', '/api/admin/tax-jurisdictions/GA', { remitter: 'seller_direct', legal_basis: 'TEST ONLY: advice recorded for this suite' });
    expect((await call('owner', 'PUT', '/api/admin/tax/settings', { auction_enforcement: 'enforce' })).status).toBe(200);
    expect((await call('owner', 'PUT', '/api/admin/tax/settings', { auction_enforcement: 'report', reserve_guard: false })).body.data).toEqual({ auction_enforcement: 'report', reserve_guard: false });
    expect((await call('owner', 'PUT', '/api/admin/tax/settings', { reserve_guard: true })).body.data.reserve_guard).toBe(true);
    const log = await audits('tax_settings_changed');
    expect(log).toHaveLength(5);
    expect(log[0]).toMatchObject({ actor_id: ID.owner, metadata: { before: { auction_enforcement: 'report' }, after: { auction_enforcement: 'enforce' }, acknowledged_unconfigured: true } });
    const settingAudit = await q(`SELECT config_key, sensitive, actor_user_id FROM platform_setting_audit WHERE config_key LIKE 'tax.%' ORDER BY id`);
    expect(settingAudit.length).toBeGreaterThanOrEqual(6);
    expect(settingAudit.every((a) => a.sensitive === true && a.actor_user_id === ID.owner)).toBe(true);
  });
});

describe('registrations, filings and payments', () => {
  test('registrations: validated, one open per state, last four characters only, audited', async () => {
    expect((await call('admin', 'POST', '/api/admin/tax/registrations', { state: 'FL', registration_last4: '123456789' })).body.code).toBe('LAST4_INVALID');
    expect((await call('admin', 'POST', '/api/admin/tax/registrations', { state: 'TX' })).status).toBe(409);
    const list = (await call('admin', 'GET', '/api/admin/tax/registrations')).body.data;
    expect(list.states).toContain('TX');
    expect(list.registrations).toEqual([expect.objectContaining({ state: 'TX', status: 'active', registration_last4: '4321', effective_from: '2026-01-01', filing_frequency: 'monthly' })]);
    expect(list.registrations.every((x) => !x.registration_last4 || x.registration_last4.length <= 4)).toBe(true);   // never a full registration number
    expect(Object.keys(list.registrations[0]).filter((k) => /number|ein|tin/i.test(k))).toEqual([]);
    const a = await audits('tax_registration_updated');
    expect(a[0].metadata.before).toMatchObject({ status: 'pending' });
    expect(a[0].metadata.after).toMatchObject({ status: 'active' });
    expect((await audits('tax_registration_recorded'))[0]).toMatchObject({ actor_id: ID.admin });
  });
  test('filings: create, update, record a payment (posted to the ledger), audited', async () => {
    expect((await call('admin', 'POST', '/api/admin/tax/filings', { state: 'TX', period_start: '2026-10-01' })).body.code).toBe('PERIOD_REQUIRED');
    const c = await call('admin', 'POST', '/api/admin/tax/filings', { state: 'TX', period_start: '2026-10-01', period_end: '2026-10-31', due_date: '2026-11-20' });
    expect(c.body.data).toMatchObject({ state: 'TX', status: 'open', due_date: '2026-11-20' });
    ID.filing = c.body.data.id;
    expect((await call('admin', 'PUT', '/api/admin/tax/filings/' + ID.filing, { status: 'paid' })).body.code).toBe('RECORD_PAYMENT');
    const u = await call('admin', 'PUT', '/api/admin/tax/filings/' + ID.filing, { status: 'filed', filed_at: '2026-11-12', filed_by_method: 'accountant', confirmation_number: 'CONF-9', tax_due_cents: 500 });
    expect(u.body.data).toMatchObject({ status: 'filed', tax_due_cents: 500, confirmation_number: 'CONF-9' });
    expect((await call('admin', 'POST', '/api/admin/tax/filings/' + ID.filing + '/payment', { amount_cents: 500 })).body.code).toBe('REFERENCE_REQUIRED');
    const p = await call('admin', 'POST', '/api/admin/tax/filings/' + ID.filing + '/payment', { amount_cents: 500, paid_on: '2026-11-13', reference: 'ACH-777' });
    expect(p.body.data).toMatchObject({ status: 'paid' });
    expect((await call('admin', 'POST', '/api/admin/tax/filings/' + ID.filing + '/payment', { amount_cents: 500, paid_on: '2026-11-13', reference: 'ACH-777' })).status).toBe(409);
    expect((await call('admin', 'GET', '/api/admin/tax/filings?state=TX')).body.data).toEqual([expect.objectContaining({ id: ID.filing, status: 'paid' })]);
    const led = (await call('admin', 'GET', '/api/admin/tax/ledger?entry_type=remittance')).body.data;
    expect(led.rows).toEqual([expect.objectContaining({ state: 'TX', tax_remitted_cents: 500, filing_id: ID.filing })]);
    expect((await audits('tax_filing_payment_recorded'))[0].metadata).toMatchObject({ before: { status: 'filed' }, after: { status: 'paid' }, ledger_entry: { tax_remitted_cents: 500 } });
    expect((await call('admin', 'POST', '/api/admin/tax/filings/ensure-current')).body.data).toHaveProperty('created');
  });
});

describe('tax codes and nexus thresholds', () => {
  test('category mappings: nothing is seeded; a mapping needs a valid code and a source', async () => {
    const before = (await call('admin', 'GET', '/api/admin/tax/category-codes')).body.data;
    expect(before.mappings).toEqual([]);
    expect(before.categories).toContainEqual({ key: 'furniture', label: 'Furniture' });
    expect(before.categories.length).toBeGreaterThan(10);
    expect((await call('admin', 'PUT', '/api/admin/tax/category-codes/not_a_category', { tax_code: 'txcd_99999999', source_reference: 'TEST source' })).body.code).toBe('CATEGORY_INVALID');
    expect((await call('admin', 'PUT', '/api/admin/tax/category-codes/clothing', { tax_code: 'clothing', source_reference: 'TEST source' })).body.code).toBe('TAX_CODE_INVALID');
    expect((await call('admin', 'PUT', '/api/admin/tax/category-codes/clothing', { tax_code: 'txcd_30011000' })).body.code).toBe('SOURCE_REQUIRED');
    const ok = await call('admin', 'PUT', '/api/admin/tax/category-codes/clothing', { tax_code: 'txcd_30011000', source_reference: 'TEST ONLY: accountant memo' });
    expect(ok.body.data).toMatchObject({ category_key: 'clothing', tax_code: 'txcd_30011000' });
    expect((await call('admin', 'GET', '/api/admin/tax/category-codes')).body.data.mappings).toHaveLength(1);
    expect((await call('admin', 'DELETE', '/api/admin/tax/category-codes/clothing')).body.data.removed).toBe(true);
    expect((await audits('tax_category_code_set'))[0].metadata).toMatchObject({ category_key: 'clothing', before: null });
    expect((await audits('tax_category_code_removed'))).toHaveLength(1);
  });
  test('nexus thresholds: nothing is seeded; the legal reference is required; status reports per state', async () => {
    expect((await call('admin', 'GET', '/api/admin/tax/nexus/thresholds')).body.data.thresholds).toEqual([]);
    expect((await call('admin', 'PUT', '/api/admin/tax/nexus/thresholds/TX', { sales_threshold_cents: 50000000 })).body.code).toBe('LEGAL_REFERENCE_REQUIRED');
    const ok = await call('admin', 'PUT', '/api/admin/tax/nexus/thresholds/tx', { sales_threshold_cents: 50000000, legal_reference: 'TEST ONLY: example rule', measurement_period: 'rolling_12_months' });
    expect(ok.body.data).toMatchObject({ state: 'TX', sales_threshold_cents: 50000000, counts_marketplace_sales: null, measurement_period: 'rolling_12_months' });
    const status = (await call('admin', 'GET', '/api/admin/tax/nexus/status')).body.data;
    expect(status.find((s) => s.state === 'TX')).toMatchObject({ status: 'registered', registered: true });
    expect((await call('admin', 'DELETE', '/api/admin/tax/nexus/thresholds/TX')).body.data.removed).toBe(true);
    expect((await audits('tax_nexus_threshold_set'))[0].metadata.after).toMatchObject({ state: 'TX', legal_reference: 'TEST ONLY: example rule' });
  });
});

describe('exceptions, alerts, reserve and corrections', () => {
  test('an exception needs an auction, a state and a written reason of at least 20 characters', async () => {
    const good = { auction_id: ID.auction, state: 'GA', reason: 'TEST ONLY: owner approved after advice from the accountant' };
    expect((await call('admin', 'POST', '/api/admin/tax/exceptions', { ...good, reason: 'too short' })).body.code).toBe('REASON_REQUIRED');
    expect((await call('admin', 'POST', '/api/admin/tax/exceptions', { ...good, reason: '                    x' })).body.code).toBe('REASON_REQUIRED');
    expect((await call('admin', 'POST', '/api/admin/tax/exceptions', { ...good, auction_id: 'nope' })).body.code).toBe('AUCTION_INVALID');
    expect((await call('admin', 'POST', '/api/admin/tax/exceptions', { ...good, state: 'ZZ' })).body.code).toBe('STATE_INVALID');
    expect((await call('admin', 'POST', '/api/admin/tax/exceptions', { ...good, auction_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    const ok = await call('admin', 'POST', '/api/admin/tax/exceptions', good);
    expect(ok.body.data).toMatchObject({ auction_id: ID.auction, state: 'GA', decision: 'proceed_tax_not_collected', approved_by: ID.admin, revoked_at: null });
    expect((await call('admin', 'POST', '/api/admin/tax/exceptions', good)).status).toBe(409);
    expect((await call('admin', 'GET', '/api/admin/tax/exceptions')).body.data).toEqual([expect.objectContaining({ auction_title: 'Published Texas auction', state: 'GA' })]);
    const rev = await call('admin', 'POST', '/api/admin/tax/exceptions/' + ok.body.data.id + '/revoke');
    expect(rev.body.data).toMatchObject({ revoked_by: ID.admin });
    expect((await call('admin', 'POST', '/api/admin/tax/exceptions/' + ok.body.data.id + '/revoke')).status).toBe(409);
    expect((await audits('tax_payment_exception_recorded'))).toHaveLength(1);
    expect((await audits('tax_payment_exception_revoked'))[0].metadata.before).toMatchObject({ revoked_at: null });
  });
  test('alerts: listed open and resolved; resolving needs a note', async () => {
    const id = Number((await q(`INSERT INTO tax_alerts (alert_key, alert_type, severity, message) VALUES ('test:alert', 'test', 'critical', 'TEST ONLY alert') RETURNING id`))[0].id);
    expect((await call('admin', 'GET', '/api/admin/tax/alerts')).body.data.map((a) => a.alert_key)).toContain('test:alert');
    expect((await call('admin', 'GET', '/api/admin/tax/overview')).body.data.open_alerts.critical).toBeGreaterThanOrEqual(1);
    expect((await call('admin', 'POST', '/api/admin/tax/alerts/' + id + '/resolve', { note: '' })).body.code).toBe('NOTE_REQUIRED');
    expect((await call('admin', 'POST', '/api/admin/tax/alerts/' + id + '/resolve', { note: 'Checked with the accountant' })).body.data).toEqual({ resolved: true });
    expect((await call('admin', 'POST', '/api/admin/tax/alerts/' + id + '/resolve', { note: 'Checked again' })).status).toBe(404);
    const resolved = (await call('admin', 'GET', '/api/admin/tax/alerts?status=resolved')).body.data;
    expect(resolved.find((a) => a.alert_key === 'test:alert')).toMatchObject({ resolution: 'Checked with the accountant' });
    expect((await q('SELECT resolved_by FROM tax_alerts WHERE id = $1', [id]))[0].resolved_by).toBe(ID.admin);
    expect((await audits('tax_alert_resolved'))).toHaveLength(1);
  });
  test('ledger corrections and reserve transfers are recorded with a reason or reference; the drill-down has no buyer field', async () => {
    expect((await call('admin', 'POST', '/api/admin/tax/adjustments', { state: 'TX', tax_collected_cents: 1200 })).body.code).toBe('REASON_REQUIRED');
    expect((await call('admin', 'POST', '/api/admin/tax/adjustments', { state: 'TX', tax_collected_cents: 12.5, reason: 'TEST ONLY: correcting a posting' })).body.code).toBe('AMOUNT_INVALID');
    expect((await call('admin', 'POST', '/api/admin/tax/adjustments', { state: 'ZZ', tax_collected_cents: 1200, reason: 'TEST ONLY: correcting a posting' })).body.code).toBe('STATE_INVALID');
    const adj = await call('admin', 'POST', '/api/admin/tax/adjustments', { state: 'TX', tax_collected_cents: 1200, taxable_cents: 14545, reason: 'TEST ONLY: correcting a posting' });
    expect(adj.body.data).toMatchObject({ entry_type: 'adjustment', state: 'TX', tax_collected_cents: 1200, remitter: 'platform' });
    expect((await call('admin', 'GET', '/api/admin/tax/reserve')).body.data).toEqual({ position: { collected: 1200, remitted: 500, outstanding: 700, heldOutside: 0, requiredOnHand: 700 }, guard_enabled: true });
    expect((await call('admin', 'POST', '/api/admin/tax/reserve/transfers', { amount_cents: 300 })).body.code).toBe('REFERENCE_REQUIRED');
    expect((await call('admin', 'POST', '/api/admin/tax/reserve/transfers', { amount_cents: 'abc', reference: 'WIRE-1' })).body.code).toBe('AMOUNT_INVALID');
    const tr = await call('admin', 'POST', '/api/admin/tax/reserve/transfers', { amount_cents: 800, moved_on: '2026-11-14', reference: 'WIRE-1' });
    // 800 moved, 500 of it already remitted: 300 is still held in the tax account, so 400 must stay on hand.
    expect(tr.body.data.position).toEqual({ collected: 1200, remitted: 500, outstanding: 700, heldOutside: 300, requiredOnHand: 400 });
    expect((await call('admin', 'POST', '/api/admin/tax/reserve/transfers', { amount_cents: 800, reference: 'WIRE-1' })).status).toBe(409);
    const led = (await call('admin', 'GET', '/api/admin/tax/ledger?state=TX')).body.data;
    expect(led.total).toBe(2);
    for (const row of led.rows) expect(row).not.toHaveProperty('buyer_user_id');
    expect((await audits('tax_ledger_adjustment_posted'))[0].metadata.after).toMatchObject({ tax_collected_cents: 1200 });
    expect((await audits('tax_reserve_transfer_recorded'))[0].metadata).toMatchObject({ before: { requiredOnHand: 700 }, after: { requiredOnHand: 400 } });
  });
});

describe('reports and downloads', () => {
  test('CSV downloads are attachments; a bad filter is a clear refusal', async () => {
    for (const p of ['/api/admin/tax/ledger.csv', '/api/admin/tax/state-summary.csv', '/api/admin/tax/filing-export.csv?state=TX&from=2026-11-01&to=2026-11-30', '/api/admin/tax/seller-reporting.csv?year=2026']) {
      const r = await call('admin', 'GET', p);
      expect([p, r.status]).toEqual([p, 200]);
      expect(r.headers.get('content-type')).toMatch(/^text\/csv/);
      expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.csv"$/);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    const bad = await call('admin', 'GET', '/api/admin/tax/ledger.csv?channel=nope');
    expect([bad.status, bad.body.code]).toEqual([422, 'CHANNEL_INVALID']);
    expect((await call('admin', 'GET', '/api/admin/tax/filing-export.csv?state=TX')).body.code).toBe('DATE_INVALID');
    const csv = (await call('admin', 'GET', '/api/admin/tax/filing-export.csv?state=TX&from=2026-11-01&to=2026-11-30')).text;
    expect(csv).toMatch(/Totals,Tax already remitted in these dates,,5\.00/);
  });
  test('seller reporting says filing is not enabled', async () => {
    const r = (await call('admin', 'GET', '/api/admin/tax/seller-reporting?year=2026')).body.data;
    expect(r).toMatchObject({ year: 2026, filing_enabled: false, sellers: [] });
    expect(r.message).toMatch(/not enabled/);
    expect((await call('admin', 'GET', '/api/admin/tax/seller-reporting?year=1')).body.code).toBe('YEAR_INVALID');
  });
  test('reconciliation can be run on demand and keeps a history', async () => {
    const run = await call('admin', 'POST', '/api/admin/tax/reconciliation/run');
    expect(run.status).toBe(200);
    expect(['clean', 'mismatches', 'failed']).toContain(run.body.data.status);
    const hist = (await call('admin', 'GET', '/api/admin/tax/reconciliation')).body.data;
    expect(hist.length).toBeGreaterThanOrEqual(1);
    expect((await call('admin', 'GET', '/api/admin/tax/overview')).body.data.reconciliation).toMatchObject({ status: run.body.data.status });
    expect((await audits('tax_reconciliation_run'))).toHaveLength(1);
  });
});
