'use strict';

/**
 * Paid-sale seller notification content (owner requirements 2026-10-16; roadmap §8.1, milestone N). The seller notice is
 * rendered from the order's fixed purchase snapshot by storefrontNotificationService and delivered through the outbox;
 * marketplaceOrderNotifier.sendPaid now sends only the buyer's receipt.
 */
const mockSent = [];
const ROW = {
  id: 'o1', order_number: 'MO-000123', item_title: 'Walnut Sideboard', item_price_cents: 45000, shipping_cents: 2500, tax_cents: 0,
  total_charge_cents: 47500, platform_fee_bps: 1100, platform_fee_cents: 4950, seller_proceeds_cents: 42550, fulfillment_method: 'shipping',
  seller_name: 'Nora Estate Sales', seller_email: 'owner@nora.example', buyer_email: 'bea.private@buyer.example', buyer_name: 'Bea Buyerton',
  ship_to: { line1: '77 Secret Lane', city: 'Austin', state: 'TX', postal_code: '78701' },
  item_snapshot: { title: 'Walnut Sideboard', description: 'Solid walnut, c. 1950, minor wear.', thumbnail_url: 'https://img.example/sideboard.jpg', inventory_number: 'HH-1042' },
};
const mockRow = ROW;
jest.mock('../src/db', () => ({ query: jest.fn(async () => ({ rows: [mockRow] })) }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async (m) => { mockSent.push(m); return { messageId: 'x' }; }) }));

const notifier = require('../src/services/marketplaceOrderNotifier');
const { renderSalePaid } = require('../src/services/storefrontNotificationService');

describe('seller "Item sold" notice', () => {
  test('names the item, inventory number, price, 11% fee, proceeds, method, next step, thumbnail and link — never buyer contact or address', () => {
    const m = renderSalePaid(ROW);
    const all = m.subject + m.html + m.text;
    for (const s of ['Walnut Sideboard', 'HH-1042', 'MO-000123', '$450.00', '11% of the item price', '$49.50', '$425.50', 'Shipping',
      'record the carrier and tracking number', '/seller-orders.html', 'https://img.example/sideboard.jpg', 'Solid walnut', 'Estimated proceeds',
      'not your final deposit']) {
      expect(all).toContain(s);
    }
    for (const bad of [/bea\.private/, /Bea Buyerton/, /Secret Lane/, /78701/]) expect(all).not.toMatch(bad);
  });
  test('pickup orders get the pickup next step; a non-https thumbnail is not embedded; escaping holds', () => {
    const m = renderSalePaid({ ...ROW, fulfillment_method: 'pickup', item_snapshot: { title: '<b>Lamp</b>', thumbnail_url: 'http://insecure.example/x.jpg' } });
    expect(m.html).toContain('Ready for Pickup');
    expect(m.html).not.toContain('insecure.example');
    expect(m.html).toContain('&lt;b&gt;Lamp&lt;/b&gt;');
  });
  test('sendPaid now sends only the buyer receipt (the seller notice goes through the outbox)', async () => {
    mockSent.length = 0;
    await notifier.sendPaid('o1');
    expect(mockSent.map((m) => m.to)).toEqual(['bea.private@buyer.example']);
  });
});
