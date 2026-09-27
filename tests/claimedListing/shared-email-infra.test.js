'use strict';

/**
 * Claimed Listing on the shared email infrastructure (audit 2026-09-27):
 *   - the SES-assigned message id is captured, so bounce/complaint/delivery feedback matches the listing message;
 *   - a Claimed Listing opt-out also stops Event Partner outreach to the same address;
 *   - an unmatched inbound reply can never roll back a STOP suppression through a failed audit insert.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: mockSendMail }) }));
jest.mock('../../src/db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })) }));
const db = require('../../src/db');

describe('SES message id capture', () => {
  let emailService;
  const saved = {};
  beforeAll(() => {
    for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM']) saved[k] = process.env[k];
    Object.assign(process.env, { SMTP_HOST: 'smtp.test.invalid', SMTP_USER: 'user', SMTP_PASS: 'test-only-password', EMAIL_FROM: 'notifications@advantage.bid' });
    jest.isolateModules(() => { emailService = require('../../src/services/emailService'); });
  });
  afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  test('the id SES assigns (from "250 Ok <id>") is returned alongside the local Message-ID', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: '<3f2a@advantage.bid>', response: '250 Ok 010001929abc0def-11111111-2222-3333-4444-555555555555-000000' });
    const res = await emailService.sendEmail({ to: 'owner@example.com', subject: 's', html: '<p>x</p>', text: 'x', mailStream: 'claimed_listing' });
    expect(res.sesMessageId).toBe('010001929abc0def-11111111-2222-3333-4444-555555555555-000000');
    expect(res.messageId).toBe('<3f2a@advantage.bid>');
  });
  test('a transport that does not answer like SES leaves sesMessageId null', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: '<3f2b@advantage.bid>', response: '250 2.0.0 queued' });
    const res = await emailService.sendEmail({ to: 'owner@example.com', subject: 's', html: '<p>x</p>' });
    expect(res.sesMessageId).toBeNull();
  });
  test('Claimed Listing stores the SES id when there is one (both send paths)', () => {
    const s = read('src/services/claimedListings/outreachSender.js');
    expect((s.match(/res\.sesMessageId \|\|/g) || []).length).toBe(2);
  });
});

describe('cross-programme suppression', () => {
  const suppression = require('../../src/services/eventPartners/partnerSuppressionService');
  beforeEach(() => db.query.mockReset());

  test('an address that opted out of Claimed Listing outreach is suppressed for Event Partner outreach', async () => {
    db.query.mockImplementation(async (sql) => (/FROM listing_outreach_suppressions/.test(sql) ? { rows: [{ reason: 'unsubscribe' }] } : { rows: [] }));
    expect(await suppression.isSuppressed('mary@abcestates.com')).toEqual({ suppressed: true, scope: 'claimed_listing', reason: 'unsubscribe' });
  });
  test('a clean address is still mailable', async () => {
    db.query.mockImplementation(async () => ({ rows: [] }));
    expect((await suppression.isSuppressed('mary@abcestates.com')).suppressed).toBe(false);
  });
  test('Claimed Listing still reads the global, listing and Event Partner lists before any send', () => {
    const s = read('src/services/claimedListings/suppressionService.js');
    for (const t of ['email_suppressions', 'listing_outreach_suppressions', 'event_partner_suppressions']) expect(s).toContain('FROM ' + t);
  });
});

describe('inbound replies', () => {
  test('the audit row for a reply always has an entity id, so it cannot roll back a STOP', () => {
    const s = read('src/services/claimedListings/inboundService.js');
    expect(s).toMatch(/entityId: orgId \|\| '00000000-0000-0000-0000-000000000000'/);
    expect(s).not.toMatch(/entityId: orgId,/);
  });
});
