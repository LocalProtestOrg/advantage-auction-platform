'use strict';

/**
 * Privacy regression: the full pickup street address must stay hidden until payment is verified.
 * The UNPAID combined-invoice reminder (buildPaymentRequiredEmail) must expose only the approved
 * pre-payment location (city/state) — never the street. The PAID package (buildSuccessPackageEmail)
 * reveals the full address. Pure builders, no DB/network.
 */

const svc = require('../../src/services/combinedReceiptService');

const STREET = '4517 Maplewood Terrace';
const CITY_STATE = 'Nashville, TN';
const ZIP = '37209';
const FULL = STREET + ', ' + CITY_STATE + ', ' + ZIP;

function baseData(pickup) {
  return {
    invoiceNumber: 'AAC-1001',
    auctionTitle: 'Summer Estate Auction',
    buyerEmail: 'buyer@example.com',
    lines: [{ lotNumber: 1, title: 'Porcelain vase', hammerCents: 5000 }],
    summary: { hammerCents: 5000, buyerPremiumCents: 0, salesTaxCents: 0, shippingCents: 0, creditsCents: 0, totalCents: 5000 },
    pickup: pickup,
  };
}

const paidPickup = { address: FULL, areaSummary: CITY_STATE, recommended: 'Sat 10:00 AM', published: 'Sat 9–5' };

describe('UNPAID combined reminder never leaks the full street address', () => {
  for (const reminderNo of [1, 2, 3]) {
    test(`reminder #${reminderNo}: no street/full address; shows city/state only`, () => {
      const { html, text } = svc.buildPaymentRequiredEmail(baseData(paidPickup), { reminderNo });
      for (const body of [html, text]) {
        expect(body).not.toContain(STREET);
        expect(body).not.toContain(FULL);
        expect(body).not.toContain(ZIP);
      }
      // the approved pre-payment location IS present in the HTML, with a "after payment" note
      expect(html).toContain(CITY_STATE);
      expect(html.toLowerCase()).toContain('exact address provided once payment is confirmed');
    });
  }

  test('defensive: even if areaSummary is missing, the street is still never printed while unpaid', () => {
    const { html, text } = svc.buildPaymentRequiredEmail(baseData({ address: FULL, areaSummary: null, published: 'Sat 9–5' }), { reminderNo: 1 });
    expect(html).not.toContain(STREET);
    expect(text).not.toContain(STREET);
  });

  test('no pickup info at all → no crash, no address', () => {
    const { html } = svc.buildPaymentRequiredEmail(baseData({}), { reminderNo: 1 });
    expect(html).not.toContain(STREET);
  });
});

describe('PAID success package reveals the full address (approved reveal)', () => {
  test('paid email shows the full street address + city/state', () => {
    const { html, text } = svc.buildSuccessPackageEmail(baseData(paidPickup));
    expect(html).toContain(FULL);
    expect(text).toContain(STREET);
    expect(html).toContain(CITY_STATE);
  });
});
