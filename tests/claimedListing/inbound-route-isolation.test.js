'use strict';

/**
 * Sasha / Claimed Listing boundary: replies to Claimed Listing outreach use listings+l<key>@reply.advantage.bid and
 * must route to the claimed_listing programme, never to Sasha's company inbox (inbox@reply.advantage.bid).
 */

jest.mock('../../src/db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })) }));
const { routeFor } = require('../../src/services/inboundMail/sesInbound');

const cfg = { replyDomain: 'reply.advantage.bid' };
const key = 'l' + '0123456789abcdef01234567';

describe('Claimed Listing replies never reach Sasha', () => {
  test('listings+l<key>@reply.advantage.bid routes to claimed_listing', () => {
    expect(routeFor(['listings+' + key + '@reply.advantage.bid'], cfg)).toBe('claimed_listing');
  });
  test('case and whitespace do not change the route', () => {
    expect(routeFor(['  Listings+' + key.toUpperCase() + '@Reply.Advantage.Bid '], cfg)).toBe('claimed_listing');
  });
  test('a claimed-listing reply that also copies info@ is still claimed_listing, never company_inbox', () => {
    expect(routeFor(['listings+' + key + '@reply.advantage.bid', 'info@advantage.bid'], cfg)).toBe('claimed_listing');
  });
  test('addressed to BOTH the listing reply key and the company inbox: the outreach programme wins', () => {
    expect(routeFor(['inbox@reply.advantage.bid', 'listings+' + key + '@reply.advantage.bid'], cfg)).toBe('claimed_listing');
    expect(routeFor(['inbox@reply.advantage.bid', 'partner+' + 'a'.repeat(24) + '@reply.advantage.bid'], cfg)).toBe('event_partner');
  });
  test('a forwarded info@ copy of an outreach reply (To/Cc carries the listing reply key) is ignored by Sasha', () => {
    const { ignoreReason } = require('../../src/services/sasha/emailChannel');
    const base = { fromEmail: 'owner@abcestates.com', subject: 'Re: Your Advantage.Bid listing', textBody: 'Yes this is us', headers: {} };
    expect(ignoreReason({ ...base, headers: { to: 'Advantage.Bid Listings <listings+' + key + '@reply.advantage.bid>', cc: 'info@advantage.bid' } })).toBe('outreach_thread');
    expect(ignoreReason({ ...base, headers: { to: 'info@advantage.bid', cc: 'partner+' + 'b'.repeat(24) + '@reply.advantage.bid' } })).toBe('outreach_thread');
    expect(ignoreReason({ ...base, headers: { to: 'info@advantage.bid' } })).toBeNull();
  });
  test('only the exact company inbox address reaches Sasha', () => {
    expect(routeFor(['inbox@reply.advantage.bid'], cfg)).toBe('company_inbox');
    expect(routeFor(['inbox+' + key + '@reply.advantage.bid'], cfg)).not.toBe('company_inbox');
    expect(routeFor(['listings@reply.advantage.bid'], cfg)).not.toBe('company_inbox');
  });
});

describe('Sasha claimed-listing guidance seed (migration 182)', () => {
  const sql = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'db', 'migrations', '182_sasha_claimed_listing_guidance.sql'), 'utf8');
  test('is a single draft row that never overwrites an Owner-edited row', () => {
    expect(sql).toMatch(/'claimed-listing-help'/);
    expect(sql).toMatch(/'all', 'draft'/);
    expect(sql).toMatch(/ON CONFLICT \(slug\) DO NOTHING/);
    expect(sql).not.toMatch(/'approved'/);
  });
  test('tells Sasha claiming is free, gives the phone number, hands off and never issues links or confirms ownership', () => {
    expect(sql).toMatch(/free/);
    expect(sql).toMatch(/\(551\) 655-7050/);
    expect(sql).toMatch(/request_human/);
    expect(sql).toMatch(/Never issue or resend a claim link, never confirm or deny who owns a listing or who was contacted/);
    expect(sql).not.toMatch(/—/);
  });
});
