'use strict';

/** The seller's "new message" email (owner 2026-11-10; src/services/sellerInquiryService.js notifySeller). */

jest.mock('../src/db', () => ({ query: async () => { throw new Error('tests pass a runner'); } }));
const svc = require('../src/services/sellerInquiryService');

const seller = { id: 'sp-1', user_id: 'u-1', is_demo: false };
const runner = (row) => ({ query: async () => ({ rows: row ? [row] : [] }) });
function mail() { const sent = []; return { sent, sendEmail: async (m) => { sent.push(m); return { messageId: 'm1' }; } }; }

test('names the item and carries the message, to the seller account address, with a link to the Inquiries', async () => {
  const m = mail();
  const r = await svc.notifySeller({ seller, item: { id: 'i-1', title: 'Blue Glass Vase' }, name: 'Riley', message: 'Is it chipped?' },
    { runner: runner({ email: 'owner@seller.test' }), emailService: m });
  expect(r).toEqual({ sent: true });
  expect(m.sent).toHaveLength(1);
  expect(m.sent[0].to).toBe('owner@seller.test');
  expect(m.sent[0].subject).toBe('New question about your item: Blue Glass Vase');
  expect(m.sent[0].text).toMatch(/Riley[\s\S]*Is it chipped\?[\s\S]*\/seller-storefront\.html\?tab=leads/);
  expect(m.sent[0].html).toMatch(/Open your Inquiries/);
});

test('never includes the buyer\'s email or phone (those stay in the signed-in inbox), and escapes what the buyer typed', async () => {
  const m = mail();
  await svc.notifySeller({ seller, item: null, name: '<b>Ann</b>', message: 'call me 555-201-9999 <script>x</script>' },
    { runner: runner({ email: 'owner@seller.test' }), emailService: m });
  const all = m.sent[0].text + m.sent[0].html;
  expect(all).not.toMatch(/buyer@|@buyer/);
  expect(m.sent[0].html).not.toMatch(/<script>|<b>Ann<\/b>/);
  expect(m.sent[0].subject).toBe('New message from your storefront');
});

test('demo sellers, suspended or missing owners, and mail failures send nothing and never throw', async () => {
  const m = mail();
  expect(await svc.notifySeller({ seller: { ...seller, is_demo: true }, item: null, name: 'A', message: 'B' }, { runner: runner({ email: 'o@s.test' }), emailService: m })).toEqual({ skipped: 'demo' });
  expect(await svc.notifySeller({ seller, item: null, name: 'A', message: 'B' }, { runner: runner(null), emailService: m })).toEqual({ skipped: 'no_address' });
  expect(m.sent).toHaveLength(0);
  const broken = { sendEmail: async () => { throw new Error('smtp down'); } };
  expect(await svc.notifySeller({ seller, item: null, name: 'A', message: 'B' }, { runner: runner({ email: 'o@s.test' }), emailService: broken })).toEqual({ failed: true });
  const unconfigured = { sendEmail: async () => ({ skipped: true }) };
  expect(await svc.notifySeller({ seller, item: null, name: 'A', message: 'B' }, { runner: runner({ email: 'o@s.test' }), emailService: unconfigured })).toEqual({ skipped: 'mail_not_configured' });
});
