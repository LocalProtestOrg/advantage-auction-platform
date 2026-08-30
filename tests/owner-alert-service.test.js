'use strict';

/**
 * Owner operational SMS alerts (auction submitted / estate sale submitted / marketing package purchased).
 *
 * Mix of behavioral unit tests (mocked db + smsService) and source-level assertions that the three
 * triggers are wired to authoritative, deduped state transitions — matching the repo's estate-sale test
 * style. No real Twilio / DB / network. Cases A-P map to the task's acceptance list.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// Mock the Twilio transport + db BEFORE requiring the service.
jest.mock('../src/services/smsService', () => ({ sendSMS: jest.fn().mockResolvedValue({ sid: 'SM_test' }) }));
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { sendSMS } = require('../src/services/smsService');
const db = require('../src/db');
const svc = require('../src/services/ownerAlertService');

const OWNER = '+15551230000';
beforeEach(() => {
  jest.clearAllMocks();
  process.env.OWNER_ALERT_PHONE_E164 = OWNER;
  delete process.env.OWNER_ALERT_PHONE_AUCTIONS;
  delete process.env.OWNER_ALERT_PHONE_ESTATE_SALES;
  delete process.env.OWNER_ALERT_PHONE_MARKETING;
  delete process.env.APP_BASE_URL;
});

// ── Config + recipient routing ──────────────────────────────────────────────
describe('config + recipient routing', () => {
  test('E.164 validation', () => {
    expect(svc.isE164('+15551230000')).toBe(true);
    expect(svc.isE164('15551230000')).toBe(false);   // no '+'
    expect(svc.isE164('+1555')).toBe(false);          // too short
    expect(svc.isE164('+0555123456')).toBe(false);    // leading 0 country digit
    expect(svc.isE164('')).toBe(false);
    expect(svc.isE164(null)).toBe(false);
  });
  test('recipientsFor falls back to the primary owner number for every type', () => {
    for (const t of Object.values(svc.ALERT_TYPES)) {
      expect(svc.recipientsFor(t)).toEqual([OWNER]);
    }
  });
  test('per-team override wins when set (role-routing ready), others still fall back', () => {
    process.env.OWNER_ALERT_PHONE_AUCTIONS = '+15559990000';
    expect(svc.recipientsFor(svc.ALERT_TYPES.AUCTION_SUBMITTED)).toEqual(['+15559990000']);
    expect(svc.recipientsFor(svc.ALERT_TYPES.ESTATE_SALE_SUBMITTED)).toEqual([OWNER]);
  });
  test('no number configured => not configured (alerts skip, never fabricated)', () => {
    process.env.OWNER_ALERT_PHONE_E164 = '';
    expect(svc.ownerAlertConfigured()).toBe(false);
    expect(svc.recipientsFor(svc.ALERT_TYPES.AUCTION_SUBMITTED)).toEqual([]);
  });
});

// ── Message composition (N: seller email; O: admin URL) ─────────────────────
describe('message composition', () => {
  const url = 'https://bid.advantage.bid/admin/moderation.html';
  test('N: seller email appears in all three message shapes', () => {
    const a = svc.buildAuctionSubmittedMessage({ title: 'T', sellerName: 'S', sellerEmail: 'a@x.com', url });
    const e = svc.buildEstateSaleSubmittedMessage({ title: 'T', sellerName: 'S', sellerEmail: 'b@x.com', url });
    const m = svc.buildMarketingPackageMessage({ packageName: 'P', sellerName: 'S', sellerEmail: 'c@x.com', url });
    expect(a).toContain('Email: a@x.com');
    expect(e).toContain('Email: b@x.com');
    expect(m).toContain('Email: c@x.com');
    expect(a).toContain('Auction submitted for review');
    expect(e).toContain('Estate sale submitted for review');
    expect(m).toContain('Marketing package purchased');
  });
  test('email line still present (explicit placeholder) when email is missing', () => {
    const a = svc.buildAuctionSubmittedMessage({ title: 'T', sellerName: 'S', sellerEmail: '', url });
    expect(a).toContain('Email: (not available)');
  });
  test('O: admin URL is an Advantage.Bid-controlled route, id is URL-encoded', () => {
    const u = svc.adminUrl('/admin/event-detail.html', 'abc 123/../x');
    expect(u.startsWith('https://bid.advantage.bid/admin/')).toBe(true);
    expect(u).toBe('https://bid.advantage.bid/admin/event-detail.html?id=abc%20123%2F..%2Fx');
  });
  test('untrusted text is sanitized (newlines stripped, ampersand kept, length capped)', () => {
    expect(svc.sanitizeField('Smith & Co.\n\nInjected line')).toBe('Smith & Co. Injected line');
    expect(svc.sanitizeField('x'.repeat(200)).length).toBeLessThanOrEqual(80);
    // no blank-line injection possible in the composed message
    const m = svc.buildMarketingPackageMessage({ packageName: 'P\n\nX', sellerName: 'A\nB', sellerEmail: 'e@x.com', eventTitle: 'E\n\nvil', url });
    expect(m).not.toMatch(/\n\n\n/);
    expect(m).toContain('Package: P X');
    expect(m).toContain('Event: E vil');
  });
  test('optional Event line only rendered when an event title is supplied', () => {
    const withEv = svc.buildMarketingPackageMessage({ packageName: 'P', sellerEmail: 'e@x.com', eventTitle: 'Spring', url });
    const without = svc.buildMarketingPackageMessage({ packageName: 'P', sellerEmail: 'e@x.com', url });
    expect(withEv).toContain('Event: Spring');
    expect(without).not.toContain('Event:');
  });
});

// ── Transport behavior ──────────────────────────────────────────────────────
describe('sendOwnerAlert transport', () => {
  test('sends once to the configured recipient', async () => {
    const r = await svc.sendOwnerAlert(svc.ALERT_TYPES.AUCTION_SUBMITTED, 'hello');
    expect(sendSMS).toHaveBeenCalledTimes(1);
    expect(sendSMS).toHaveBeenCalledWith({ to: OWNER, message: 'hello' });
    expect(r).toMatchObject({ attempted: 1, sent: 1, failed: 0, skipped: false });
  });
  test('skips (no send) when unconfigured', async () => {
    process.env.OWNER_ALERT_PHONE_E164 = '';
    const r = await svc.sendOwnerAlert(svc.ALERT_TYPES.AUCTION_SUBMITTED, 'hello');
    expect(sendSMS).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skipped: true, reason: 'not_configured' });
  });
  test('M: provider failure is swallowed (never throws); reports failed count', async () => {
    sendSMS.mockRejectedValueOnce(new Error('twilio down'));
    const r = await svc.sendOwnerAlert(svc.ALERT_TYPES.AUCTION_SUBMITTED, 'hello');
    expect(r).toMatchObject({ attempted: 1, sent: 0, failed: 1, skipped: false });
  });
});

// ── Notify functions (context load + send) ──────────────────────────────────
describe('notifyOwnerAuctionSubmitted', () => {
  test('C: a genuine submission sends exactly ONE SMS with title, seller, email, review URL', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ title: 'Maplewood Estate', seller_name: 'Heritage & Home', seller_email: 'seller@example.com' }] });
    const r = await svc.notifyOwnerAuctionSubmitted('auc-1');
    expect(sendSMS).toHaveBeenCalledTimes(1);
    const msg = sendSMS.mock.calls[0][0].message;
    expect(msg).toContain('Auction submitted for review');
    expect(msg).toContain('Maplewood Estate');
    expect(msg).toContain('Seller: Heritage & Home');
    expect(msg).toContain('Email: seller@example.com');
    expect(msg).toContain('https://bid.advantage.bid/admin/moderation.html');
    expect(r).toMatchObject({ sent: 1 });
  });
  test('no SMS when unconfigured; no crash when the auction is missing', async () => {
    process.env.OWNER_ALERT_PHONE_E164 = '';
    await svc.notifyOwnerAuctionSubmitted('auc-1');
    expect(sendSMS).not.toHaveBeenCalled();
    process.env.OWNER_ALERT_PHONE_E164 = OWNER;
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await svc.notifyOwnerAuctionSubmitted('missing');
    expect(sendSMS).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skipped: true, reason: 'not_found' });
  });
  test('M: a DB/provider error never throws out of the notify function', async () => {
    db.query.mockRejectedValueOnce(new Error('db boom'));
    await expect(svc.notifyOwnerAuctionSubmitted('auc-1')).resolves.toBeTruthy();
  });
});

describe('notifyOwnerEstateSaleSubmitted', () => {
  test('G: sends ONE SMS with company, email, and per-event admin review URL', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ title: 'Midtown Estate Sale', org_name: 'Example Estate Sales', seller_email: 'host@example.com', owner_name: 'Pat' }] });
    await svc.notifyOwnerEstateSaleSubmitted('ev-9');
    expect(sendSMS).toHaveBeenCalledTimes(1);
    const msg = sendSMS.mock.calls[0][0].message;
    expect(msg).toContain('Estate sale submitted for review');
    expect(msg).toContain('Midtown Estate Sale');
    expect(msg).toContain('Seller: Example Estate Sales');
    expect(msg).toContain('Email: host@example.com');
    expect(msg).toContain('https://bid.advantage.bid/admin/event-detail.html?id=ev-9');
  });
});

describe('notifyOwnerMarketingPackagePurchased', () => {
  test('K: a successful purchase sends ONE SMS with package + buyer email', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ email: 'buyer@example.com', contact_email: null, full_name: 'Jamie Buyer' }] });
    await svc.notifyOwnerMarketingPackagePurchased({ userId: 'u-1', packageName: 'Estate Sale Promotion' });
    expect(sendSMS).toHaveBeenCalledTimes(1);
    const msg = sendSMS.mock.calls[0][0].message;
    expect(msg).toContain('Marketing package purchased');
    expect(msg).toContain('Package: Estate Sale Promotion');
    expect(msg).toContain('Email: buyer@example.com');
    expect(msg).toContain('https://bid.advantage.bid/admin/users.html');
  });
});

// ── P: no secret / recipient / credential leakage ───────────────────────────
describe('P: no credential or recipient exposure', () => {
  test('returned result objects never contain the phone number or a message body', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ title: 'T', seller_name: 'S', seller_email: 'a@x.com' }] });
    const r = await svc.notifyOwnerAuctionSubmitted('auc-1');
    const json = JSON.stringify(r);
    expect(json).not.toContain(OWNER);
    expect(json).not.toMatch(/Email:/);
    expect(Object.keys(r).sort()).toEqual(['attempted', 'failed', 'sent', 'skipped']);
  });
  test('the service source hardcodes NO phone number and NO Twilio credential', () => {
    const src = read('src', 'services', 'ownerAlertService.js');
    expect(src).not.toMatch(/\+\d{11,15}/);                 // no literal E.164 number
    expect(src).not.toMatch(/AC[a-f0-9]{32}/i);             // no Twilio SID
    expect(src).toMatch(/process\.env\.OWNER_ALERT_PHONE_E164/); // config-driven only
    expect(src).not.toMatch(/\+15516557050/);               // NOT the public business phone
  });
});

// ── Trigger wiring (authoritative, deduped) — source-level ──────────────────
describe('trigger wiring is bound to authoritative, deduped transitions', () => {
  const auctionSrc = read('src', 'services', 'auctionService.js');
  const estateSrc = read('src', 'services', 'estateSalePromotionService.js');
  const eventsSrc = read('src', 'services', 'eventsService.js');

  test('A/B/C/D/E: auction alert fires only on the transition INTO submitted', () => {
    // enteredSubmitted is a genuine state change to 'submitted' (not a draft create or a plain edit).
    expect(auctionSrc).toMatch(/const enteredSubmitted = changed\.state && changed\.state\.to === 'submitted'/);
    // the alert call is guarded by that transition
    expect(auctionSrc).toMatch(/if \(enteredSubmitted\) \{\s*ownerAlertService\.notifyOwnerAuctionSubmitted\(auctionId\)\.catch/);
  });
  test('F/G/H: estate-sale alert lives ONLY in the paid submit path, after the guarded transition', () => {
    // submit sets status='submitted' then alerts; imported/scraped events + the free organizer path do not.
    expect(estateSrc).toMatch(/UPDATE events SET status='submitted'[\s\S]*?ownerAlertService\.notifyOwnerEstateSaleSubmitted\(out\.id\)\.catch/);
    // createEstateSale (draft) must NOT alert
    const createBlock = estateSrc.slice(estateSrc.indexOf('async function createEstateSale'), estateSrc.indexOf('async function submitEstateSale'));
    expect(createBlock).not.toMatch(/notifyOwnerEstateSaleSubmitted/);
    // the free organizer path (eventsService) is not wired to owner SMS at all (imports excluded)
    expect(eventsSrc).not.toMatch(/ownerAlertService/);
  });
  test('H: the event importer does not emit owner SMS (no firehose)', () => {
    const importDir = path.join(__dirname, '..', 'src', 'services', 'eventImport');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const files = walk(importDir).filter((f) => f.endsWith('.js'));
    for (const f of files) expect(fs.readFileSync(f, 'utf8')).not.toMatch(/ownerAlertService/);
  });
  test('I/J/K/L: marketing alert fires ONLY on the pending->paid webhook transition', () => {
    // guarded by res.transitioned (checkout started / payment failed / duplicate webhook never reach here)
    expect(estateSrc).toMatch(/if \(res\.transitioned && userId\) \{[\s\S]*?ownerAlertService\.notifyOwnerMarketingPackagePurchased/);
    // NOT in createCheckoutSession (checkout started)
    const checkoutBlock = estateSrc.slice(estateSrc.indexOf('async function createCheckoutSession'), estateSrc.indexOf('async function handleCheckoutCompleted'));
    expect(checkoutBlock).not.toMatch(/notifyOwnerMarketingPackagePurchased/);
  });
  test('all trigger call-sites are best-effort (.catch) so SMS can never break the seller action', () => {
    expect(auctionSrc).toMatch(/notifyOwnerAuctionSubmitted\(auctionId\)\.catch\(\(\) => \{\}\)/);
    expect(estateSrc).toMatch(/notifyOwnerEstateSaleSubmitted\(out\.id\)\.catch\(\(\) => \{\}\)/);
    expect(estateSrc).toMatch(/notifyOwnerMarketingPackagePurchased\([^)]*\)\.catch\(\(\) => \{\}\)/);
  });
});
