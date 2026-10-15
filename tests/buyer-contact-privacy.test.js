'use strict';

/**
 * Buyer contact privacy (owner policy 2026-10-15): sellers receive a buyer's contact details only when needed to
 * complete an actual transaction — for an auction, once that buyer has PAID (pickup / shipping); unpaid winners
 * appear by paddle number. Staff with Super Admin / finance.view keep the full view.
 */
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: jest.fn(async (m) => { global.__mail = m; return { messageId: 'x' }; }) }) }));
const db = require('../src/db');
beforeEach(() => { jest.clearAllMocks(); global.__mail = null; });

describe('auction report (JSON / PDF / final seller report)', () => {
  const { generateAuctionReport } = require('../src/services/reportingService');
  const lots = [
    { lot_id: 'l1', lot_number: 1, title: 'Paid lot', winning_amount_cents: 5000, winner_user_id: 'b1', extension_count: 0, winner_email: 'paid@example.com', winner_paid: true, bid_count: 3 },
    { lot_id: 'l2', lot_number: 2, title: 'Unpaid lot', winning_amount_cents: 7000, winner_user_id: 'b2', extension_count: 0, winner_email: 'unpaid@example.com', winner_paid: false, bid_count: 4 },
    { lot_id: 'l3', lot_number: 3, title: 'Unsold', winning_amount_cents: null, winner_user_id: null, extension_count: 0, winner_email: null, winner_paid: false, bid_count: 0 },
  ];
  const mockReport = () => db.query.mockImplementation(async (sql) => {
    if (/FROM auctions a LEFT JOIN seller_profiles/.test(sql)) return { rows: [{ id: 'a1', title: 'A', seller_type: 'private' }] };
    if (/COUNT\(\*\)::int\s+AS total_lots/.test(sql)) return { rows: [{ total_lots: 3, sold_lots: 2, unsold_lots: 1, total_revenue_cents: 12000, highest_sale_cents: 7000, unique_buyers_count: 2 }] };
    if (/AS winner_paid/.test(sql)) return { rows: lots };
    return { rows: [] };
  });
  test('the seller sees only paid winners\' emails and no buyer account ids', async () => {
    mockReport();
    const r = await generateAuctionReport('a1');
    expect(r.lots.map((l) => l.winner_email)).toEqual(['paid@example.com', null, null]);
    expect(r.lots.map((l) => l.winner_paid)).toEqual([true, false, null]);
    expect(r.lots.every((l) => !('winner_user_id' in l))).toBe(true);
    const sql = db.query.mock.calls.map((c) => c[0]).find((s) => /AS winner_paid/.test(s));
    expect(sql).toMatch(/p\.status = 'paid'/); expect(sql).toMatch(/i\.status = 'paid'/);
  });
  test('staff (includeBuyerContact) see every winner', async () => {
    mockReport();
    const r = await generateAuctionReport('a1', { includeBuyerContact: true });
    expect(r.lots.map((l) => l.winner_email)).toEqual(['paid@example.com', 'unpaid@example.com', null]);
    expect(r.lots[1].winner_user_id).toBe('b2');
  });
  test('the report routes pass the staff view only to Super Admin / finance.view, and the PDF never prints an account id', () => {
    const fs = require('fs');
    const routes = fs.readFileSync('src/routes/auctions.js', 'utf8');
    expect(routes).toMatch(/rbac\.hasPermission\(ctx, 'finance\.view'\)\)\) return 'staff';/);
    expect(routes).toMatch(/generateAuctionReport\(auctionId, \{ includeBuyerContact: viewer === 'staff' \}\)/);
    expect(routes).toMatch(/buildReportPdf\(auctionId, \{ includeBuyerContact: viewer === 'staff' \}\)/);
    const pdf = fs.readFileSync('src/services/pdfGenerationService.js', 'utf8');
    expect(pdf).toMatch(/lot\.winner_email \|\| \(lot\.winner_paid === false \? 'Awaiting payment' : '—'\)/);
    expect(pdf).not.toMatch(/lot\.winner_user_id \? lot\.winner_user_id/);
  });
});

