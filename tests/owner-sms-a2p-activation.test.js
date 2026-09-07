'use strict';

/**
 * Owner Operational SMS — Twilio A2P activation + actionable alerts.
 * Covers: Messaging-Service (A2P) transport preference + fallback + safe-missing-config, durable
 * idempotency (owner_alert_log dedup → one successful SMS per logical event, retry after failure),
 * authoritative package identity ($499 supported, not price-inferred), direct admin destinations,
 * seller-email inclusion, and failure isolation. No live Twilio / DB / network.
 */

const mockCreate = jest.fn(async (params) => ({
  sid: 'SM_' + (params.messagingServiceSid ? 'ms' : 'from'),
  status: 'accepted',
}));
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: mockCreate } })));

// Stateful owner_alert_log + context store.
const store = { log: new Map(), ctx: {} };
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');

function route(sql, params) {
  const s = String(sql);
  // owner_alert_log dedup INSERT ... ON CONFLICT DO NOTHING RETURNING id
  if (/INSERT INTO owner_alert_log/.test(s)) {
    const dedup = params[4];   // (alert_type, entity_type, entity_id, recipient_hash, dedup_key, ...)
    if (store.log.has(dedup)) return { rows: [] };                 // conflict → no row returned
    const id = 'row-' + (store.log.size + 1);
    store.log.set(dedup, { id, status: 'pending' });
    return { rows: [{ id }] };
  }
  if (/SELECT id, status FROM owner_alert_log WHERE dedup_key/.test(s)) {
    const row = store.log.get(params[0]);
    return { rows: row ? [{ id: row.id, status: row.status }] : [] };
  }
  if (/UPDATE owner_alert_log SET status='sent'/.test(s)) { setStatus(params[0], 'sent'); return { rows: [] }; }
  if (/UPDATE owner_alert_log SET status='failed'/.test(s)) { setStatus(params[0], 'failed'); return { rows: [] }; }
  if (/UPDATE owner_alert_log SET status='skipped'/.test(s)) { setStatus(params[0], 'skipped'); return { rows: [] }; }
  if (/UPDATE owner_alert_log SET status='pending'/.test(s)) { setStatus(params[0], 'pending'); return { rows: [] }; }
  // context loaders
  if (/FROM auctions a/.test(s)) return { rows: [store.ctx.auction] };
  if (/FROM one_time_purchases WHERE id/.test(s)) return { rows: store.ctx.purchase ? [store.ctx.purchase] : [] };
  if (/FROM users WHERE id/.test(s)) return { rows: store.ctx.user ? [store.ctx.user] : [] };
  if (/FROM events e/.test(s)) return { rows: [store.ctx.event] };
  return { rows: [] };
}
function setStatus(id, status) { for (const r of store.log.values()) if (r.id === id) r.status = status; }

const OWNER = '+15551230000';
const sms = require('../src/services/smsService');
const svc = require('../src/services/ownerAlertService');
beforeEach(() => {
  store.log.clear();
  store.ctx = {
    auction: { title: 'Maplewood Estate', seller_name: 'Heritage & Home', seller_email: 'seller@example.com' },
    user: { email: 'buyer@example.com', contact_email: null, full_name: 'Jamie Buyer' },
    purchase: null,
    event: { title: 'Midtown Estate Sale', org_name: 'Example Estate Sales', seller_email: 'host@example.com', owner_name: 'Pat' },
  };
  mockCreate.mockClear();
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => route(sql, params));
  process.env.OWNER_ALERT_PHONE_E164 = OWNER;
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
  delete process.env.TWILIO_FROM_NUMBER;
});

