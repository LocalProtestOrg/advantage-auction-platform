'use strict';

/**
 * Central sales tax management: the reporting, filing, nexus and seller-reporting services (migration 231), run against
 * the isolated full-stack database (tests/fullstack: every real migration on an in-memory database; never production),
 * so the real SQL and the real schema are exercised. The services' database module is pointed at that database.
 *
 * Covers: filing period helpers; registrations (one open per state, last four characters only); filings opened for the
 * period that just closed with NO invented due date; deadline alerts; a recorded payment posts the remittance and marks
 * the filing paid; multi-state overview totals to the cent; the ledger drill-down and the seller report never return
 * buyer data; CSV escaping including spreadsheet formulas; the local-jurisdiction breakdown ties out to the cent; nexus
 * AND/OR and every measurement period; the auction audit; the worker pass.
 */

const { startStack } = require('./fullstack/stack');
const seed = require('./fullstack/seed');

// One statement at a time: the in-memory test database serves every connection on one session.
function mockDb() {
  let chain = Promise.resolve();
  const query = (sql, params) => { const run = () => global.__TAX_STACK.query(sql, params); const p = chain.then(run, run); chain = p.catch(() => {}); return p; };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}
jest.mock('../src/db', () => mockDb());
jest.mock('../src/db/index', () => mockDb());
jest.mock('dotenv', () => ({ config: () => ({}) }));   // the worker module must never load a local .env file in a test

jest.setTimeout(60000);

let stack; let filings; let nexus; let reports; let sellerReports; let ledger; let alerts;
const S = {};
const NOW = new Date('2026-11-16T17:00:00Z');   // a fixed "today" (noon Eastern) so every period is deterministic
const q = async (sql, p) => (await stack.query(sql, p)).rows;
const at = (iso) => new Date(iso);

async function post(e) {
  return ledger.post({ source_type: 'manual', tax_collected_cents: e.tax || 0, tax_calculated_cents: e.tax || 0, ...e });
}

beforeAll(async () => {
  stack = await startStack();
  global.__TAX_STACK = stack;
  filings = require('../src/services/tax/taxFilingService');
  nexus = require('../src/services/tax/taxNexusService');
  reports = require('../src/services/tax/taxReportService');
  sellerReports = require('../src/services/tax/sellerTaxReportService');
  ledger = require('../src/services/tax/taxLedgerService');
  alerts = require('../src/services/tax/taxAlerts');

  S.admin = await seed.user(stack, { email: 'tax-admin@fullstack.test', role: 'admin', fullName: 'Ada Admin' });
  S.buyer = await seed.user(stack, { email: 'private-buyer@fullstack.test', role: 'buyer', fullName: 'Bea Privatebuyer' });
  const ua = await seed.user(stack, { email: 'tax-seller-a@fullstack.test', role: 'seller', fullName: 'Sam Seller' });
  const ub = await seed.user(stack, { email: 'tax-seller-b@fullstack.test', role: 'seller', fullName: 'Olga Other' });
  S.userA = ua; S.userB = ub;
  S.sellerA = await seed.sellerProfile(stack, { userId: ua, sellerType: 'auction_house', displayName: 'Alpha Auctions' });
  S.sellerB = await seed.sellerProfile(stack, { userId: ub, sellerType: 'estate_sale_company', displayName: 'Beta Estates' });

  const base = { seller_profile_id: S.sellerA, buyer_user_id: S.buyer };
  // Texas, October 2026: Advantage.Bid remits.
  await post({ ...base, idempotency_key: 't:tx1', entry_type: 'sale', channel: 'auction', source_type: 'auction_payment', source_id: 'pay-1', occurred_at: at('2026-10-05T15:00:00Z'),
    state: 'TX', remitter: 'platform', gross_cents: 10825, merchandise_cents: 10000, taxable_cents: 10000, tax: 825,
    jurisdiction_detail: { taxable_cents: 10000, jurisdictions: [{ name: 'Texas', level: 'state', state: 'TX', amount_cents: 625 }, { name: 'Houston', level: 'city', state: 'TX', amount_cents: 200 }] } });
  await post({ ...base, idempotency_key: 't:tx2', entry_type: 'sale', channel: 'marketplace', source_type: 'marketplace_order', source_id: 'ord-2', occurred_at: at('2026-10-12T15:00:00Z'),
    state: 'TX', remitter: 'platform', gross_cents: 5413, merchandise_cents: 5000, taxable_cents: 5000, tax: 413, note: '=HYPERLINK("http://example.invalid","x")',
    jurisdiction_detail: { taxable_cents: 5000, jurisdictions: [{ name: 'Texas', level: 'state', state: 'TX', amount_cents: 313 }, { name: 'Harris County', level: 'county', state: 'TX', amount_cents: 100 }] } });
  await post({ ...base, idempotency_key: 't:tx1r', entry_type: 'refund', channel: 'auction', source_type: 'auction_payment', source_id: 'pay-1', occurred_at: at('2026-10-20T15:00:00Z'),
    state: 'TX', remitter: 'platform', gross_cents: -2165, merchandise_cents: -2000, taxable_cents: -2000, tax: -165, note: 'partial refund' });
  await post({ ...base, idempotency_key: 't:tx3', entry_type: 'sale', channel: 'seller_website', source_type: 'marketplace_order', source_id: 'ord-3', occurred_at: at('2026-10-25T15:00:00Z'),
    state: 'TX', remitter: 'none', tax_basis: 'exempt', gross_cents: 3000, merchandise_cents: 3000, exempt_cents: 3000 });
  // Texas, September 2026 and December 2025 (other periods and years).
  await post({ ...base, idempotency_key: 't:tx-sep', entry_type: 'sale', channel: 'auction', source_type: 'auction_payment', source_id: 'pay-sep', occurred_at: at('2026-09-10T15:00:00Z'),
    state: 'TX', remitter: 'platform', gross_cents: 2165, merchandise_cents: 2000, taxable_cents: 2000, tax: 165 });
  await post({ ...base, idempotency_key: 't:tx-2025', entry_type: 'sale', channel: 'auction', source_type: 'auction_payment', source_id: 'pay-2025', occurred_at: at('2025-12-10T15:00:00Z'),
    state: 'TX', remitter: 'none', gross_cents: 50000, merchandise_cents: 50000, exempt_cents: 50000 });
  // Ohio: the seller is responsible. Georgia: a sale with no rule.
  await post({ seller_profile_id: S.sellerB, buyer_user_id: S.buyer, idempotency_key: 't:oh1', entry_type: 'sale', channel: 'auction', source_type: 'auction_payment', source_id: 'pay-oh',
    occurred_at: at('2026-10-08T15:00:00Z'), state: 'OH', remitter: 'seller_direct', gross_cents: 20000, merchandise_cents: 20000, exempt_cents: 20000 });
  await post({ seller_profile_id: S.sellerB, buyer_user_id: S.buyer, idempotency_key: 't:ga1', entry_type: 'sale', channel: 'auction', source_type: 'auction_payment', source_id: 'pay-ga',
    occurred_at: at('2026-10-09T15:00:00Z'), state: 'GA', remitter: 'unconfigured', gross_cents: 7000, merchandise_cents: 7000, exempt_cents: 7000 });
}, 240000);
afterAll(async () => { if (stack) await stack.stop(); }, 30000);

