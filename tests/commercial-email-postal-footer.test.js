'use strict';

/**
 * Every commercial (marketing or sales) email carries Advantage.Bid's postal address in its footer, as US anti-spam law
 * (CAN-SPAM) requires (baseline audit 2026-11-06). Listing outreach already required it (sendGate); these are the others.
 */
const company = require('../src/lib/companyContact');

const ADDRESS = '300 Communipaw Ave. #137, Jersey City, NJ 07304';

test('one source for the address', () => {
  expect(company.POSTAL_ADDRESS).toBe(ADDRESS);
  expect(company.POSTAL_LINE).toBe('Advantage.Bid, ' + ADDRESS);
});

test('local event alerts and digests (marketing list)', () => {
  const t = require('../src/services/marketingEmailTemplate');
  const ev = { title: 'Spring Estate Sale', kind: 'estate_sale', city: 'Houston', state: 'TX', url: 'https://bid.advantage.bid/event.html?id=1' };
  for (const r of [t.buildLocalEventAlert(ev, { unsubscribeUrl: 'https://u' }), t.buildLocalEventDigest([ev, ev], { unsubscribeUrl: 'https://u' })]) {
    expect(r.html).toContain(ADDRESS);
    expect(r.text).toContain(ADDRESS);
  }
});

test('Professional Seller follower announcements', () => {
  const r = require('../src/services/followerEmails').buildFollowerEventEmail(
    { company_name: 'Acme Auctions', title: 'Fall Auction', kind: 'auction', event_url: 'https://bid.advantage.bid/event.html?id=2' },
    { toAddress: 'f@example.com', unsubscribeUrl: 'https://u?token=x' });
  expect(r.html).toContain(ADDRESS);
  expect(r.text).toContain(ADDRESS);
});

test('Event Partner invitations: added when the approved template lacks it, never twice', () => {
  const { withPostalFooter } = require('../src/services/eventPartners/outreachSendService');
  const a = withPostalFooter({ subject: 's', text: 'Hello', html: '<html><body><p>Hello</p></body></html>' });
  expect(a.text).toContain(ADDRESS);
  expect(a.html).toMatch(new RegExp(ADDRESS.replace(/[.#]/g, '\$&') + '</p></body>'));
  const b = withPostalFooter(a);
  expect(b.text.split(ADDRESS).length).toBe(2);
  expect(b.html.split(ADDRESS).length).toBe(2);
});

test('sales representative emails carry it in the signature', () => {
  const s = require('../src/services/salesOutreachService');
  const identity = { displayName: 'Pat Rep', replyTo: 'pat@advantage.bid' };
  expect(s.signatureText(identity)).toContain(ADDRESS);
  expect(s.renderHtml('Hello', identity)).toContain(ADDRESS);
});
