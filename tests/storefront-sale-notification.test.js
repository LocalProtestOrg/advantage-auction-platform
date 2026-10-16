'use strict';

/**
 * Paid-sale seller notification content (owner requirement 2026-10-16; roadmap §8.1): the seller's "Item sold" email names
 * the item, order, confirmed price, fulfilment method, next step and a secure dashboard link — and NEVER the buyer's name,
 * email, phone or ship-to address (those stay behind the authenticated, role-shaped seller dashboard).
 */
const mockSent = [];
const ROW = {
  id: 'o1', order_number: 'MO-000123', item_title: 'Walnut Sideboard', item_price_cents: 45000, shipping_cents: 2500, tax_cents: 0,
  total_charge_cents: 47500, seller_proceeds_cents: 40050, fulfillment_method: 'shipping', seller_name: 'Nora Estate Sales',
  seller_email: 'owner@nora.example', buyer_email: 'bea.private@buyer.example', buyer_name: 'Bea Buyerton',
  ship_to: { line1: '77 Secret Lane', city: 'Austin', state: 'TX', postal_code: '78701' },
  item_snapshot: { description: 'Solid walnut, c. 1950, minor wear.', thumbnail_url: 'https://img.example/sideboard.jpg' },
};
let mockRow = ROW;
jest.mock('../src/db', () => ({ query: jest.fn(async () => ({ rows: [mockRow] })) }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async (m) => { mockSent.push(m); return { messageId: 'x' }; }) }));

const notifier = require('../src/services/marketplaceOrderNotifier');

describe('seller "Item sold" email', () => {
  beforeEach(() => { mockSent.length = 0; });
  test('names the item, order, price, method, next step, thumbnail and link — never buyer contact or address', async () => {
    await notifier.sendPaid('o1');
    const seller = mockSent.find((m) => m.to === 'owner@nora.example');
    expect(seller).toBeDefined();
    const all = seller.subject + seller.html + seller.text;
    for (const s of ['Walnut Sideboard', 'MO-000123', '$450.00', 'Shipping', 'record the carrier and tracking number', '/seller-orders.html',
      'https://img.example/sideboard.jpg', 'Solid walnut', 'Estimated proceeds']) expect(all).toContain(s);
    for (const bad of [/bea\.private/, /Bea Buyerton/, /Secret Lane/, /78701/]) expect(all).not.toMatch(bad);
    // the buyer still gets their own receipt
    expect(mockSent.find((m) => m.to === 'bea.private@buyer.example')).toBeDefined();
  });
  test('pickup orders get the pickup next step; a non-https thumbnail is not embedded', async () => {
    mockRow = { ...ROW, fulfillment_method: 'pickup', ship_to: null, item_snapshot: { thumbnail_url: 'http://insecure.example/x.jpg' } };
    await notifier.sendPaid('o1');
    const seller = mockSent.find((m) => m.to === 'owner@nora.example');
    expect(seller.html).toContain('Ready for Pickup');
    expect(seller.html).not.toContain('insecure.example');
    expect(seller.html + seller.text).not.toMatch(/bea\.private|Bea Buyerton/);
    mockRow = ROW;
  });
});
