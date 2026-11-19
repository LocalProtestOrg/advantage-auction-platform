'use strict';

/**
 * Buyer order emails (owner 2026-11-19):
 *  - the permanent refund timing sentence, exact wording, right after "the refund has been issued";
 *  - who to contact: a Professional Seller's PUBLISHED business details (or a Contact Seller link), never a seller's
 *    account email, and nothing at all about a non-professional seller;
 *  - the seller's storefront link;
 *  - a shipment email with the carrier and tracking number the seller entered.
 */
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
const db = require('../src/db');
const { sendEmail } = require('../src/services/emailService');
const notifier = require('../src/services/marketplaceOrderNotifier');
const { REFUND_TIMING_SENTENCE } = require('../src/lib/refundCopy');
const fs = require('fs');
const path = require('path');

const SENTENCE = 'Please allow this refund 3 - 5 business days to reflect on your account, depending on your bank.';

const order = (over = {}) => ({
  id: 'o1', order_number: 'MO-000001', marketplace_item_id: '11111111-1111-4111-8111-111111111111', item_title: 'Brass Lamp', quantity: 1,
  unit_price_cents: 300, item_price_cents: 300, shipping_cents: 200, tax_cents: 33, total_charge_cents: 533, fulfillment_method: 'shipping',
  tracking_carrier: 'USPS', tracking_number: '9400111899223344556677', seller_name: 'Timeless Treasures', seller_type_now: 'retail_gallery_studio',
  seller_storefront: { public_phone: '(201) 555-0100', public_email: 'shop@timeless.example', website: 'https://timeless.example/' },
  storefront_slug: 'timeless-treasures', storefront_published: true, seller_meta_public_phone: null, seller_meta_website: null,
  seller_email: 'owner.private@gmail.example', buyer_email: 'buyer@example.com', buyer_name: 'Bea', ...over });
const send = async (fn, o) => { db.query.mockResolvedValueOnce({ rows: [o] }); await notifier[fn]('o1'); return sendEmail.mock.calls[sendEmail.mock.calls.length - 1][0]; };

beforeEach(() => { db.query.mockReset(); sendEmail.mockClear(); });

describe('the refund timing sentence', () => {
  test('the shared wording is exact', () => { expect(REFUND_TIMING_SENTENCE).toBe(SENTENCE); });
  test.each(['sendRefunded', 'sendConflictRefunded'])('%s places it immediately after the statement that the refund has been issued', async (fn) => {
    const m = await send(fn, order());
    expect(m.html).toMatch(/has been issued to your original payment method\. Please allow this refund 3 - 5 business days to reflect on your account, depending on your bank\.<\/p>/);
    expect(m.text).toContain('has been issued to your original payment method' + (fn === 'sendRefunded' ? ' for order MO-000001 (Brass Lamp). ' : '. ') + SENTENCE);
    expect(m.html + m.text).not.toMatch(/5.10 business days|has posted|has been credited/i);
  });
  test('the sentence is written in one place only; templates import it', () => {
    const hits = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) return walk(f);
      if (/\.js$/.test(e.name) && fs.readFileSync(f, 'utf8').includes('3 - 5 business days')) hits.push(path.basename(f));
    });
    walk(path.join(__dirname, '..', 'src'));
    expect(hits).toEqual(['refundCopy.js']);
  });
});

describe('who to contact', () => {
  test('a Professional Seller with published business details is the first contact, with the storefront linked', async () => {
    const m = await send('sendPaid', order());
    expect(m.html).toContain('Questions about your item?</b> Contact Timeless Treasures: (201) 555-0100');
    expect(m.html).toContain('mailto:shop@timeless.example');
    expect(m.html).toContain('href="https://timeless.example/"');
    expect(m.html).toContain('<a href="https://bid.advantage.bid/pro/timeless-treasures" style="color:#2563eb">Timeless Treasures</a>');
    expect(m.html).toContain('For payments, refunds, disputes or anything the seller cannot resolve, contact Advantage.Bid');
    expect(m.html + m.text).not.toContain('owner.private@gmail.example');
  });
  test('with nothing published, the buyer gets a Contact Seller link and never the account email', async () => {
    const m = await send('sendRefunded', order({ seller_storefront: {}, storefront_published: true }));
    expect(m.html).toContain('<a href="https://bid.advantage.bid/item.html?id=11111111-1111-4111-8111-111111111111" style="color:#2563eb">Contact Seller</a>');
    expect(m.html + m.text).not.toContain('owner.private@gmail.example');
  });
  test('details on an unpublished storefront are not public, so they are not used and the shop is not linked', async () => {
    const m = await send('sendPaid', order({ storefront_published: false }));
    expect(m.html + m.text).not.toMatch(/555-0100|shop@timeless\.example|timeless\.example\/|\/pro\/timeless-treasures/);
    expect(m.html).toContain('>Contact Seller</a>');
  });
  test('a non-professional seller is never disclosed: only Advantage.Bid is offered', async () => {
    for (const t of ['private', 'business', 'other', null]) {
      const m = await send('sendShipped', order({ seller_type_now: t }));
      expect(m.html).toContain('Need help? Contact Advantage.Bid:');
      expect(m.html + m.text).not.toMatch(/555-0100|shop@timeless\.example|timeless\.example|Contact Seller|\/pro\/|owner\.private/);
    }
  });
  test('published values cannot inject markup or a non-web link', async () => {
    const m = await send('sendPaid', order({ seller_storefront: { public_email: 'a@b.c"><script>', website: 'javascript:alert(1)', public_phone: '<b>201</b>' } }));
    expect(m.html).not.toMatch(/<script>|javascript:|<b>201/);
  });
});

describe('the shipment email', () => {
  test('it carries the carrier and tracking number the seller entered', async () => {
    const m = await send('sendShipped', order());
    expect(m.to).toBe('buyer@example.com');
    expect(m.subject).toBe('Your order has shipped: Brass Lamp (MO-000001)');
    expect(m.html).toContain('<b>Carrier:</b> USPS');
    expect(m.html).toContain('<b>Tracking number:</b> 9400111899223344556677');
  });
  test('nothing is sent for a pickup order or without both the carrier and the tracking number', async () => {
    for (const over of [{ fulfillment_method: 'pickup' }, { tracking_number: null }, { tracking_carrier: '' }, { buyer_email: null }]) {
      db.query.mockResolvedValueOnce({ rows: [order(over)] });
      await notifier.sendShipped('o1');
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });
  test('marking an order shipped sends it after the step is saved, and only for that step', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'marketplaceOrderService.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function updateFulfillment'), src.indexOf('// ── Read models'));
    expect(fn).toMatch(/const view = await withTransaction/);
    expect(fn).toMatch(/if \(action === 'shipped'\) \{ try \{ await require\('\.\/marketplaceOrderNotifier'\)\.sendShipped\(orderId\); \} catch/);
    expect(fn.indexOf('sendShipped')).toBeGreaterThan(fn.lastIndexOf('sellerOrderView'));
  });
});

test('buyer order emails use no long dashes', async () => {
  for (const fn of ['sendPaid', 'sendRefunded', 'sendConflictRefunded', 'sendShipped']) {
    const m = await send(fn, order());
    expect(m.subject + m.html + m.text).not.toMatch(/[–—]/);
  }
});