test('the close email to the seller (sent before anyone pays) lists buyers by paddle number, never by email', async () => {
  process.env.SMTP_HOST = 'smtp.test'; process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
  const svc = require('../src/services/operationalCloseEmailService');
  db.query.mockImplementation(async (sql) => {
    if (/AS gross_total_cents/.test(sql)) return { rows: [{ title: 'Estate', id: 'a1', seller_email: 'seller@example.com', gross_total_cents: 12000 }] };
    if (/AS paddle_number/.test(sql)) return { rows: [{ paddle_number: 12, lots_won: 2, total_cents: 9000 }, { paddle_number: null, lots_won: 1, total_cents: 3000 }] };
    if (/unpaid_count/.test(sql)) return { rows: [{ unpaid_count: 3 }] };
    return { rows: [] };
  });
  await svc.sendOperationalCloseEmail('a1');
  const sql = db.query.mock.calls.map((c) => c[0]).find((s) => /AS paddle_number/.test(s));
  expect(sql).not.toMatch(/u\.email/);
  expect(global.__mail.text).toMatch(/Paddle 12 - 2 lot\(s\)/);
  expect(global.__mail.text).toMatch(/Buyer 2 - 1 lot\(s\)/);
  expect(global.__mail.text).toMatch(/shared with you once each buyer has paid/);
  expect(global.__mail.text).not.toMatch(/@example\.com - /);
});

test('seller closeout rosters carry name/email only for buyers who have paid', () => {
  const src = require('fs').readFileSync('src/services/sellerCloseoutService.js', 'utf8');
  const loaders = ['loadBuyerInvoices', 'loadPickupReport', 'loadNoShows'].map((n) => src.slice(src.indexOf('async function ' + n), src.indexOf('return rows;', src.indexOf('async function ' + n))));
  for (const l of loaders) {
    expect(l).toMatch(/CASE WHEN \(EXISTS \(SELECT 1 FROM buyer_auction_invoices pi[\s\S]*pi\.status = 'paid'\)[\s\S]*pp\.status = 'paid'\)\) THEN u\.email END AS buyer_email/);
    expect(l).toMatch(/THEN u\.full_name END AS buyer_name/);
    expect(l).not.toMatch(/u\.email AS buyer_email/);
  }
  expect(src).toMatch(/getPacketData\(auctionId, \{ forSeller: true \}\)/);
});

test('the seller\'s pickup packet hides unpaid buyers\' name, email and phone; the admin packet shows them', async () => {
  const svc = require('../src/services/pickupPacketService');
  const rows = [
    { id: 'i1', invoice_status: 'issued', payment_status: null, combined_paid: false, paddle_number: 7, buyer_user_id: 'b1', buyer_name: 'Ann Unpaid', buyer_email: 'ann@example.com', buyer_phone: '5550001', lot_number: 1, size_category: 'small', amount_cents: 100, total_cents: 100 },
    { id: 'i2', invoice_status: 'issued', payment_status: null, combined_paid: true, paddle_number: 8, buyer_user_id: 'b2', buyer_name: 'Bob Paid', buyer_email: 'bob@example.com', buyer_phone: '5550002', lot_number: 2, size_category: 'small', amount_cents: 100, total_cents: 100 },
  ];
  const mock = () => db.query.mockImplementation(async (sql) => (/FROM auctions WHERE id/.test(sql) ? { rows: [{ id: 'a1', title: 'A' }] } : { rows: rows.map((r) => ({ ...r })) }));
  mock();
  const seller = await svc.getPacketData('a1', { forSeller: true });
  const ann = seller.invoices.find((i) => i.id === 'i1'); const bob = seller.invoices.find((i) => i.id === 'i2');
  expect(ann).toMatchObject({ displayName: 'Paddle 7', email: '—', phone: null, isPaid: false });
  expect(bob).toMatchObject({ email: 'bob@example.com', phone: '5550002', isPaid: true });
  mock();
  const admin = await svc.getPacketData('a1');
  expect(admin.invoices.find((i) => i.id === 'i1')).toMatchObject({ email: 'ann@example.com', phone: '5550001' });
});
