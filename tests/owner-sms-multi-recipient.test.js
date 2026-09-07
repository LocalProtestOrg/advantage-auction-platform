'use strict';

/**
 * Owner Operational SMS — MULTI-RECIPIENT support (OWNER_ALERT_PHONE_E164S).
 * Covers: parse/validate/dedupe of the comma list, precedence + backward-compat fallback, independent
 * delivery to every recipient, PER-RECIPIENT idempotency (one recipient never suppresses another),
 * one-recipient failure does not block another, duplicate-event dedup, and no full-number logging.
 */

const mockCreate = jest.fn(async (params) => ({ sid: 'SM_' + String(params.to).slice(-4), status: 'accepted' }));
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: mockCreate } })));

const store = { log: new Map(), ctx: {} };
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');

function route(sql, params) {
  const s = String(sql);
  if (/INSERT INTO owner_alert_log/.test(s)) {
    const dedup = params[4];
    if (store.log.has(dedup)) return { rows: [] };
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
  if (/UPDATE owner_alert_log SET status='pending'/.test(s)) { setStatus(params[0], 'pending'); return { rows: [] }; }
  if (/FROM auctions a/.test(s)) return { rows: [store.ctx.auction] };
  return { rows: [] };
}
function setStatus(id, status) { for (const r of store.log.values()) if (r.id === id) r.status = status; }

const A = '+15551110001';   // Owner
const B = '+15551110002';   // Joey
let svc;
beforeEach(() => {
  store.log.clear();
  store.ctx = { auction: { title: 'Maplewood Estate', seller_name: 'Heritage & Home', seller_email: 'seller@example.com' } };
  mockCreate.mockClear();
  mockCreate.mockImplementation(async (params) => ({ sid: 'SM_' + String(params.to).slice(-4), status: 'accepted' }));
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => route(sql, params));
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGtest';
  delete process.env.TWILIO_FROM_NUMBER;
  process.env.OWNER_ALERT_PHONE_E164 = A;
  process.env.OWNER_ALERT_PHONE_E164S = `${A},${B}`;
  jest.isolateModules(() => { svc = require('../src/services/ownerAlertService'); });
});

// ── Parsing / precedence / backward compatibility ────────────────────────────
describe('recipient parsing + precedence', () => {
  test('parseRecipients trims, validates, and dedupes; drops malformed entries', () => {
    expect(svc.parseRecipients(` ${A} , ${B} , ${A} , not-a-number, +1 `)).toEqual([A, B]);
    expect(svc.parseRecipients('')).toEqual([]);
    expect(svc.parseRecipients(null)).toEqual([]);
  });
  test('OWNER_ALERT_PHONE_E164S (multi) is used when present', () => {
    expect(svc.recipientsFor(svc.ALERT_TYPES.AUCTION_SUBMITTED)).toEqual([A, B]);
  });
  test('falls back to OWNER_ALERT_PHONE_E164 when the multi var is absent (backward compatible)', () => {
    delete process.env.OWNER_ALERT_PHONE_E164S;
    expect(svc.recipientsFor(svc.ALERT_TYPES.AUCTION_SUBMITTED)).toEqual([A]);
  });
  test('a malformed multi var falls back to the single var (never sends nowhere unexpectedly)', () => {
    process.env.OWNER_ALERT_PHONE_E164S = 'garbage,also-bad';
    expect(svc.recipientsFor(svc.ALERT_TYPES.AUCTION_SUBMITTED)).toEqual([A]);
  });
  test('recipientHash is stable per number and differs across numbers; masking hides all but last 4', () => {
    expect(svc.recipientHash(A)).toBe(svc.recipientHash(A));
    expect(svc.recipientHash(A)).not.toBe(svc.recipientHash(B));
    expect(svc.maskRecipient(A)).toBe('…0001');
    expect(svc.maskRecipient(A)).not.toContain('555');
  });
});

// ── Independent multi-recipient delivery ─────────────────────────────────────
describe('multi-recipient delivery', () => {
  test('one event delivers independently to EVERY recipient (2 sends, 2 audit rows)', async () => {
    const r = await svc.notifyOwnerAuctionSubmitted('auc-1');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const tos = mockCreate.mock.calls.map((c) => c[0].to).sort();
    expect(tos).toEqual([A, B].sort());
    expect(r).toMatchObject({ attempted: 2, sent: 2, failed: 0 });
    expect(store.log.size).toBe(2); // one row per recipient
  });
  test('per-recipient dedup: an already-sent recipient does NOT suppress the other', async () => {
    // Pre-seed recipient A as already sent for this event.
    store.log.set(`auction_submitted:auc-1:${svc.recipientHash(A)}`, { id: 'pre', status: 'sent' });
    const r = await svc.notifyOwnerAuctionSubmitted('auc-1');
    // Only B is sent now; A is skipped.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].to).toBe(B);
    expect(r).toMatchObject({ sent: 1 });
  });
  test('a failure to one recipient never prevents the other; failed recipient is retryable', async () => {
    mockCreate.mockImplementation(async (params) => {
      if (params.to === B) throw new Error('twilio rejected B');
      return { sid: 'SM_ok', status: 'accepted' };
    });
    const r1 = await svc.notifyOwnerAuctionSubmitted('auc-2');
    expect(r1).toMatchObject({ attempted: 2, sent: 1, failed: 1 }); // A sent, B failed
    // B's row is 'failed' (retryable); A's row is 'sent'.
    const aRow = store.log.get(`auction_submitted:auc-2:${svc.recipientHash(A)}`);
    const bRow = store.log.get(`auction_submitted:auc-2:${svc.recipientHash(B)}`);
    expect(aRow.status).toBe('sent');
    expect(bRow.status).toBe('failed');
    // Retry: B now succeeds, A is already-sent (skipped) → only B re-sent.
    mockCreate.mockImplementation(async (params) => ({ sid: 'SM_ok2', status: 'accepted' }));
    mockCreate.mockClear();
    const r2 = await svc.notifyOwnerAuctionSubmitted('auc-2');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].to).toBe(B);
    expect(r2).toMatchObject({ sent: 1 });
  });
  test('a fully duplicate event delivers to nobody again (all recipients already sent)', async () => {
    await svc.notifyOwnerAuctionSubmitted('auc-3');
    mockCreate.mockClear();
    const r = await svc.notifyOwnerAuctionSubmitted('auc-3');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skipped: true, reason: 'already_sent' });
  });
  test('result never leaks a full phone number', async () => {
    const r = await svc.notifyOwnerAuctionSubmitted('auc-4');
    const json = JSON.stringify(r);
    expect(json).not.toContain(A);
    expect(json).not.toContain(B);
  });
});

// ── Source-level: masked logging, no full numbers ────────────────────────────
describe('no full-number logging', () => {
  const fs = require('fs'); const path = require('path');
  test('smsService masks the recipient in its log line', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'smsService.js'), 'utf8');
    expect(src).toMatch(/masked/);
    expect(src).not.toMatch(/Sent to \$\{to\}/); // the old full-number log is gone
  });
  test('ownerAlertService logs masked recipients only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ownerAlertService.js'), 'utf8');
    expect(src).toMatch(/maskRecipient\(to\)/);
  });
});