// ── Twilio A2P transport ─────────────────────────────────────────────────────
describe('smsService — A2P Messaging Service preference', () => {
  test('prefers the registered Messaging Service SID when configured', async () => {
    const r = await sms.sendSMS({ to: OWNER, message: 'hi' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const params = mockCreate.mock.calls[0][0];
    expect(params.messagingServiceSid).toBe('MGtest');
    expect(params.from).toBeUndefined();
    expect(r).toMatchObject({ sid: 'SM_ms', status: 'accepted' });
  });
  test('falls back to the dedicated sender number when no Messaging Service is set', async () => {
    delete process.env.TWILIO_MESSAGING_SERVICE_SID;      // config is read at call time
    process.env.TWILIO_FROM_NUMBER = '+17312243669';
    await sms.sendSMS({ to: OWNER, message: 'hi' });
    const params = mockCreate.mock.calls[0][0];
    expect(params.from).toBe('+17312243669');
    expect(params.messagingServiceSid).toBeUndefined();
  });
  test('missing configuration throws safely (no send) and isConfigured reflects it', async () => {
    expect(sms.isConfigured()).toBe(true);                 // MS + creds present (beforeEach)
    delete process.env.TWILIO_MESSAGING_SERVICE_SID; delete process.env.TWILIO_FROM_NUMBER;
    expect(sms.isConfigured()).toBe(false);                // no sender now
    await expect(sms.sendSMS({ to: OWNER, message: 'x' })).rejects.toThrow(/not configured/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── Durable idempotency ──────────────────────────────────────────────────────
describe('idempotency — one successful owner SMS per logical event', () => {
  test('auction submitted: duplicate events do NOT duplicate the SMS', async () => {
    const r1 = await svc.notifyOwnerAuctionSubmitted('auc-1');
    const r2 = await svc.notifyOwnerAuctionSubmitted('auc-1');   // retry / duplicate
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ sent: 1 });
    expect(r2).toMatchObject({ skipped: true, reason: 'already_sent' });
  });
  test('a genuinely distinct auction still alerts', async () => {
    await svc.notifyOwnerAuctionSubmitted('auc-1');
    await svc.notifyOwnerAuctionSubmitted('auc-2');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
  test('after a provider FAILURE the event may be retried (idempotency allows recovery)', async () => {
    mockCreate.mockRejectedValueOnce(new Error('twilio 500'));
    const r1 = await svc.notifyOwnerAuctionSubmitted('auc-9');   // fails
    expect(r1).toMatchObject({ sent: 0, failed: 1 });
    const r2 = await svc.notifyOwnerAuctionSubmitted('auc-9');   // retry succeeds
    expect(r2).toMatchObject({ sent: 1 });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

// ── Actionable content + direct destinations ─────────────────────────────────
describe('actionable alerts — context, seller email, direct URL', () => {
  test('auction alert: title, seller email, and a DIRECT ?auctionId= destination', async () => {
    await svc.notifyOwnerAuctionSubmitted('auc-1');
    const body = mockCreate.mock.calls[0][0].body;
    expect(body).toContain('Auction submitted for review');
    expect(body).toContain('Maplewood Estate');
    expect(body).toContain('Email: seller@example.com');
    expect(body).toContain('https://bid.advantage.bid/admin/moderation.html?auctionId=auc-1');
  });
  test('estate sale alert: company/title, seller email, and per-event detail destination', async () => {
    await svc.notifyOwnerEstateSaleSubmitted('ev-9');
    const body = mockCreate.mock.calls[0][0].body;
    expect(body).toContain('Estate sale submitted for review');
    expect(body).toContain('Email: host@example.com');
    expect(body).toContain('https://bid.advantage.bid/admin/event-detail.html?id=ev-9');
  });
});

// ── Marketing package: authoritative identity, $499 supported ─────────────────
describe('marketing package alert — authoritative package, $499 supported', () => {
  test('reads the authoritative purchase record ($39 estate sale promotion)', async () => {
    store.ctx.purchase = { user_id: 'u-1', product_type: 'estate_sale_promotion', amount_cents: 3900, event_id: null };
    await svc.notifyOwnerMarketingPackagePurchased({ purchaseId: 'pur-1' });
    const body = mockCreate.mock.calls[0][0].body;
    expect(body).toContain('Marketing package purchased');
    expect(body).toContain('Estate Sale Promotion ($39)');
    expect(body).toContain('Email: buyer@example.com');
  });
  test('supports a $499 package (amount read authoritatively, never price-inferred)', async () => {
    store.ctx.purchase = { user_id: 'u-1', product_type: 'premium_marketing', amount_cents: 49900, event_id: null };
    await svc.notifyOwnerMarketingPackagePurchased({ purchaseId: 'pur-499' });
    const body = mockCreate.mock.calls[0][0].body;
    expect(body).toContain('Premium Marketing ($499)');
  });
  test('duplicate webhook for the same purchase does not duplicate the SMS', async () => {
    store.ctx.purchase = { user_id: 'u-1', product_type: 'estate_sale_promotion', amount_cents: 3900, event_id: null };
    await svc.notifyOwnerMarketingPackagePurchased({ purchaseId: 'pur-1' });
    await svc.notifyOwnerMarketingPackagePurchased({ purchaseId: 'pur-1' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
  test('packageLabel is authoritative, price appended for context, any tier supported', () => {
    expect(svc.packageLabel('estate_sale_promotion', 3900)).toBe('Estate Sale Promotion ($39)');
    expect(svc.packageLabel('premium_marketing', 49900)).toBe('Premium Marketing ($499)');
    expect(svc.packageLabel('featured_placement', 9900)).toBe('Featured Placement ($99)');
    expect(svc.packageLabel(null, null)).toBe('Marketing package');
  });
});

// ── Failure isolation ────────────────────────────────────────────────────────
describe('failure isolation', () => {
  test('a Twilio failure never throws out of the notify function', async () => {
    mockCreate.mockRejectedValueOnce(new Error('twilio down'));
    await expect(svc.notifyOwnerAuctionSubmitted('auc-x')).resolves.toBeTruthy();
  });
  test('a dedup-log outage falls back to a best-effort direct send (still delivers)', async () => {
    // Fail ONLY the owner_alert_log INSERT (not the context lookup) → service uses the direct-send fallback.
    db.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO owner_alert_log/.test(String(sql))) throw new Error('db down');
      return route(sql, params);
    });
    const r = await svc.notifyOwnerAuctionSubmitted('auc-1');
    expect(r).toMatchObject({ sent: 1 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