describe('filing period helpers', () => {
  test('the period containing a date, for each frequency', () => {
    expect(filings.periodFor('monthly', '2026-02-14')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(filings.periodFor('monthly', '2028-02-14')).toEqual({ start: '2028-02-01', end: '2028-02-29' });   // leap year
    expect(filings.periodFor('quarterly', '2026-05-31')).toEqual({ start: '2026-04-01', end: '2026-06-30' });
    expect(filings.periodFor('quarterly', '2026-12-31')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(filings.periodFor('annual', '2026-07-04')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(filings.periodFor('other', '2026-07-04')).toBeNull();
  });
  test('the most recently closed period', () => {
    expect(filings.previousPeriod('monthly', '2026-01-10')).toEqual({ start: '2025-12-01', end: '2025-12-31' });
    expect(filings.previousPeriod('monthly', NOW)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(filings.previousPeriod('quarterly', NOW)).toEqual({ start: '2026-07-01', end: '2026-09-30' });
    expect(filings.previousPeriod('quarterly', '2026-02-01')).toEqual({ start: '2025-10-01', end: '2025-12-31' });
    expect(filings.previousPeriod('annual', NOW)).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(filings.previousPeriod('other', NOW)).toBeNull();
  });
  test('the period is taken in America/New_York, not UTC', () => {
    // 03:00 UTC on 1 November is still 31 October in New York.
    expect(filings.periodFor('monthly', new Date('2026-11-01T03:00:00Z'))).toEqual({ start: '2026-10-01', end: '2026-10-31' });
  });
});

describe('nexus evaluation (pure)', () => {
  const w = (sales, tx) => ({ sales_cents: sales, transactions: tx });
  const windows = { current: w(9000000, 150), previous: w(0, 0), rolling: w(0, 0) };
  const t = (o) => ({ sales_threshold_cents: 10000000, transaction_threshold: 200, combine_rule: 'or', measurement_period: 'calendar_year', counts_marketplace_sales: true, physical_presence: false, ...o });
  test('OR takes the higher percentage, AND the lower', () => {
    expect(nexus.evaluate({ threshold: t({}), windows, registered: false })).toMatchObject({ status: 'near', overall_pct: 90, sales_pct: 90, transaction_pct: 75 });
    expect(nexus.evaluate({ threshold: t({ combine_rule: 'and' }), windows, registered: false })).toMatchObject({ status: 'approaching', overall_pct: 75 });
    expect(nexus.evaluate({ threshold: t({ combine_rule: 'and' }), windows: { ...windows, current: w(20000000, 100) }, registered: false }).status).toBe('below');     // sales exceeded, transactions not
    expect(nexus.evaluate({ threshold: t({ combine_rule: 'or' }), windows: { ...windows, current: w(1, 200) }, registered: false }).status).toBe('exceeded');
    expect(nexus.evaluate({ threshold: t({ combine_rule: 'and' }), windows: { ...windows, current: w(10000000, 200) }, registered: false }).status).toBe('exceeded');
  });
  test('bands: 70% approaching, 90% near, 100% exceeded', () => {
    const only = (sales) => nexus.evaluate({ threshold: t({ transaction_threshold: null }), windows: { ...windows, current: w(sales, 0) }, registered: false }).status;
    expect([only(6999999), only(7000000), only(8999999), only(9000000), only(9999999), only(10000000)]).toEqual(['below', 'approaching', 'approaching', 'near', 'near', 'exceeded']);
  });
  test('undetermined, not counted, no amounts, physical presence, registered, no threshold', () => {
    expect(nexus.evaluate({ threshold: t({ counts_marketplace_sales: null }), windows, registered: false }).status).toBe('review');
    expect(nexus.evaluate({ threshold: t({ counts_marketplace_sales: false }), windows: { ...windows, current: w(99999999, 999) }, registered: false })).toMatchObject({ status: 'below', overall_pct: 0 });
    expect(nexus.evaluate({ threshold: t({ sales_threshold_cents: null, transaction_threshold: null }), windows, registered: false }).status).toBe('review');
    expect(nexus.evaluate({ threshold: t({ physical_presence: true }), windows, registered: true }).status).toBe('physical_presence');
    expect(nexus.evaluate({ threshold: t({}), windows: { ...windows, current: w(99999999, 999) }, registered: true }).status).toBe('registered');
    expect(nexus.evaluate({ threshold: null, windows, registered: false }).status).toBe('no_threshold');
  });
});

describe('CSV cells', () => {
  test('quotes, commas and line breaks are escaped', () => {
    expect(reports.csvCell('plain')).toBe('plain');
    expect(reports.csvCell('a,b')).toBe('"a,b"');
    expect(reports.csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(reports.csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(reports.csvCell(null)).toBe('');
  });
  test('a cell that a spreadsheet would run as a formula is neutralized; plain numbers are not', () => {
    expect(reports.csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(reports.csvCell('+1+1')).toBe("'+1+1");
    expect(reports.csvCell('-2+3')).toBe("'-2+3");
    expect(reports.csvCell('@cmd')).toBe("'@cmd");
    expect(reports.csvCell('=1,2')).toBe('"\'=1,2"');
    expect(reports.csvCell('-12.34')).toBe('-12.34');
    expect(reports.csvCell(-5)).toBe('-5');
  });
  test('cents are written as exact decimal amounts', () => {
    expect([reports.dollars(0), reports.dollars(5), reports.dollars(-5), reports.dollars(123456), reports.dollars(-216500), reports.dollars('1073')]).toEqual(['0.00', '0.05', '-0.05', '1234.56', '-2165.00', '10.73']);
  });
});

describe('overview: multi-state totals to the cent', () => {
  test('October 2026 by state, with all-time outstanding, rule, registration and filing', async () => {
    const o = await reports.overview({ period: '2026-10', now: NOW });
    expect(o.period).toBe('2026-10');
    expect(o.periods).toEqual(['2026-11', '2026-10', '2026-09', '2025-12']);
    const by = Object.fromEntries(o.states.map((s) => [s.state, s]));
    expect(by.TX).toMatchObject({ gross_cents: 19238, refunds_cents: 2165, taxable_cents: 13000, exempt_cents: 3000, tax_collected_cents: 1238, tax_refunded_cents: 165,
      net_tax_cents: 1073, platform_net_tax_cents: 1073, sale_count: 3, all_time_collected_cents: 1238, all_time_remitted_cents: 0, outstanding_cents: 1238, rule: null, registration: null, filing: null });
    expect(by.TX.by_channel.auction).toMatchObject({ gross_cents: 10825, refunds_cents: 2165, net_tax_cents: 660 });
    expect(by.TX.by_channel.marketplace).toMatchObject({ gross_cents: 5413, net_tax_cents: 413 });
    expect(by.TX.by_channel.seller_website).toMatchObject({ gross_cents: 3000, net_tax_cents: 0 });
    expect(by.OH).toMatchObject({ gross_cents: 20000, taxable_cents: 0, exempt_cents: 20000, tax_collected_cents: 0, outstanding_cents: 0 });
    expect(by.GA).toMatchObject({ gross_cents: 7000, net_tax_cents: 0 });
    expect(o.totals).toMatchObject({ gross_cents: 46238, refunds_cents: 2165, taxable_cents: 13000, exempt_cents: 30000, tax_collected_cents: 1238, tax_refunded_cents: 165,
      net_tax_cents: 1073, platform_net_tax_cents: 1073, sale_count: 5, outstanding_cents: 1238 });
    expect(o.totals.by_channel.auction.gross_cents).toBe(37825);
    expect(o.unconfigured_sales).toBe(1);
    expect(o.exception_sales).toBe(0);
    expect(o.enforcement).toBe('report');
    expect(o.reserve_guard).toBe(true);
    expect(o.reserve).toMatchObject({ collected: 1238, remitted: 0, outstanding: 1238, requiredOnHand: 1238 });
  });
  test('an unknown period falls back to the current month; an empty month has no sales', async () => {
    const o = await reports.overview({ period: 'not-a-month', now: NOW });
    expect(o.period).toBe('2026-11');
    expect(o.totals.gross_cents).toBe(0);
    expect(o.totals.outstanding_cents).toBe(1238);   // all time, independent of the month shown
  });
});

describe('ledger drill-down and exports never carry buyer data', () => {
  test('rows name the seller and never the buyer', async () => {
    const r = await reports.ledger({ state: 'TX', period: '2026-10' });
    expect(r.total).toBe(4);
    expect(r.rows).toHaveLength(4);
    for (const row of r.rows) {
      expect(row).not.toHaveProperty('buyer_user_id');
      expect(row.seller_name).toBe('Alpha Auctions');
    }
    const all = JSON.stringify(await reports.ledger({}));
    expect(all).not.toContain(S.buyer);
    expect(all).not.toMatch(/Privatebuyer|private-buyer@/);
  });
  test('filters and paging', async () => {
    expect((await reports.ledger({ channel: 'marketplace' })).total).toBe(1);
    expect((await reports.ledger({ entry_type: 'refund' })).rows[0]).toMatchObject({ gross_cents: -2165, tax_collected_cents: -165 });
    expect((await reports.ledger({ remitter: 'unconfigured' })).rows.map((x) => x.state)).toEqual(['GA']);
    expect((await reports.ledger({ seller_profile_id: S.sellerB })).total).toBe(2);
    expect((await reports.ledger({ source_id: 'pay-1' })).total).toBe(2);
    const page = await reports.ledger({ limit: 2, offset: 2 });
    expect([page.rows.length, page.limit, page.offset, page.total]).toEqual([2, 2, 2, 8]);
    await expect(reports.ledger({ channel: 'x' })).rejects.toMatchObject({ status: 422, code: 'CHANNEL_INVALID' });
    await expect(reports.ledger({ seller_profile_id: "1' OR '1'='1" })).rejects.toMatchObject({ status: 422, code: 'SELLER_INVALID' });
  });
  test('the ledger CSV has no buyer column or value, and neutralizes a formula in a note', async () => {
    const csv = await reports.ledgerCsv({ state: 'TX', period: '2026-10' });
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).not.toMatch(/buyer(?! premium)/i);
    expect(csv).not.toContain(S.buyer);
    expect(csv).toContain('"\'=HYPERLINK(""http://example.invalid"",""x"")"');
    expect(csv).toContain(',-21.65,-20.00,');
    expect(csv).toContain('Alpha Auctions');
  });
  test('state summary CSV: one row per state and month', async () => {
    const csv = await reports.stateSummaryCsv({ from: '2026-09', to: '2026-10' });
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(5);   // header + TX Sep + GA, OH, TX Oct
    expect(lines).toContain('TX,2026-10,3,192.38,21.65,130.00,30.00,12.38,1.65,0.00,10.73,10.73,0.00');
    expect(lines).toContain('TX,2026-09,1,21.65,0.00,20.00,0.00,1.65,0.00,0.00,1.65,1.65,0.00');
    await expect(reports.stateSummaryCsv({ from: 'x' })).rejects.toMatchObject({ code: 'PERIOD_INVALID' });
  });
  test('the filing export totals and the local jurisdiction breakdown tie out to the cent', async () => {
    const csv = await reports.filingExportCsv({ state: 'TX', from: '2026-10-01', to: '2026-10-31' });
    const rows = csv.trim().split('\r\n').map((l) => l.split(','));
    const find = (section, item) => rows.find((r) => r[0] === section && r[1] === item);
    expect(find('Totals', 'Taxable sales (net of refunds)')[3]).toBe('130.00');
    expect(find('Totals', 'Net tax Advantage.Bid remits')[3]).toBe('10.73');
    const local = rows.filter((r) => r[0].startsWith('Local jurisdictions'));
    expect(local.map((r) => [r[1], r[2], r[3]])).toEqual([['Texas', 'state', '8.13'], ['Harris County', 'county', '1.00'], ['Houston', 'city', '1.60']]);
    expect(local.reduce((s, r) => s + Math.round(Number(r[3]) * 100), 0)).toBe(1073);
    await expect(reports.filingExportCsv({ state: 'TX', from: '2026-10-31', to: '2026-10-01' })).rejects.toMatchObject({ code: 'DATE_INVALID' });
    await expect(reports.filingExportCsv({ state: 'Texas', from: '2026-10-01', to: '2026-10-31' })).rejects.toMatchObject({ code: 'STATE_INVALID' });
  });
});

describe('nexus thresholds and status against the ledger', () => {
  const tx = async () => (await nexus.status({ now: NOW })).find((s) => s.state === 'TX');
  const base = { state: 'TX', legal_reference: 'TEST ONLY: example statute reference', counts_marketplace_sales: true };
  test('a threshold needs its legal reference and valid values', async () => {
    await expect(nexus.set({ state: 'TX', sales_threshold_cents: 100 }, S.admin)).rejects.toMatchObject({ status: 422, code: 'LEGAL_REFERENCE_REQUIRED' });
    await expect(nexus.set({ ...base, state: 'ZZ' }, S.admin)).rejects.toMatchObject({ code: 'STATE_INVALID' });
    await expect(nexus.set({ ...base, sales_threshold_cents: -1 }, S.admin)).rejects.toMatchObject({ code: 'SALES_THRESHOLD_INVALID' });
    await expect(nexus.set({ ...base, measurement_period: 'fiscal_year' }, S.admin)).rejects.toMatchObject({ code: 'MEASUREMENT_PERIOD_INVALID' });
    await expect(nexus.set({ ...base, combine_rule: 'xor' }, S.admin)).rejects.toMatchObject({ code: 'COMBINE_RULE_INVALID' });
    await expect(nexus.set({ ...base, source_url: 'javascript:alert(1)' }, S.admin)).rejects.toMatchObject({ code: 'SOURCE_URL_INVALID' });
    expect(await nexus.list()).toEqual([]);   // nothing is seeded and nothing invalid was saved
  });
  test('with no threshold, a state with sales is flagged for review', async () => {
    expect(await tx()).toMatchObject({ status: 'no_threshold', has_sales: true, registered: false });
  });
  test('current calendar year: sales without tax, net of refunds, by channel', async () => {
    const r = await nexus.set({ ...base, sales_threshold_cents: 20000, measurement_period: 'calendar_year' }, S.admin);
    expect(r.before).toBeNull();
    expect(r.after).toMatchObject({ state: 'TX', sales_threshold_cents: 20000, combine_rule: 'or', measurement_period: 'calendar_year', counts_marketplace_sales: true });
    const s = await tx();
    expect(s).toMatchObject({ status: 'near', overall_pct: 90, sales_pct: 90, transaction_pct: null });
    expect(s.measured).toMatchObject({ window: 'calendar_year', sales_cents: 18000, transactions: 4 });
    expect(s.measured.by_channel).toEqual({ auction: { sales_cents: 10000, transactions: 2 }, marketplace: { sales_cents: 5000, transactions: 1 }, seller_website: { sales_cents: 3000, transactions: 1 } });
  });
  test('AND / OR with a transaction threshold', async () => {
    await nexus.set({ ...base, sales_threshold_cents: 20000, transaction_threshold: 10, combine_rule: 'or' }, S.admin);
    expect(await tx()).toMatchObject({ status: 'near', sales_pct: 90, transaction_pct: 40, overall_pct: 90 });
    await nexus.set({ ...base, sales_threshold_cents: 20000, transaction_threshold: 10, combine_rule: 'and' }, S.admin);
    expect(await tx()).toMatchObject({ status: 'below', overall_pct: 40 });
    await nexus.set({ ...base, sales_threshold_cents: 18000, transaction_threshold: 4, combine_rule: 'and' }, S.admin);
    expect(await tx()).toMatchObject({ status: 'exceeded', overall_pct: 100 });
  });
  test('previous calendar year, current-or-previous, and rolling 12 months', async () => {
    await nexus.set({ ...base, sales_threshold_cents: 50000, measurement_period: 'previous_calendar_year' }, S.admin);
    let s = await tx();
    expect(s).toMatchObject({ status: 'exceeded', overall_pct: 100 });
    expect(s.measured).toMatchObject({ window: 'previous_calendar_year', sales_cents: 50000, transactions: 1 });
    await nexus.set({ ...base, sales_threshold_cents: 40000, measurement_period: 'current_or_previous_calendar_year' }, S.admin);
    s = await tx();
    expect(s).toMatchObject({ status: 'exceeded', overall_pct: 125 });
    expect(s.measured.window).toBe('previous_calendar_year');
    await nexus.set({ ...base, sales_threshold_cents: 90000, measurement_period: 'rolling_12_months' }, S.admin);
    s = await tx();
    expect(s.measured).toMatchObject({ window: 'rolling_12_months', sales_cents: 68000, transactions: 5 });
    expect(s).toMatchObject({ status: 'approaching', overall_pct: 75.55 });
    // A year later the December 2025 sale has rolled out of the window.
    const later = (await nexus.status({ now: new Date('2026-12-20T17:00:00Z') })).find((x) => x.state === 'TX');
    expect(later.measured).toMatchObject({ sales_cents: 18000, transactions: 4 });
  });
  test('undetermined counting is flagged for review; alerts are raised and cleared; nothing is registered', async () => {
    await nexus.set({ ...base, counts_marketplace_sales: null, sales_threshold_cents: 20000 }, S.admin);
    expect(await tx()).toMatchObject({ status: 'review', has_sales: true });
    await nexus.alerts({ now: NOW });
    let open = (await alerts.list({ open: true })).filter((a) => a.alert_type === 'nexus');
    expect(open.map((a) => a.alert_key).sort()).toEqual(['nexus:GA:no_threshold', 'nexus:OH:no_threshold', 'nexus:TX:review']);
    await nexus.set({ ...base, sales_threshold_cents: 18000 }, S.admin);
    await nexus.alerts({ now: NOW });
    open = (await alerts.list({ open: true })).filter((a) => a.alert_type === 'nexus');
    expect(open.map((a) => [a.alert_key, a.severity]).sort()).toEqual([['nexus:GA:no_threshold', 'warning'], ['nexus:OH:no_threshold', 'warning'], ['nexus:TX:exceeded', 'critical']]);
    expect((await q(`SELECT count(*)::int AS n FROM tax_alerts WHERE alert_key = 'nexus:TX:review' AND resolved_at IS NOT NULL`))[0].n).toBe(1);
    expect((await q('SELECT count(*)::int AS n FROM tax_registrations'))[0].n).toBe(0);
    // Physical presence is its own status; removing the threshold returns the state to "no threshold".
    await nexus.set({ ...base, physical_presence: true }, S.admin);
    expect((await tx()).status).toBe('physical_presence');
    expect(await nexus.remove('tx')).toMatchObject({ state: 'TX' });
    expect((await tx()).status).toBe('no_threshold');
  });
});

describe('registrations', () => {
  test('one registration that is not closed per state; only the last four characters of the number', async () => {
    await expect(filings.createRegistration({ state: 'ZZ' }, S.admin)).rejects.toMatchObject({ status: 422, code: 'STATE_INVALID' });
    await expect(filings.createRegistration({ state: 'FL', registration_last4: '12-3456789' }, S.admin)).rejects.toMatchObject({ status: 422, code: 'LAST4_INVALID' });
    await expect(filings.createRegistration({ state: 'FL', filing_frequency: 'weekly' }, S.admin)).rejects.toMatchObject({ code: 'FREQUENCY_INVALID' });
    await expect(filings.createRegistration({ state: 'FL', effective_from: '2026-02-30' }, S.admin)).rejects.toMatchObject({ code: 'DATE_INVALID' });
    const r = await filings.createRegistration({ state: 'fl', status: 'active', effective_from: '2026-01-01', filing_frequency: 'monthly', registration_last4: '6789' }, S.admin);
    expect(r.after).toMatchObject({ state: 'FL', status: 'active', effective_from: '2026-01-01', filing_frequency: 'monthly', zero_filing_required: true, registration_last4: '6789', processor_registered: false, created_by: S.admin });
    S.regFL = r.after.id;
    await expect(filings.createRegistration({ state: 'FL', status: 'pending' }, S.admin)).rejects.toMatchObject({ status: 409, code: 'REGISTRATION_EXISTS' });
    const u = await filings.updateRegistration(S.regFL, { processor_registered: true, notes: 'Confirmed with the accountant' }, S.admin);
    expect(u.before.processor_registered).toBe(false);
    expect(u.after).toMatchObject({ processor_registered: true, notes: 'Confirmed with the accountant', status: 'active' });
    await expect(filings.updateRegistration(S.regFL, { registration_last4: '123456789' }, S.admin)).rejects.toMatchObject({ code: 'LAST4_INVALID' });
    await expect(filings.updateRegistration('00000000-0000-4000-8000-000000000000', { status: 'closed' }, S.admin)).rejects.toMatchObject({ status: 404 });
    // The database itself refuses a longer value.
    await expect(stack.query(`UPDATE tax_registrations SET registration_last4 = '12345' WHERE id = $1`, [S.regFL])).rejects.toThrow();
  });
});

describe('filings', () => {
  test('the row for the period that just closed is opened without a due date; zero returns are not forgotten', async () => {
    // New York: quarterly, zero returns NOT required, no tax collected there, so no row.
    await filings.createRegistration({ state: 'NY', status: 'active', filing_frequency: 'quarterly', zero_filing_required: false }, S.admin);
    // Illinois: pending registrations never get a row. Nevada: active but effective after the period.
    await filings.createRegistration({ state: 'IL', status: 'pending', filing_frequency: 'monthly' }, S.admin);
    await filings.createRegistration({ state: 'NV', status: 'active', filing_frequency: 'monthly', effective_from: '2026-11-10' }, S.admin);
    const created = await filings.ensureCurrentFilings({ now: NOW });
    expect(created.map((c) => [c.state, c.period_start, c.period_end])).toEqual([['FL', '2026-10-01', '2026-10-31']]);
    const fl = (await filings.listFilings({ state: 'FL' }))[0];
    expect(fl).toMatchObject({ state: 'FL', status: 'open', due_date: null, tax_due_cents: null, period_start: '2026-10-01', period_end: '2026-10-31' });
    S.filingFL = fl.id;
    expect(await filings.ensureCurrentFilings({ now: NOW })).toEqual([]);   // idempotent
    expect(await filings.listFilings({})).toHaveLength(1);
  });
  test('deadline alerts: no due date, due within 14 days, overdue; cleared when no longer true', async () => {
    const keys = async () => (await alerts.list({ open: true })).filter((a) => a.alert_type === 'filing_deadline').map((a) => [a.alert_key.split(':').pop(), a.severity]);
    await filings.deadlineAlerts({ now: NOW });
    expect(await keys()).toEqual([['no_due_date', 'warning']]);
    await filings.updateFiling(S.filingFL, { due_date: '2026-11-20' }, S.admin);
    await filings.deadlineAlerts({ now: NOW });
    expect(await keys()).toEqual([['due_soon', 'warning']]);
    await filings.updateFiling(S.filingFL, { due_date: '2026-11-10' }, S.admin);
    await filings.deadlineAlerts({ now: NOW });
    expect(await keys()).toEqual([['overdue', 'critical']]);
    await filings.updateFiling(S.filingFL, { due_date: '2026-12-20' }, S.admin);
    await filings.deadlineAlerts({ now: NOW });
    expect(await keys()).toEqual([]);
  });
  test('create and update validate; "paid" is reached only by recording the payment', async () => {
    await expect(filings.createFiling({ state: 'TX', period_start: '2026-10-01' }, S.admin)).rejects.toMatchObject({ code: 'PERIOD_REQUIRED' });
    await expect(filings.createFiling({ state: 'TX', period_start: '2026-10-31', period_end: '2026-10-01' }, S.admin)).rejects.toMatchObject({ code: 'PERIOD_INVALID' });
    const c = await filings.createFiling({ state: 'TX', period_start: '2026-10-01', period_end: '2026-10-31', due_date: '2026-11-20' }, S.admin);
    S.filingTX = c.after.id;
    await expect(filings.createFiling({ state: 'TX', period_start: '2026-10-01', period_end: '2026-10-31' }, S.admin)).rejects.toMatchObject({ status: 409, code: 'FILING_EXISTS' });
    await expect(filings.updateFiling(S.filingTX, { status: 'paid' }, S.admin)).rejects.toMatchObject({ code: 'RECORD_PAYMENT' });
    await expect(filings.updateFiling(S.filingTX, { status: 'filed' }, S.admin)).rejects.toMatchObject({ code: 'FILED_DATE_REQUIRED' });
    await expect(filings.updateFiling(S.filingTX, { filed_by_method: 'robot' }, S.admin)).rejects.toMatchObject({ code: 'METHOD_INVALID' });
    await expect(filings.updateFiling(S.filingTX, { tax_due_cents: 10.5 }, S.admin)).rejects.toMatchObject({ code: 'AMOUNT_INVALID' });
    const u = await filings.updateFiling(S.filingTX, { status: 'filed', filed_at: '2026-11-12', filed_by_method: 'accountant', confirmation_number: 'CONF-1', tax_due_cents: 1073 }, S.admin);
    expect(u.before.status).toBe('open');
    expect(u.after).toMatchObject({ status: 'filed', filed_at: '2026-11-12', filed_by_method: 'accountant', confirmation_number: 'CONF-1', tax_due_cents: 1073 });
  });
  test('recording a payment posts the remittance to the ledger and marks the filing paid; a repeat is refused', async () => {
    await expect(filings.recordPayment(S.filingTX, { amountCents: 0, reference: 'ACH-1' }, S.admin)).rejects.toMatchObject({ code: 'AMOUNT_INVALID' });
    await expect(filings.recordPayment(S.filingTX, { amountCents: 1073, reference: '' }, S.admin)).rejects.toMatchObject({ code: 'REFERENCE_REQUIRED' });
    expect((await filings.getFiling(S.filingTX)).status).toBe('filed');   // nothing changed by a refused payment
    const r = await filings.recordPayment(S.filingTX, { amountCents: 1073, paidOn: '2026-11-13', reference: 'ACH-20261113', note: 'October return' }, S.admin);
    expect(r.after.status).toBe('paid');
    expect(r.entry.tax_remitted_cents).toBe(1073);
    const row = (await q(`SELECT entry_type, state, remitter, tax_remitted_cents, filing_id, to_char(tax_period, 'YYYY-MM') AS period, created_by FROM tax_ledger_entries WHERE filing_id = $1`, [S.filingTX]))[0];
    expect(row).toMatchObject({ entry_type: 'remittance', state: 'TX', remitter: 'platform', tax_remitted_cents: '1073', period: '2026-11', created_by: S.admin });
    await expect(filings.recordPayment(S.filingTX, { amountCents: 1073, paidOn: '2026-11-13', reference: 'ACH-20261113' }, S.admin)).rejects.toMatchObject({ status: 409, code: 'PAYMENT_ALREADY_RECORDED' });
    await expect(filings.updateFiling(S.filingTX, { status: 'open' }, S.admin)).rejects.toMatchObject({ status: 409, code: 'FILING_PAID' });
    const o = await reports.overview({ period: '2026-10', now: NOW });
    const txRow = o.states.find((s) => s.state === 'TX');
    expect(txRow).toMatchObject({ all_time_collected_cents: 1238, all_time_remitted_cents: 1073, outstanding_cents: 165 });
    expect(txRow.filing).toMatchObject({ status: 'paid', due_date: '2026-11-20', period_start: '2026-10-01' });
    expect(o.states.find((s) => s.state === 'FL').registration).toMatchObject({ status: 'active', filing_frequency: 'monthly' });
    expect(o.reserve).toMatchObject({ collected: 1238, remitted: 1073, outstanding: 165 });
    // The ledger is append-only: the database refuses an edit.
    await expect(stack.query(`UPDATE tax_ledger_entries SET tax_remitted_cents = 1 WHERE filing_id = $1`, [S.filingTX])).rejects.toThrow(/append-only/);
  });
});

describe('seller reporting preparation (nothing is filed)', () => {
  beforeAll(async () => {
    const auction = (await q(`INSERT INTO auctions (seller_id, title, state, address_state) VALUES ($1, 'Alpha closed sale', 'closed', 'TX') RETURNING id`, [S.sellerA]))[0].id;
    const old = (await q(`INSERT INTO auctions (seller_id, title, state, address_state) VALUES ($1, 'Alpha 2025 sale', 'closed', 'TX') RETURNING id`, [S.sellerA]))[0].id;
    const demo = (await q(`INSERT INTO auctions (seller_id, title, state, address_state, is_demo) VALUES ($1, 'Demo sale', 'closed', 'TX', true) RETURNING id`, [S.sellerA]))[0].id;
    await q(`INSERT INTO seller_payouts (auction_id, seller_user_id, seller_payout_cents, final_amount_paid_cents, paid_at) VALUES ($1, $2, 8000, 8000, '2026-10-20T15:00:00Z')`, [auction, S.userA]);
    await q(`INSERT INTO seller_payouts (auction_id, seller_user_id, seller_payout_cents, final_amount_paid_cents, paid_at) VALUES ($1, $2, 40000, 40000, '2025-12-20T15:00:00Z')`, [old, S.userA]);
    await q(`INSERT INTO seller_payouts (auction_id, seller_user_id, seller_payout_cents, final_amount_paid_cents, paid_at) VALUES ($1, $2, 999, 999, '2026-10-20T15:00:00Z')`, [demo, S.userA]);
    await q(`INSERT INTO storefront_payouts (seller_profile_id, seller_user_id, period_cutoff_at, seller_payout_cents, settlement_status, final_amount_paid_cents, paid_at)
             VALUES ($1, $2, '2026-10-21T00:00:00Z', 4550, 'paid', 4550, '2026-10-22T15:00:00Z')`, [S.sellerA, S.userA]);
    await q(`INSERT INTO storefront_payouts (seller_profile_id, seller_user_id, period_cutoff_at, seller_payout_cents, settlement_status)
             VALUES ($1, $2, '2026-10-28T00:00:00Z', 7777, 'pending_review')`, [S.sellerA, S.userA]);   // prepared, never paid: not counted
  });
  test('filing is disabled', () => {
    expect(sellerReports.FILING_ENABLED).toBe(false);
    expect(sellerReports.status()).toMatchObject({ filing_enabled: false });
    expect(sellerReports.status().message).toMatch(/not enabled/);
    expect(Object.keys(sellerReports).filter((k) => /file|submit|send|transmit/i.test(k) && k !== 'FILING_ENABLED')).toEqual([]);
  });
  test('per seller and year: gross processed, refunds, transactions and money actually paid', async () => {
    const r = await sellerReports.byYear(2026);
    expect(r).toMatchObject({ year: 2026, filing_enabled: false });
    const a = r.sellers.find((s) => s.seller_profile_id === S.sellerA);
    expect(a).toEqual({ seller_profile_id: S.sellerA, seller_name: 'Alpha Auctions', gross_sales_cents: 21403, refunds_cents: 2165, transaction_count: 4,
      paid_auction_cents: 8000, paid_storefront_cents: 4550, paid_total_cents: 12550 });
    const b = r.sellers.find((s) => s.seller_profile_id === S.sellerB);
    expect(b).toMatchObject({ seller_name: 'Beta Estates', gross_sales_cents: 27000, refunds_cents: 0, transaction_count: 2, paid_total_cents: 0 });
    expect(r.totals).toEqual({ gross_sales_cents: 48403, refunds_cents: 2165, transaction_count: 6, paid_total_cents: 12550 });
    const y2025 = await sellerReports.byYear(2025);
    expect(y2025.sellers).toEqual([expect.objectContaining({ seller_profile_id: S.sellerA, gross_sales_cents: 50000, transaction_count: 1, paid_auction_cents: 40000 })]);
    await expect(sellerReports.byYear('abc')).rejects.toMatchObject({ status: 422, code: 'YEAR_INVALID' });
  });
  test('never returns buyer data, a user id, an email or a taxpayer number', async () => {
    const r = await sellerReports.byYear(2026);
    const text = JSON.stringify(r) + (await sellerReports.byYearCsv(2026));
    expect(text).not.toContain(S.buyer);
    expect(text).not.toContain(S.userA);
    expect(text).not.toMatch(/Privatebuyer|@fullstack\.test|buyer/i);
    for (const s of r.sellers) expect(Object.keys(s).sort()).toEqual(['gross_sales_cents', 'paid_auction_cents', 'paid_storefront_cents', 'paid_total_cents', 'refunds_cents', 'seller_name', 'seller_profile_id', 'transaction_count']);
    expect(Object.keys(r.sellers[0]).some((k) => /ein|tin|ssn|tax_id|taxpayer/i.test(k))).toBe(false);
    const csv = (await sellerReports.byYearCsv(2026)).trim().split('\r\n');
    expect(csv[0]).toBe('Year,Seller,Seller profile ID,Gross sales processed,Refunds,Sale transactions,Paid to seller: auctions,Paid to seller: storefront,Paid to seller: total');
    expect(csv).toContain(`2026,Alpha Auctions,${S.sellerA},214.03,21.65,4,80.00,45.50,125.50`);
  });
});

describe('auction audit before enforcement', () => {
  test('published or active auctions in a state without a usable rule are listed as blocking', async () => {
    const mk = async (title, state, st, extra = '') => (await q(`INSERT INTO auctions (seller_id, title, state, address_state, start_time, end_time${extra ? ', ' + extra : ''})
      VALUES ($1, $2, $3, $4, now(), now() + interval '5 days'${extra ? ', true' : ''}) RETURNING id`, [S.sellerA, title, state, st]))[0].id;
    await mk('Live in Texas', 'published', 'TX');
    await mk('Active in Ohio', 'active', 'oh');
    await mk('Draft in Georgia', 'draft', 'GA');
    await mk('Published, state unknown', 'published', null);
    await mk('Demo in Texas', 'published', 'TX', 'is_demo');
    await mk('Test in Texas', 'published', 'TX', 'pre_launch_test');
    await q(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis, effective_from) VALUES ('OH', 'seller_direct', 'TEST ONLY rule', DATE '2020-01-01')`);
    let a = await reports.auctionAudit();
    expect(a.auctions.map((x) => x.title).sort()).toEqual(['Active in Ohio', 'Draft in Georgia', 'Live in Texas', 'Published, state unknown']);   // closed, demo and test auctions are left out
    expect(a.blocking.map((x) => [x.title, x.pickup_state, x.rule_usable])).toEqual([['Live in Texas', 'TX', false]]);
    expect(a.states_without_rule).toEqual(['GA', 'TX']);
    expect(a.unknown_state).toBe(1);
    expect(a.auctions.find((x) => x.title === 'Active in Ohio')).toMatchObject({ pickup_state: 'OH', rule: 'seller_direct', rule_usable: true, live: true });
    expect(a.auctions.find((x) => x.title === 'Live in Texas').bidding_ends_at).toBeInstanceOf(Date);
    // A retired rule, or one that is not yet in effect, is not a usable rule.
    await q(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis, effective_from) VALUES ('TX', 'seller', 'TEST ONLY historical rule', DATE '2020-01-01')`);
    a = await reports.auctionAudit();
    expect(a.blocking.map((x) => x.title)).toEqual(['Live in Texas']);
    await q(`UPDATE marketplace_tax_jurisdictions SET remitter = 'seller_direct', effective_from = CURRENT_DATE + 30 WHERE state = 'TX'`);
    expect((await reports.auctionAudit()).blocking).toHaveLength(1);
    await q(`UPDATE marketplace_tax_jurisdictions SET effective_from = DATE '2020-01-01' WHERE state = 'TX'`);
    expect((await reports.auctionAudit()).blocking).toEqual([]);
    const o = await reports.overview({ period: '2026-10', now: NOW });
    expect(o.states.find((s) => s.state === 'TX').rule).toMatchObject({ remitter: 'seller_direct', usable: true, retired: false });
  });
});

describe('the worker pass', () => {
  const worker = () => require('../src/workers/taxWorker');
  test('idle unless enabled; production or an explicit switch turns it on; the off switch wins', () => {
    const { enabled } = worker();
    expect(enabled({ NODE_ENV: 'test' })).toBe(false);
    expect(enabled({ NODE_ENV: 'production' })).toBe(true);
    expect(enabled({ NODE_ENV: 'test', TAX_WORKER_ENABLED: 'true' })).toBe(true);
    expect(enabled({ NODE_ENV: 'production', TAX_WORKER_DISABLED: 'true' })).toBe(false);
  });
  test('does nothing when not enabled', async () => {
    expect(await worker().tick({ now: NOW })).toEqual({ skipped: 'disabled' });
  });
  test('every step runs in isolation: one failing step does not stop the others, and nothing is thrown', async () => {
    const calls = [];
    const deps = {
      ledger: { sync: async () => { calls.push('sync'); return { posted: 0 }; } },
      filings: { ensureCurrentFilings: async () => { calls.push('ensure'); throw new Error('boom'); }, deadlineAlerts: async () => { calls.push('deadline'); return {}; } },
      nexus: { alerts: async () => { calls.push('nexus'); return {}; } },
      reconciliation: { run: async () => { calls.push('recon'); return { id: 7, status: 'clean' }; } },
    };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await worker().tick({ now: NOW, force: true, daily: true, deps });
    spy.mockRestore();
    expect(calls).toEqual(['sync', 'ensure', 'deadline', 'nexus', 'recon']);
    expect(r.ensure_filings).toEqual({ ok: false, error: 'boom' });
    expect(r.reconciliation).toEqual({ ok: true, result: { id: 7, status: 'clean' } });
    const again = await worker().tick({ now: NOW, force: true, daily: false, deps });
    expect(Object.keys(again)).toEqual(['ledger_sync']);   // the 15-minute pass only brings the ledger up to date
  });
  test('the single-run lock is transaction-scoped, so it cannot be stranded on a pooled connection (incident 2026-11-19)', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'workers', 'taxWorker.js'), 'utf8');
    expect(src).toMatch(/pg_try_advisory_xact_lock\(\$1\)/);
    expect(src).not.toMatch(/pg_try_advisory_lock\(|pg_advisory_unlock\(/);
    // The lock transaction is always ended, on every path: a pass that is refused the lock, one that completes, one that fails.
    const sent = [];
    const client = (grant) => ({ query: async (t) => { sent.push(t); return { rows: [{ ok: grant }] }; }, release() { sent.push('release'); } });
    const deps = (grant, sync) => ({ db: { connect: async () => client(grant) }, ledger: { sync } });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {}); const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await worker().tick({ now: NOW, force: true, daily: false, deps: deps(false, async () => ({ posted: 0 })) })).toEqual({ skipped: 'locked' });
    expect(sent).toEqual(['BEGIN', 'SELECT pg_try_advisory_xact_lock($1) AS ok', 'COMMIT', 'release']);
    sent.length = 0;
    await worker().tick({ now: NOW, force: true, daily: false, deps: deps(true, async () => { throw new Error('boom'); }) });
    expect(sent).toEqual(['BEGIN', 'SELECT pg_try_advisory_xact_lock($1) AS ok', 'COMMIT', 'release']);
    sent.length = 0;
    expect((await worker().tick({ now: NOW, force: true, daily: false, deps: deps(true, async () => ({ posted: 1 })) })).ledger_sync).toEqual({ ok: true, result: { posted: 1 } });
    expect(sent).toEqual(['BEGIN', 'SELECT pg_try_advisory_xact_lock($1) AS ok', 'COMMIT', 'release']);
    log.mockRestore(); errSpy.mockRestore();
  });
  test('against the real services and schema: the ledger sync and the daily steps complete', async () => {
    const r = await worker().tick({ now: NOW, force: true, daily: true, deps: { reconciliation: { run: async () => ({ id: 1, status: 'clean' }) } } });
    expect(r.ledger_sync).toMatchObject({ ok: true });
    expect(r.ensure_filings).toMatchObject({ ok: true });
    expect(r.deadline_alerts).toMatchObject({ ok: true });
    expect(r.nexus_alerts).toMatchObject({ ok: true });
  });
});
